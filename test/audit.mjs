/**
 * Tests for the audit trail.
 *
 * The load-bearing claim being defended is the one that is easiest to get
 * silently wrong:
 *
 *   Decorating registerTool logs the call without changing it. Every tool still
 *   registers, still receives its parsed arguments, and still returns exactly
 *   what it returned before -- and the row written describes that same call.
 *
 * A wrapper that misread the handler signature would log the MCP `extra` object
 * as the arguments and nobody would notice until the day the log was needed. So
 * this drives a real McpServer through a real client over the SDK's in-memory
 * transport, and writes to real SQLite rather than a mock -- a mock would accept
 * an INSERT whose columns had drifted from the schema, which is exactly the
 * mistake that matters here.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { fakeD1, tables } from "./d1.mjs";
import { Auditor, auditToolCalls, isMutating, sweepAuditLog } from "../dist/lib/audit.js";
import { DEFAULT_SETTINGS } from "../dist/lib/settings.js";

let pass = 0;
let fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  <- ${extra}`); }
};

// A skipped write never creates the schema -- ensureSchema runs only once
// something is genuinely being stored -- so "no table" and "no rows" are the
// same answer to these.
const calls = (db) => (tables(db).includes("tool_calls") ? db.query("SELECT * FROM tool_calls ORDER BY id") : []);
const events = (db) => (tables(db).includes("auth_events") ? db.query("SELECT * FROM auth_events ORDER BY id") : []);

function makeAuditor(db, settings = DEFAULT_SETTINGS, sudo = false, actor = {}) {
  const pending = [];
  const audit = new Auditor(
    db,
    { waitUntil: (p) => pending.push(p) },
    {
      requestId: "req-1",
      actorNonce: "NONCE123",
      actorIssued: 1_700_000_000_000,
      ip: "203.0.113.7",
      country: "NO",
      userAgent: "claude-test/1.0",
      ...actor,
    },
    async () => settings,
    // A thunk, matching how index.ts defers resolving the KV override layer.
    typeof sudo === "function" ? sudo : () => sudo,
  );
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 0));
    await Promise.all(pending);
  };
  return { audit, settle };
}

async function buildHarness(settings = DEFAULT_SETTINGS, sudo = false) {
  const db = fakeD1();
  const { audit, settle } = makeAuditor(db, settings, sudo);

  const server = new McpServer({ name: "test", version: "0.0.0" });
  auditToolCalls(server, audit);

  server.registerTool(
    "start_guest",
    { description: "mutating", inputSchema: { vmid: z.number(), node: z.string().optional() } },
    async ({ vmid }) => ({
      content: [{ type: "text", text: JSON.stringify({ started: vmid, upid: "UPID:pve:000A:root@pam:" }) }],
    }),
  );
  server.registerTool(
    "list_guests",
    { description: "read only", inputSchema: { status: z.string().optional() } },
    async () => ({ content: [{ type: "text", text: "[]" }] }),
  );
  server.registerTool(
    "pve_api",
    { description: "conditional", inputSchema: { method: z.string(), path: z.string(), params: z.record(z.string(), z.string()).optional() } },
    async () => ({ content: [{ type: "text", text: "ok" }] }),
  );
  server.registerTool(
    "run_script",
    { description: "shell", inputSchema: { target: z.string(), script: z.string() } },
    async () => ({ content: [{ type: "text", text: "done" }] }),
  );
  server.registerTool(
    "broken",
    { description: "throws", inputSchema: { vmid: z.number() } },
    async () => { throw new Error("bridge unreachable"); },
  );
  server.registerTool(
    "refuses",
    { description: "returns isError", inputSchema: { vmid: z.number() } },
    async () => ({ isError: true, content: [{ type: "text", text: "Refused to run this script" }] }),
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return { client, db, audit, settle };
}

// --- The decorator must not disturb the tools --------------------------------

console.log("\n== registerTool decoration is transparent ==");
{
  const { client, db, settle } = await buildHarness();

  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  ok("every tool still registers",
    JSON.stringify(names) === JSON.stringify(["broken", "list_guests", "pve_api", "refuses", "run_script", "start_guest"]),
    JSON.stringify(names));

  const result = await client.callTool({ name: "start_guest", arguments: { vmid: 101 } });
  ok("the tool's own result is returned unchanged", result.content[0].text.includes('"started":101'));

  await settle();
  ok("the schema was created on demand", tables(db).includes("tool_calls"));
  ok("one row was written", calls(db).length === 1);

  const row = calls(db)[0];
  ok("the parsed arguments are logged, not the MCP extra object", row.args_json === '{"vmid":101}', row.args_json);
  ok("tool name recorded", row.tool === "start_guest");
  ok("mutation flagged", row.mutating === 1);
  ok("target derived from vmid", row.target === "vmid:101");
  ok("status ok", row.status === "ok");
  ok("actor carried through", row.actor_nonce === "NONCE123" && row.ip === "203.0.113.7");
  ok("request id carried through", row.request_id === "req-1");
  ok("duration recorded", typeof row.duration_ms === "number" && row.duration_ms >= 0);
  ok("UPID extracted from the result", row.upid === "UPID:pve:000A:root@pam:");
  ok("sudo defaults to 0", row.sudo === 0);
}

// --- Failures are logged as failures -----------------------------------------

console.log("\n== both kinds of failure are recorded ==");
{
  const { client, db, settle } = await buildHarness();
  await client.callTool({ name: "broken", arguments: { vmid: 7 } }).catch(() => {});
  await client.callTool({ name: "refuses", arguments: { vmid: 8 } });
  await settle();

  const [thrown, refused] = calls(db);
  ok("a thrown error is status=error", thrown.status === "error");
  ok("the thrown message is kept", String(thrown.error).includes("bridge unreachable"));
  ok("an isError result is status=error", refused.status === "error");
  ok("the refusal text lands in error, not result", String(refused.error).includes("Refused"));
  ok("no result_json is stored for failures", refused.result_json === null);
  ok("no UPID is invented for a failure", thrown.upid === null && refused.upid === null);
}

// --- pve_api is only a mutation on a non-GET method ---------------------------

console.log("\n== mutation is decided per call for pve_api ==");
ok("GET is a read", isMutating("pve_api", { method: "GET" }) === false);
ok("lowercase get is a read", isMutating("pve_api", { method: "get" }) === false);
ok("POST is a mutation", isMutating("pve_api", { method: "POST" }) === true);
ok("PUT is a mutation", isMutating("pve_api", { method: "PUT" }) === true);
ok("list_guests is never a mutation", isMutating("list_guests", {}) === false);
ok("run_script always is", isMutating("run_script", { target: "host" }) === true);

{
  const { client, db, settle } = await buildHarness();
  await client.callTool({ name: "pve_api", arguments: { method: "POST", path: "/nodes/pve/storage" } });
  await settle();
  ok("pve_api target names the method and path", calls(db)[0].target === "POST /nodes/pve/storage");
}

// --- The sudo flag ------------------------------------------------------------

console.log("\n== sudo is recorded only for root-on-the-host ==");
{
  const { client, db, settle } = await buildHarness(DEFAULT_SETTINGS, true);
  await client.callTool({ name: "run_script", arguments: { target: "host", script: "id" } });
  await client.callTool({ name: "run_script", arguments: { target: "lxc:104", script: "id" } });
  await client.callTool({ name: "run_script", arguments: { target: "vm:200", script: "id" } });
  await client.callTool({ name: "start_guest", arguments: { vmid: 1 } });
  await settle();

  const [host, lxc, vm, other] = calls(db);
  ok("a host script with sudo enabled is sudo=1", host.sudo === 1);
  ok("a container target is not sudo", lxc.sudo === 0);
  ok("a VM target is not sudo", vm.sudo === 0);
  ok("an unrelated tool is not sudo", other.sudo === 0);
  ok("the target is still recorded", host.target === "host" && lxc.target === "lxc:104");
}
{
  const { client, db, settle } = await buildHarness(DEFAULT_SETTINGS, false);
  await client.callTool({ name: "run_script", arguments: { target: "host", script: "id" } });
  await settle();
  ok("with the kill switch off, a host script is not sudo", calls(db)[0].sudo === 0);
}
{
  // The real thunk is async, because resolving it reads the KV override layer.
  const { client, db, settle } = await buildHarness(DEFAULT_SETTINGS, async () => true);
  await client.callTool({ name: "run_script", arguments: { target: "host", script: "id" } });
  await settle();
  ok("an async sudo lookup is awaited, not coerced", calls(db)[0].sudo === 1);
}
{
  // The flag must reflect the switch as it was, not as it is now.
  const db = fakeD1();
  const { audit, settle } = makeAuditor(db, DEFAULT_SETTINGS, true);
  audit.rejectedToolCall("run_script", { target: "host", script: "x" }, "invalid arguments");
  await settle();
  ok("a rejected host script is still flagged sudo", calls(db)[0].sudo === 1);
}

// --- Secrets never reach the database ----------------------------------------

console.log("\n== secret-looking arguments are redacted ==");
{
  const { client, db, settle } = await buildHarness();
  await client.callTool({
    name: "pve_api",
    arguments: { method: "POST", path: "/access/users", params: { userid: "bob@pve", password: "hunter2", comment: "keep me" } },
  });
  await settle();

  const args = calls(db)[0].args_json;
  ok("the password value is gone", !args.includes("hunter2"));
  ok("it is visibly redacted rather than dropped", args.includes("[redacted]"));
  ok("non-secret siblings survive", args.includes("keep me") && args.includes("bob@pve"));
}

// --- Read logging can be switched off, mutations cannot ----------------------

console.log("\n== audit_log_reads / audit_enabled ==");
{
  const { client, db, settle } = await buildHarness({ ...DEFAULT_SETTINGS, audit_log_reads: false });
  await client.callTool({ name: "list_guests", arguments: {} });
  await settle();
  ok("a read is skipped when read logging is off", calls(db).length === 0);
  ok("and no schema is built for a write that never happens", !tables(db).includes("tool_calls"));

  await client.callTool({ name: "start_guest", arguments: { vmid: 5 } });
  await settle();
  ok("a mutation is logged anyway", calls(db).length === 1);
}
{
  const { client, db, settle } = await buildHarness({ ...DEFAULT_SETTINGS, audit_enabled: false });
  await client.callTool({ name: "start_guest", arguments: { vmid: 5 } });
  await settle();
  ok("audit_enabled=false silences everything", calls(db).length === 0);
}

// --- Field capping ------------------------------------------------------------

console.log("\n== oversized fields are capped, with the true size kept ==");
{
  const db = fakeD1();
  const { audit, settle } = makeAuditor(db, { ...DEFAULT_SETTINGS, audit_max_field_chars: 600 });

  const huge = "x".repeat(50_000);
  audit.toolCall({
    tool: "run_script",
    args: { target: "host", script: "echo hi" },
    result: { content: [{ type: "text", text: huge }] },
    durationMs: 12,
  });
  await settle();

  const row = calls(db)[0];
  ok("stored result honours the cap", row.result_json.length <= 600, `${row.result_json.length}`);
  ok("the true length is preserved", row.result_bytes === 50_000);
  ok("the cut is announced", row.result_json.includes("characters omitted"));
  ok("both ends are kept", row.result_json.startsWith("x") && row.result_json.endsWith("x"));
  ok("run_script target is recorded", row.target === "host");
  ok("the script itself is not redacted", row.args_json.includes("echo hi"));
}

// --- Auth events ---------------------------------------------------------------

console.log("\n== auth events ==");
{
  const db = fakeD1();
  const { audit, settle } = makeAuditor(db, DEFAULT_SETTINGS, false, { ip: "198.51.100.4" });
  audit.authEvent("token_issued", { clientId: "claude", tokenNonce: "ABC", detail: "30 day lifetime" });
  await settle();

  const row = events(db)[0];
  ok("event name recorded", row.event === "token_issued");
  ok("ip recorded", row.ip === "198.51.100.4");
  ok("client id recorded", row.client_id === "claude");
  ok("token nonce recorded, so actors can be traced back", row.token_nonce === "ABC");
  ok("no tool_calls row is written for an auth event", calls(db).length === 0);
}

// --- Logging must never break the call ----------------------------------------

console.log("\n== a failing audit write cannot fail the tool ==");
{
  const exploding = {
    prepare() { return { bind: () => exploding.prepare(), run: async () => { throw new Error("D1 is down"); }, all: async () => { throw new Error("D1 is down"); } }; },
    batch: async () => { throw new Error("D1 is down"); },
  };
  const pending = [];
  const audit = new Auditor(exploding, { waitUntil: (p) => pending.push(p) }, { requestId: "r" }, async () => DEFAULT_SETTINGS);

  const server = new McpServer({ name: "t", version: "0" });
  auditToolCalls(server, audit);
  server.registerTool("start_guest", { description: "d", inputSchema: { vmid: z.number() } }, async () => ({
    content: [{ type: "text", text: "done" }],
  }));

  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await Promise.all([client.connect(ct), server.connect(st)]);

  const result = await client.callTool({ name: "start_guest", arguments: { vmid: 1 } });
  ok("the tool still succeeds", result.content[0].text === "done" && !result.isError);
  let threw = false;
  await Promise.all(pending).catch(() => (threw = true));
  ok("the write's rejection is swallowed, not left unhandled", threw === false);
}

// --- Calls that never reach a handler -----------------------------------------

console.log("\n== rejected calls are still recorded ==");
{
  const db = fakeD1();
  const { audit, settle } = makeAuditor(db);
  audit.rejectedToolCall("run_script", { target: "vm:9; rm -rf /", script: "x" }, "invalid arguments");
  await settle();

  const row = calls(db)[0];
  ok("status is rejected, distinct from error", row.status === "rejected");
  ok("the raw arguments are kept", row.args_json.includes("rm -rf /"));
  ok("still classified as a mutation", row.mutating === 1);
  ok("the reason is recorded", String(row.error).includes("invalid arguments"));
  ok("no result is invented", row.result_json === null && row.upid === null);
}
{
  // Arguments need not be an object -- a hostile client can send anything.
  const db = fakeD1();
  const { audit, settle } = makeAuditor(db);
  audit.rejectedToolCall("start_guest", "not-an-object", "invalid arguments");
  await settle();
  ok("non-object arguments do not throw", calls(db).length === 1);
  ok("they are wrapped rather than dropped", calls(db)[0].args_json.includes("not-an-object"));
}
{
  // index.ts reconciles what the request asked for against this list, so it has
  // to name every handler that ran -- including one that failed.
  const { client, audit, settle } = await buildHarness();
  await client.callTool({ name: "start_guest", arguments: { vmid: 3 } });
  await client.callTool({ name: "broken", arguments: { vmid: 4 } }).catch(() => {});
  await settle();
  ok("handled tools are tracked for reconciliation",
    JSON.stringify(audit.handled) === JSON.stringify(["start_guest", "broken"]), JSON.stringify(audit.handled));
  ok("a tool that was never called is absent", !audit.handled.includes("list_guests"));
}

// --- Retention -----------------------------------------------------------------

console.log("\n== retention sweep ==");
{
  const db = fakeD1();
  const { audit, settle } = makeAuditor(db);
  audit.toolCall({ tool: "start_guest", args: { vmid: 1 }, result: { content: [] }, durationMs: 1 });
  await settle();

  const old = Date.now() - 400 * 86_400_000;
  const recent = Date.now() - 10 * 86_400_000;
  for (const ts of [old, old + 1000, recent]) {
    db.raw.prepare("INSERT INTO tool_calls (ts, request_id, tool, mutating, sudo, status) VALUES (?, 'x', 'stop_guest', 1, 0, 'ok')").run(ts);
  }
  db.raw.prepare("INSERT INTO auth_events (ts, event) VALUES (?, 'authorize_ok')").run(old);
  db.raw.prepare("INSERT INTO auth_events (ts, event) VALUES (?, 'authorize_ok')").run(recent);

  const before = calls(db).length;
  const result = await sweepAuditLog(db, { ...DEFAULT_SETTINGS, audit_retention_days: 365 });

  ok("cutoff is retention_days ago", Math.abs(result.cutoff - (Date.now() - 365 * 86_400_000)) < 5_000);
  ok("exactly the expired tool calls go", result.tool_calls === 2 && calls(db).length === before - 2);
  ok("exactly the expired auth events go", result.auth_events === 1 && events(db).length === 1);
  ok("recent rows survive", calls(db).every((c) => c.ts > result.cutoff));
  ok("not flagged incomplete", result.incomplete === false);

  const second = await sweepAuditLog(db, { ...DEFAULT_SETTINGS, audit_retention_days: 365 });
  ok("a second sweep finds nothing", second.tool_calls === 0 && second.auth_events === 0);
}

console.log(`\n${"=".repeat(46)}\n  ${pass} passed, ${fail} failed\n${"=".repeat(46)}`);
process.exit(fail ? 1 : 0);
