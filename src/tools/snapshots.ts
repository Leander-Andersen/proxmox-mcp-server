import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PveClient } from "../lib/pve.js";
import { run } from "../lib/result.js";
import { guestTarget } from "./guests.js";

const snapname = z
  .string()
  .regex(
    /^[A-Za-z][A-Za-z0-9_-]*$/,
    "Snapshot names must start with a letter and contain only letters, digits, hyphens and underscores.",
  )
  .describe("Snapshot name.");

export function registerSnapshotTools(server: McpServer, pve: PveClient): void {
  server.registerTool(
    "list_snapshots",
    {
      title: "List snapshots",
      description:
        "List snapshots of a VM or container. The pseudo-snapshot 'current' represents the running state.",
      inputSchema: guestTarget,
    },
    async ({ vmid, node, type }) =>
      run(async () => {
        const t = await pve.resolveGuest(vmid, node, type);
        return pve.fetch("GET", `/nodes/${t.node}/${t.type}/${vmid}/snapshot`);
      }),
  );

  server.registerTool(
    "snapshot_guest",
    {
      title: "Create snapshot",
      description:
        "Take a snapshot of a VM or container so it can be rolled back later. Returns a task UPID.",
      inputSchema: {
        ...guestTarget,
        snapname,
        description: z.string().optional().describe("Optional note stored with the snapshot."),
        vmstate: z
          .boolean()
          .optional()
          .describe("QEMU only: also save RAM so the rollback resumes mid-run. Default false."),
      },
    },
    async ({ vmid, node, type, snapname: name, description, vmstate }) =>
      run(async () => {
        const t = await pve.resolveGuest(vmid, node, type);
        const upid = await pve.fetch("POST", `/nodes/${t.node}/${t.type}/${vmid}/snapshot`, {
          snapname: name,
          description,
          // vmstate is rejected outright on LXC, so only send it for QEMU.
          vmstate: t.type === "qemu" ? vmstate : undefined,
        });
        return { snapshotted: vmid, node: t.node, type: t.type, snapname: name, upid };
      }),
  );

  server.registerTool(
    "rollback_snapshot",
    {
      title: "Roll back to snapshot",
      description:
        "Revert a VM or container to a previous snapshot. Everything written since that snapshot is " +
        "discarded and the guest is stopped or reset in the process. Returns a task UPID.",
      inputSchema: { ...guestTarget, snapname },
    },
    async ({ vmid, node, type, snapname: name }) =>
      run(async () => {
        const t = await pve.resolveGuest(vmid, node, type);
        const upid = await pve.fetch(
          "POST",
          `/nodes/${t.node}/${t.type}/${vmid}/snapshot/${encodeURIComponent(name)}/rollback`,
        );
        return { rolledBack: vmid, node: t.node, type: t.type, snapname: name, upid };
      }),
  );
}
