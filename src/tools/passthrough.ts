import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PveClient } from "../lib/pve.js";
import { fail, run } from "../lib/result.js";

/**
 * Paths that must stay read-only. Editing users, tokens or ACLs through this
 * tool could hand out more access than the connector itself has; editing the
 * cluster config can break quorum.
 */
const READ_ONLY_PREFIXES = ["/access/", "/cluster/config/"];

export function registerPassthroughTool(server: McpServer, pve: PveClient): void {
  server.registerTool(
    "pve_api",
    {
      title: "Call the Proxmox API directly",
      description:
        "Escape hatch for any Proxmox API endpoint that has no dedicated tool -- storage, backups, " +
        "firewall, guest config, and so on. Paths are relative to /api2/json, e.g. '/nodes/pve/storage'. " +
        "See https://pve.proxmox.com/pve-docs/api-viewer/. Read-only calls are unrestricted; DELETE is " +
        "blocked entirely, and /access and /cluster/config are blocked for writes.",
      inputSchema: {
        method: z.enum(["GET", "POST", "PUT", "DELETE"]).describe("HTTP method."),
        path: z
          .string()
          .describe("API path relative to /api2/json, starting with a slash, e.g. '/nodes/pve/storage'."),
        params: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Query parameters for GET, or form fields for POST/PUT."),
      },
    },
    async ({ method, path, params }) => {
      // Tolerate a fully qualified path if the model supplies one.
      let normalized = path.replace(/^\/api2\/json/, "");
      if (!normalized.startsWith("/")) normalized = `/${normalized}`;

      if (method === "DELETE") {
        return fail(
          "DELETE is blocked through pve_api. Deleting guests, storage or users must be done in the " +
            "Proxmox web UI on purpose.",
        );
      }

      if (method !== "GET") {
        const blocked = READ_ONLY_PREFIXES.find((p) => normalized.startsWith(p));
        if (blocked) {
          return fail(
            `Writes to ${blocked}* are blocked through pve_api. This path is read-only for the connector.`,
          );
        }
        // Deliberate audit trail: every mutation is visible in `wrangler tail`.
        console.log(
          `pve_api mutation: ${method} ${normalized} params=${JSON.stringify(params ?? {})}`,
        );
      }

      return run(() => pve.fetch(method, normalized, params));
    },
  );
}
