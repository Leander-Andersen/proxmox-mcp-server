import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PveClient } from "../lib/pve.js";
import { fail, run } from "../lib/result.js";
import { project } from "../lib/project.js";

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
        "firewall, guest config, RRD metrics, and so on. Paths are relative to /api2/json, e.g. " +
        "'/nodes/pve/storage'. See https://pve.proxmox.com/pve-docs/api-viewer/. Read-only calls are " +
        "unrestricted; DELETE is blocked entirely, and /access and /cluster/config are blocked for " +
        "writes. Some endpoints return very large payloads -- use fields/omit_fields/limit to trim " +
        "them server-side rather than pulling everything into the conversation. For example, a week " +
        "of rrddata is ~330 points of ~20 metrics: ask for fields ['time','mem','maxmem'] instead.",
      inputSchema: {
        method: z.enum(["GET", "POST", "PUT", "DELETE"]).describe("HTTP method."),
        path: z
          .string()
          .describe(
            "API path relative to /api2/json, starting with a slash, e.g. '/nodes/pve/storage'. " +
              "A query string here is accepted and merged into params.",
          ),
        params: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe(
            "Query parameters for GET, or form fields for POST/PUT. Preferred over putting a " +
              "query string in the path.",
          ),
        fields: z
          .array(z.string())
          .optional()
          .describe("Keep only these keys in the response. Applied per row for array results."),
        omit_fields: z
          .array(z.string())
          .optional()
          .describe(
            "Drop these keys from the response. Useful for 'description', which guest configs " +
              "often fill with large HTML blobs.",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("For array results, keep only the last N entries (the most recent)."),
      },
    },
    async ({ method, path, params, fields, omit_fields, limit }) => {
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

      return run(async () => {
        const data = await pve.fetch(method, normalized, params);
        return project(data, { fields, omitFields: omit_fields, limit });
      });
    },
  );
}
