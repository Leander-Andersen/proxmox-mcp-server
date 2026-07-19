import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PveClient } from "../lib/pve.js";
import { run } from "../lib/result.js";

/** Shared shape: identify a guest, letting the Worker fill in node/type. */
export const guestTarget = {
  vmid: z.number().int().positive().describe("Numeric ID of the VM or container."),
  node: z
    .string()
    .optional()
    .describe("Node name. Optional -- resolved from the vmid when omitted."),
  type: z
    .enum(["qemu", "lxc"])
    .optional()
    .describe("Guest type. Optional -- resolved from the vmid when omitted."),
};

export function registerGuestTools(server: McpServer, pve: PveClient): void {
  server.registerTool(
    "list_guests",
    {
      title: "List guests",
      description:
        "List every VM and LXC container in the Proxmox cluster with its id, name, node, status and resource usage.",
      inputSchema: {},
    },
    async () =>
      run(async () => {
        const resources = await pve.clusterResources();
        return resources
          .sort((a, b) => a.vmid - b.vmid)
          .map((r) => ({
            vmid: r.vmid,
            name: r.name,
            type: r.type,
            status: r.status,
            node: r.node,
            template: r.template === 1 || undefined,
            cpu: r.cpu,
            maxcpu: r.maxcpu,
            mem: r.mem,
            maxmem: r.maxmem,
            uptime: r.uptime,
          }));
      }),
  );

  server.registerTool(
    "guest_status",
    {
      title: "Get guest status",
      description: "Current runtime status of one VM or container: state, uptime, cpu, memory, disk.",
      inputSchema: guestTarget,
    },
    async ({ vmid, node, type }) =>
      run(async () => {
        const t = await pve.resolveGuest(vmid, node, type);
        return pve.fetch("GET", `/nodes/${t.node}/${t.type}/${vmid}/status/current`);
      }),
  );

  server.registerTool(
    "start_guest",
    {
      title: "Start guest",
      description: "Start a stopped VM or container. Returns a task UPID -- poll it with task_status.",
      inputSchema: guestTarget,
    },
    async ({ vmid, node, type }) =>
      run(async () => {
        const t = await pve.resolveGuest(vmid, node, type);
        const upid = await pve.fetch("POST", `/nodes/${t.node}/${t.type}/${vmid}/status/start`);
        return { started: vmid, node: t.node, type: t.type, upid };
      }),
  );

  server.registerTool(
    "shutdown_guest",
    {
      title: "Shut down guest (graceful)",
      description:
        "Request a graceful ACPI/guest shutdown. Prefer this over stop_guest. Returns a task UPID.",
      inputSchema: {
        ...guestTarget,
        timeout: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Seconds to wait for the guest to shut down before the task fails. Default 60."),
      },
    },
    async ({ vmid, node, type, timeout }) =>
      run(async () => {
        const t = await pve.resolveGuest(vmid, node, type);
        const upid = await pve.fetch("POST", `/nodes/${t.node}/${t.type}/${vmid}/status/shutdown`, {
          timeout: timeout ?? 60,
        });
        return { shutdown: vmid, node: t.node, type: t.type, upid };
      }),
  );

  server.registerTool(
    "stop_guest",
    {
      title: "Stop guest (hard)",
      description:
        "Immediately cut power to a VM or container, like pulling the plug. Data loss is possible -- " +
        "use shutdown_guest unless the guest is unresponsive. Returns a task UPID.",
      inputSchema: guestTarget,
    },
    async ({ vmid, node, type }) =>
      run(async () => {
        const t = await pve.resolveGuest(vmid, node, type);
        const upid = await pve.fetch("POST", `/nodes/${t.node}/${t.type}/${vmid}/status/stop`);
        return { stopped: vmid, node: t.node, type: t.type, upid };
      }),
  );
}
