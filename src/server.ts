import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "./env.js";
import { PveClient } from "./lib/pve.js";
import { execConfigured } from "./lib/exec-client.js";
import { auditToolCalls, type Auditor } from "./lib/audit.js";
import { registerGuestTools } from "./tools/guests.js";
import { registerSnapshotTools } from "./tools/snapshots.js";
import { registerNodeTools } from "./tools/node.js";
import { registerPassthroughTool } from "./tools/passthrough.js";
import { registerExecTool } from "./tools/exec.js";
import { registerAuditTools, registerSettingsTools } from "./tools/audit.js";

export const SERVER_VERSION = "1.1.0";

/**
 * Built fresh for every request -- the Worker keeps no cross-request state, so
 * the PveClient's caches live and die with a single MCP call.
 */
export function buildServer(env: Env, audit?: Auditor): McpServer {
  const server = new McpServer(
    { name: "proxmox-mcp", version: SERVER_VERSION },
    {
      instructions:
        "Tools for managing a Proxmox VE host. `node` and `type` are optional on guest tools -- " +
        "they are resolved from the vmid automatically. Lifecycle and snapshot operations return a " +
        "task UPID; poll it with task_status to confirm the task actually succeeded. Every call " +
        "made here is recorded; audit_log answers what was done, when, and by which token.",
    },
  );

  // Before any registration, so that every tool below is wrapped -- including
  // ones added later, which is the whole reason this is a decorator and not a
  // line inside each handler.
  if (audit) auditToolCalls(server, audit);

  const pve = new PveClient(env);
  registerGuestTools(server, pve);
  registerSnapshotTools(server, pve);
  registerNodeTools(server, pve);
  registerPassthroughTool(server, pve);

  // Phase 2 only appears once the exec bridge has been deployed and configured.
  if (execConfigured(env)) registerExecTool(server, env);

  // Querying the log needs the database; changing settings only needs KV, so
  // the knobs stay reachable even on a deployment with no audit log at all.
  if (env.AUDIT_DB) registerAuditTools(server, env.AUDIT_DB);
  registerSettingsTools(server, env);

  return server;
}
