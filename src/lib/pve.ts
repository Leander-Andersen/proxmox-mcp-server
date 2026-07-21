import { z } from "zod";
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
 * A Proxmox node name, constrained to a DNS label.
 *
 * This is load-bearing, not cosmetic. `node` is interpolated into an API path,
 * and `new URL` resolves `..` segments and drops everything after a `#`, so an
 * unconstrained value lets a caller rewrite the path a tool thinks it is
 * building -- including the tail, by terminating it with `?`. Guest tools then
 * become arbitrary API calls. resolvePath below is the second half of the fix;
 * either alone would do, and both together mean a tool that forgets to validate
 * still cannot escape /api2/json.
 */
export const NODE_NAME = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

export function isValidNodeName(name: string): boolean {
  return NODE_NAME.test(name) && !name.includes("..") && name.length <= 253;
}

export function assertNodeName(name: string): void {
  if (!isValidNodeName(name)) {
    throw new Error(
      `"${name}" is not a valid Proxmox node name. Node names are DNS labels -- letters, digits, ` +
        `dots and hyphens only. Use list_nodes to see the real names.`,
    );
  }
}

/** Shared schema fragment so every tool constrains `node` the same way. */
export const nodeNameSchema = z
  .string()
  .refine(isValidNodeName, "Node names are DNS labels -- letters, digits, dots and hyphens only.");

export interface ResolvedPath {
  url: URL;
  /** The path as Proxmox will see it, relative to /api2/json. */
  apiPath: string;
}

/**
 * Resolves an API path against the base URL and refuses anything that escapes
 * /api2/json once the URL parser has had its say.
 *
 * A query string in `path` is still supported -- callers rely on it and it
 * cannot be used to traverse. A fragment is rejected outright: `fetch` never
 * transmits one, so accepting it would mean silently sending a different path
 * than the caller wrote.
 */
export function resolvePath(base: string, path: string): ResolvedPath {
  if (path.includes("#")) {
    throw new Error(
      "API paths may not contain '#'. A fragment is never sent to the server, so this would " +
        "silently request a different path than the one written.",
    );
  }

  const root = new URL(`${base.replace(/\/+$/, "")}/api2/json/`);
  const url = new URL(`${base.replace(/\/+$/, "")}/api2/json${path}`);

  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) {
    throw new Error(
      `Refusing to call "${path}": it resolves to ${url.pathname}, outside the Proxmox API root ` +
        `${root.pathname}. Paths may not use ".." to climb out.`,
    );
  }

  return { url, apiPath: url.pathname.slice(root.pathname.length - 1) };
}

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

  /** Resolves a path against this client's base, refusing anything that escapes. */
  resolve(path: string): ResolvedPath {
    return resolvePath(this.base, path);
  }

  async fetch(method: string, path: string, params?: PveParams): Promise<unknown> {
    const upper = method.toUpperCase();
    const { url } = this.resolve(path);

    const entries = Object.entries(params ?? {}).filter(([, v]) => v !== undefined);
    // PVE expects booleans as 1/0 rather than "true"/"false".
    const encoded = new URLSearchParams(
      entries.map(([k, v]) => [k, typeof v === "boolean" ? (v ? "1" : "0") : String(v)]),
    );

    // A query string written into `path` used to be silently destroyed when the
    // search string was overwritten below, which surfaced as Proxmox rejecting a
    // parameter the caller had obviously supplied. Merge instead, letting an
    // explicit `params` entry win on conflict.
    if (url.search) {
      for (const [k, v] of new URLSearchParams(url.search)) {
        if (!encoded.has(k)) encoded.append(k, v);
      }
    }

    const headers: Record<string, string> = {
      Authorization: `PVEAPIToken=${this.env.PVE_TOKEN}`,
      "CF-Access-Client-Id": this.env.CF_ACCESS_CLIENT_ID,
      "CF-Access-Client-Secret": this.env.CF_ACCESS_CLIENT_SECRET,
      Accept: "application/json",
    };

    let body: string | undefined;
    // Everything now lives in `encoded`, so clear whatever came in on the path
    // to avoid sending the same parameter twice on write methods.
    url.search = "";
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
    if (node !== undefined) assertNodeName(node);
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
    if (node !== undefined) assertNodeName(node);
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
