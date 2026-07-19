import type { Env } from "../env.js";

export type GuestType = "qemu" | "lxc";

export interface ClusterResource {
  vmid: number;
  name?: string;
  status?: string;
  node: string;
  type: GuestType;
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  uptime?: number;
  template?: number;
}

export type PveParams = Record<string, string | number | boolean | undefined>;

/**
 * Talks to the Proxmox REST API through the Cloudflare tunnel, adding both the
 * PVE API token and the CF Access service-token headers.
 *
 * Instantiated once per Worker request; caches the cluster resource and node
 * listings so that resolving `node`/`type` for several guests costs one call.
 */
export class PveClient {
  private readonly base: string;
  private resourcesCache?: Promise<ClusterResource[]>;
  private nodesCache?: Promise<Array<{ node: string; status?: string }>>;

  constructor(private readonly env: Env) {
    this.base = env.PVE_HOST.replace(/\/+$/, "");
  }

  async fetch(method: string, path: string, params?: PveParams): Promise<unknown> {
    const upper = method.toUpperCase();
    const url = new URL(`${this.base}/api2/json${path}`);

    const entries = Object.entries(params ?? {}).filter(([, v]) => v !== undefined);
    // PVE expects booleans as 1/0 rather than "true"/"false".
    const encoded = new URLSearchParams(
      entries.map(([k, v]) => [k, typeof v === "boolean" ? (v ? "1" : "0") : String(v)]),
    );

    const headers: Record<string, string> = {
      Authorization: `PVEAPIToken=${this.env.PVE_TOKEN}`,
      "CF-Access-Client-Id": this.env.CF_ACCESS_CLIENT_ID,
      "CF-Access-Client-Secret": this.env.CF_ACCESS_CLIENT_SECRET,
      Accept: "application/json",
    };

    let body: string | undefined;
    if (upper === "GET" || upper === "DELETE") {
      url.search = encoded.toString();
    } else if (encoded.toString()) {
      // The PVE API accepts form encoding on every version; JSON bodies do not
      // work consistently across releases.
      body = encoded.toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }

    let res: Response;
    try {
      res = await fetch(url.toString(), { method: upper, headers, body });
    } catch (e) {
      // The runtime redacts the underlying message, so say something useful.
      throw new Error(
        `Could not reach the Proxmox API at ${this.base} -- the request failed before any response ` +
          `came back. Check that PVE_HOST is correct and the Cloudflare tunnel is running. ` +
          `(${e instanceof Error ? e.message : String(e)})`,
      );
    }
    const text = await res.text();

    if (!res.ok) {
      throw new Error(`Proxmox API ${upper} ${path} failed (${res.status}): ${truncate(text, 800)}`);
    }
    if (!text.trim()) return null;

    try {
      return (JSON.parse(text) as { data: unknown }).data;
    } catch {
      throw new Error(
        `Proxmox API ${upper} ${path} returned non-JSON (${res.status}). ` +
          `This usually means CF Access rejected the request. Body: ${truncate(text, 300)}`,
      );
    }
  }

  /** All VMs and containers in the cluster. Cached for the life of the request. */
  clusterResources(): Promise<ClusterResource[]> {
    this.resourcesCache ??= this.fetch("GET", "/cluster/resources", { type: "vm" }).then(
      (d) => (d as ClusterResource[]) ?? [],
    );
    return this.resourcesCache;
  }

  nodes(): Promise<Array<{ node: string; status?: string }>> {
    this.nodesCache ??= this.fetch("GET", "/nodes").then(
      (d) => (d as Array<{ node: string; status?: string }>) ?? [],
    );
    return this.nodesCache;
  }

  /**
   * Fills in whichever of `node`/`type` the caller left out by looking the vmid
   * up in the cluster. Explicit values are always trusted and skip the lookup.
   */
  async resolveGuest(
    vmid: number,
    node?: string,
    type?: GuestType,
  ): Promise<{ node: string; type: GuestType }> {
    if (node && type) return { node, type };

    const match = (await this.clusterResources()).find(
      (r) => r.vmid === vmid && (!node || r.node === node),
    );
    if (!match) {
      const where = node ? ` on node "${node}"` : "";
      throw new Error(
        `No VM or container with vmid ${vmid} found${where}. Use list_guests to see what exists.`,
      );
    }
    return { node: node ?? match.node, type: type ?? match.type };
  }

  /**
   * Resolves a node name for node-scoped tools. On a single-node install the
   * caller can omit it; on a real cluster it becomes required.
   */
  async resolveNode(node?: string): Promise<string> {
    if (node) return node;
    const nodes = await this.nodes();
    if (nodes.length === 1) return nodes[0].node;
    if (nodes.length === 0) throw new Error("The Proxmox API returned no nodes.");
    throw new Error(
      `This cluster has ${nodes.length} nodes (${nodes.map((n) => n.node).join(", ")}). ` +
        `Pass the "node" parameter to say which one you mean.`,
    );
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}
