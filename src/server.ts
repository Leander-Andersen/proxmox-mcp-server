import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "./env.js";
import { PveClient } from "./lib/pve.js";
import { execConfigured } from "./lib/exec-client.js";
import { registerGuestTools } from "./tools/guests.js";
import { registerSnapshotTools } from "./tools/snapshots.js";
import { registerNodeTools } from "./tools/node.js";
import { registerPassthroughTool } from "./tools/passthrough.js";
import { registerExecTool } from "./tools/exec.js";

export const SERVER_VERSION = "1.0.0";

/**
 * Built fresh for every request -- the Worker keeps no cross-request state, so
 * the PveClient's caches live and die with a single MCP call.
 */
export function buildServer(env: Env): McpServer {
  const server = new McpServer(
    { name: "proxmox-mcp", version: SERVER_VERSION },
    {
      instructions:
        "Tools for managing a Proxmox VE host. `node` and `type` are optional on guest tools -- " +
        "they are resolved from the vmid automatically. Lifecycle and snapshot operations return a " +
        "task UPID; poll it with task_status to confirm the task actually succeeded.",
    },
  );

  const pve = new PveClient(env);
  registerGuestTools(server, pve);
  registerSnapshotTools(server, pve);
  registerNodeTools(server, pve);
  registerPassthroughTool(server, pve);

  // Phase 2 only appears once the exec bridge has been deployed and configured.
  if (execConfigured(env)) registerExecTool(server, env);

  return server;
}
