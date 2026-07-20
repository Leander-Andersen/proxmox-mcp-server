import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PveClient } from "../lib/pve.js";
import { run } from "../lib/result.js";
import { project, projectionInput, toOptions } from "../lib/project.js";

const nodeParam = z
  .string()
  .optional()
  .describe("Node name. Optional on a single-node install; required on a cluster.");

/** A UPID looks like UPID:<node>:<pid>:<pstart>:<time>:<type>:<id>:<user>: */
function nodeFromUpid(upid: string): string | undefined {
  const parts = upid.split(":");
  return parts[0] === "UPID" && parts[1] ? parts[1] : undefined;
}

export function registerNodeTools(server: McpServer, pve: PveClient): void {
  server.registerTool(
    "list_nodes",
    {
      title: "List nodes",
      description: "List the Proxmox nodes in this cluster with their online status.",
      inputSchema: {},
    },
    async () => run(() => pve.nodes()),
  );

  server.registerTool(
    "node_status",
    {
      title: "Get node status",
      description:
        "Health of a Proxmox host itself: cpu, memory, swap, root filesystem, load average, uptime and kernel version.",
      inputSchema: { node: nodeParam, ...projectionInput },
    },
    async ({ node, fields, omit_fields }) =>
      run(async () => {
        const data = await pve.fetch("GET", `/nodes/${await pve.resolveNode(node)}/status`);
        return project(data, toOptions({ fields, omit_fields }));
      }),
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List recent tasks",
      description:
        "Recent task history for a node -- migrations, backups, starts, stops. Use this to see what has been happening.",
      inputSchema: {
        node: nodeParam,
        limit: z.number().int().positive().max(500).optional().describe("How many tasks. Default 20."),
        errors: z.boolean().optional().describe("Only return tasks that failed. Default false."),
        vmid: z.number().int().positive().optional().describe("Only tasks for this guest."),
        ...projectionInput,
      },
    },
    async ({ node, limit, errors, vmid, fields, omit_fields }) =>
      run(async () => {
        const data = await pve.fetch("GET", `/nodes/${await pve.resolveNode(node)}/tasks`, {
          limit: limit ?? 20,
          errors: errors ? 1 : undefined,
          vmid,
        });
        return project(data, toOptions({ fields, omit_fields }));
      }),
  );

  server.registerTool(
    "task_status",
    {
      title: "Get task status",
      description:
        "Check whether a task UPID returned by start_guest, snapshot_guest, etc. has finished, and read its output.",
      inputSchema: {
        upid: z.string().describe("Task UPID, e.g. UPID:pve:001A2B3C:...:qmstart:100:root@pam:"),
        node: nodeParam,
        log: z
          .boolean()
          .optional()
          .describe(
            "Force including the task log. By default it is fetched only when the task failed, " +
              "since the log of a successful start is noise. Set false to never fetch it.",
          ),
        log_limit: z.number().int().positive().max(500).optional().describe("Log lines. Default 100."),
      },
    },
    async ({ upid, node, log, log_limit }) =>
      run(async () => {
        // The node name is embedded in the UPID, so it rarely needs resolving.
        const n = node ?? nodeFromUpid(upid) ?? (await pve.resolveNode());
        const encoded = encodeURIComponent(upid);
        const status = (await pve.fetch(
          "GET",
          `/nodes/${n}/tasks/${encoded}/status`,
        )) as Record<string, unknown>;

        // exitstatus is "OK" on success, absent while still running.
        const running = status.status === "running";
        const failed = typeof status.exitstatus === "string" && status.exitstatus !== "OK";
        const wantLog = log ?? (failed || running);
        if (!wantLog) return status;

        const lines = (await pve
          .fetch("GET", `/nodes/${n}/tasks/${encoded}/log`, { limit: log_limit ?? 100 })
          .catch(() => null)) as Array<{ n: number; t: string }> | null;

        return { ...status, log: lines?.map((l) => l.t) ?? [] };
      }),
  );
}
