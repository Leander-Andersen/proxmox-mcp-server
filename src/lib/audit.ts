/**
 * The audit trail: who did what, when, and what came back.
 *
 * Three properties are worth stating up front, because they are what the design
 * is actually for:
 *
 *   1. Logging never changes the outcome of the thing being logged. Every write
 *      is fire-and-forget through waitUntil, and a failure is a console.error,
 *      not a failed stop_guest. An audit log that can take the server down is a
 *      liability dressed as a control.
 *   2. Nothing is logged that is itself a credential. The bearer token's
 *      signature is dropped and only its nonce is kept; argument keys that look
 *      like secrets are redacted before they reach the database.
 *   3. It is a single choke point. Tool handlers are decorated at registration
 *      rather than edited one by one, so a tool added next year is logged
 *      without anyone remembering to log it.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Settings } from "./settings.js";
import { ensureSchemaOnce } from "./migrate.js";

// --- Actor identification ----------------------------------------------------

export interface ActorContext {
  requestId: string;
  actorNonce?: string;
  actorIssued?: number;
  clientId?: string;
  ip?: string;
  country?: string;
  userAgent?: string;
}

/**
 * Splits an access token into the parts that are safe to keep.
 *
 * A token is `issuedAt.nonce.hmac`. The nonce identifies one authorization for
 * up to 30 days, which is as close to an identity as this server has; the HMAC
 * is what makes the token work and must never be written down. Storing the
 * whole token would turn the audit database into a pile of working credentials.
 */
export function actorFromToken(token: string): { nonce?: string; issued?: number } {
  const parts = token.split(".");
  if (parts.length !== 3) return {};
  const issued = parseInt(parts[0], 10);
  return { nonce: parts[1], issued: Number.isFinite(issued) ? issued : undefined };
}

export function actorFromRequest(request: Request, requestId: string): ActorContext {
  const auth = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  const { nonce, issued } = token ? actorFromToken(token) : {};

  return {
    requestId,
    actorNonce: nonce,
    actorIssued: issued,
    ip: request.headers.get("CF-Connecting-IP") ?? undefined,
    // Set by Cloudflare on the way in; cannot be spoofed by the client.
    country: (request as { cf?: { country?: string } }).cf?.country ?? undefined,
    userAgent: request.headers.get("User-Agent")?.slice(0, 300) ?? undefined,
  };
}

// --- Redaction and capping ---------------------------------------------------

/**
 * Argument keys whose values never belong in the log.
 *
 * This covers structured arguments -- chiefly pve_api's `params`, which is
 * where a password would realistically appear when creating a user or storage.
 * It deliberately does *not* try to scrub run_script's `script`: a shell audit
 * log that hides the command is worthless, so the script is stored verbatim and
 * the database is treated as being as sensitive as the host it describes.
 */
const SECRET_KEY = /pass(?:wd|word)?|secret|token|credential|api[_-]?key|private[_-]?key|^auth/i;

const REDACTED = "[redacted]";
const MAX_REDACT_DEPTH = 6;

function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_REDACT_DEPTH) return "[too deep]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value === null || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

/**
 * Trims a field to the configured budget, keeping both ends.
 *
 * The same reasoning as clampOutput in project.ts: the head says what was asked
 * for and the tail says how it ended, so a middle cut keeps more signal than a
 * head truncation. The notice is budgeted against `max` so the stored string
 * never exceeds what the setting promised.
 */
function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  const notice = (omitted: number) => `\n... [${omitted} of ${text.length} characters omitted] ...\n`;
  const budget = Math.max(0, max - notice(text.length).length);
  const head = Math.floor(budget * 0.7);
  const tail = budget - head;
  return text.slice(0, head) + notice(text.length - budget) + (tail > 0 ? text.slice(-tail) : "");
}

// --- Classifying a call ------------------------------------------------------

/**
 * Tools that can change something. pve_api is absent on purpose -- it is only a
 * mutation on a non-GET method, so it is decided per call below.
 */
const MUTATING_TOOLS = new Set([
  "start_guest",
  "shutdown_guest",
  "stop_guest",
  "snapshot_guest",
  "rollback_snapshot",
  "run_script",
  "update_settings",
]);

type Args = Record<string, unknown> | undefined;

export function isMutating(tool: string, args: Args): boolean {
  if (tool === "pve_api") {
    const method = args?.method;
    return typeof method === "string" && method.toUpperCase() !== "GET";
  }
  return MUTATING_TOOLS.has(tool);
}

/**
 * Whether the call ran as root on the Proxmox host itself.
 *
 * Both halves are required: the script has to target "host", and the
 * EXEC_SUDO_ENABLED kill switch has to have been on at the time. A host script
 * with sudo disabled runs unprivileged and is not the same event. Guest targets
 * are excluded deliberately -- `pct exec` is root inside a container, which is a
 * different blast radius from root on the hypervisor.
 */
function usedSudo(tool: string, args: Args, sudoEnabled: boolean): boolean {
  return sudoEnabled && tool === "run_script" && args?.target === "host";
}

/** A short human-readable description of what the call acted on. */
function describeTarget(tool: string, args: Args): string | undefined {
  if (!args) return undefined;
  if (tool === "run_script" && typeof args.target === "string") return args.target;
  if (tool === "pve_api" && typeof args.path === "string") {
    return `${String(args.method ?? "GET").toUpperCase()} ${args.path}`;
  }
  if (typeof args.vmid === "number") {
    return typeof args.snapname === "string"
      ? `vmid:${args.vmid}@${args.snapname}`
      : `vmid:${args.vmid}`;
  }
  if (typeof args.node === "string") return `node:${args.node}`;
  return undefined;
}

function resultText(result: CallToolResult): string {
  const content = result.content ?? [];
  return content
    .map((c) => (c.type === "text" ? c.text : `[${c.type} content]`))
    .join("\n");
}

/**
 * Proxmox task ids look like UPID:node:00001234:...:root@pam:, and both the
 * dedicated tools and a pve_api passthrough surface them -- one inside a JSON
 * object, the other as a bare string. Matching the shape rather than a field
 * name catches both without caring which.
 */
const UPID_RE = /UPID:[^\s"',]+/;

// --- The auditor -------------------------------------------------------------

export interface ToolCallRecord {
  tool: string;
  args: Args;
  result?: CallToolResult;
  error?: unknown;
  durationMs: number;
}

export class Auditor {
  /**
   * Tool names whose handler actually ran during this request.
   *
   * Needed because the decorator below can only see calls that reach a handler,
   * and the SDK rejects arguments that fail their schema before that point. A
   * `run_script` with a target crafted to dodge the regex would be refused and
   * leave no trace at all. Comparing this against what the request asked for
   * lets index.ts record the difference -- see rejectedToolCall.
   */
  readonly handled: string[] = [];

  constructor(
    private readonly db: D1Database | undefined,
    private readonly ctx: ExecutionContext | undefined,
    private readonly actor: ActorContext,
    /**
     * A thunk rather than a value: most requests never log anything, and this
     * way /health and the OAuth discovery endpoints never pay for a KV read.
     * Memoising is the caller's job.
     */
    private readonly settings: () => Promise<Settings>,
    /**
     * Whether the sudo kill switch was on when the script ran.
     *
     * A thunk rather than a value, because resolving it means reading the KV
     * override layer, and only a run_script row ever needs the answer -- there
     * is no reason for a list_guests to pay for it.
     */
    private readonly sudoEnabled: () => boolean | Promise<boolean> = () => false,
  ) {}

  get configured(): boolean {
    return Boolean(this.db);
  }

  /**
   * Hands a write to the runtime and stops caring about it.
   *
   * waitUntil keeps the isolate alive until the insert lands without holding up
   * the response, so the audit write costs the caller nothing. When there is no
   * ExecutionContext -- only in tests -- the promise is simply left to run.
   */
  private enqueue(work: () => Promise<unknown>): void {
    const promise = work().catch((e) => {
      console.error(`audit: write failed (${e instanceof Error ? e.message : String(e)})`);
    });
    this.ctx?.waitUntil(promise);
  }

  /** Records one tool call. Returns immediately; the insert happens after. */
  toolCall(record: ToolCallRecord): void {
    this.handled.push(record.tool);
    this.write(record);
  }

  /**
   * Records a call that never reached its handler because the arguments failed
   * their schema.
   *
   * `args` here is whatever the client sent, unvalidated and any shape at all --
   * which is the point. It goes through the same redaction and capping as a real
   * call, so a rejected attempt cannot smuggle in a field a normal one could not.
   */
  rejectedToolCall(tool: string, args: unknown, detail: string): void {
    this.write({
      tool,
      args: args && typeof args === "object" ? (args as Record<string, unknown>) : { _raw: args },
      rejected: detail,
      durationMs: 0,
    });
  }

  private write(record: ToolCallRecord & { rejected?: string }): void {
    if (!this.db) return;
    this.enqueue(async () => {
      const settings = await this.settings();
      if (!settings.audit_enabled) return;

      const mutating = isMutating(record.tool, record.args);
      // Mutations are logged unconditionally. Turning off read logging is a
      // volume decision; being able to turn off the record of what changed
      // would defeat the point of having a log at all.
      if (!mutating && !settings.audit_log_reads) return;

      const limit = settings.audit_max_field_chars;

      const argsJson = record.args === undefined ? null : JSON.stringify(redact(record.args));
      const text = record.result ? resultText(record.result) : "";

      // A handler that threw and one that returned isError are the same event
      // from an operator's point of view: the thing did not happen.
      const thrown = record.error !== undefined;
      const failed = record.rejected !== undefined || thrown || record.result?.isError === true;
      const errorText = record.rejected
        ? record.rejected
        : thrown
          ? record.error instanceof Error
            ? record.error.message
            : String(record.error)
          : failed
            ? text
            : null;

      await ensureSchemaOnce(this.db!);
      await this.db!.prepare(
        `INSERT INTO tool_calls (
           ts, request_id, actor_nonce, actor_issued, client_id, ip, country, user_agent,
           tool, mutating, sudo, target, args_json, args_bytes,
           status, duration_ms, result_json, result_bytes, error, upid
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)`,
      )
        .bind(
          Date.now(),
          this.actor.requestId,
          this.actor.actorNonce ?? null,
          this.actor.actorIssued ?? null,
          this.actor.clientId ?? null,
          this.actor.ip ?? null,
          this.actor.country ?? null,
          this.actor.userAgent ?? null,
          record.tool,
          mutating ? 1 : 0,
          usedSudo(record.tool, record.args, await this.sudoEnabled()) ? 1 : 0,
          describeTarget(record.tool, record.args) ?? null,
          argsJson === null ? null : cap(argsJson, limit),
          argsJson === null ? null : argsJson.length,
          record.rejected !== undefined ? "rejected" : failed ? "error" : "ok",
          record.durationMs,
          // The error text is already in `error`; repeating it in result_json
          // would double the row size for the rows most likely to be long.
          failed ? null : cap(text, limit),
          failed ? null : text.length,
          errorText === null ? null : cap(errorText, limit),
          mutating ? (UPID_RE.exec(text)?.[0] ?? null) : null,
        )
        .run();
    });
  }

  /** Records an authentication or authorization event. */
  authEvent(
    event: string,
    fields: { clientId?: string; tokenNonce?: string; detail?: string } = {},
  ): void {
    if (!this.db) return;
    this.enqueue(async () => {
      if (!(await this.settings()).audit_enabled) return;
      await ensureSchemaOnce(this.db!);
      await this.db!.prepare(
        `INSERT INTO auth_events (ts, request_id, event, ip, country, user_agent, client_id, token_nonce, detail)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
      )
        .bind(
          Date.now(),
          this.actor.requestId,
          event,
          this.actor.ip ?? null,
          this.actor.country ?? null,
          this.actor.userAgent ?? null,
          fields.clientId ?? this.actor.clientId ?? null,
          fields.tokenNonce ?? null,
          fields.detail ?? null,
        )
        .run();
    });
  }
}

// --- Wiring it into the MCP server ------------------------------------------

/**
 * Decorates every tool registered after this point so that calling it is logged.
 *
 * This shadows `registerTool` with an own property on the instance; the original
 * prototype method is still what ends up doing the work, called with the real
 * server as `this`. The alternative -- passing a registrar through all five tool
 * modules -- would mean touching every one of them and would still let a future
 * module opt out by accident. The cast is unavoidable: registerTool is generic
 * over its input and output schemas, and this wrapper is deliberately indifferent
 * to both.
 */
type AnyRegister = (
  name: string,
  config: { inputSchema?: unknown },
  cb: (...a: never[]) => unknown,
) => unknown;

export function auditToolCalls(server: McpServer, audit: Auditor): void {
  const target = server as unknown as { registerTool: AnyRegister };
  const register = target.registerTool.bind(server);

  target.registerTool = (name, config, cb) =>
    register(name, config, (async (...a: never[]) => {
      // With an inputSchema the handler is (args, extra); without one it is
      // just (extra). Every tool here has a schema, but guessing wrong would
      // silently log the extra object as the arguments, so check rather than
      // assume.
      const args = config?.inputSchema !== undefined ? (a[0] as Args) : undefined;
      const started = Date.now();
      try {
        const result = (await cb(...a)) as CallToolResult;
        audit.toolCall({ tool: name, args, result, durationMs: Date.now() - started });
        return result;
      } catch (error) {
        audit.toolCall({ tool: name, args, error, durationMs: Date.now() - started });
        throw error;
      }
    }) as (...a: never[]) => unknown);
}

// --- Retention ---------------------------------------------------------------

/** Deleted per statement, so a first sweep over a large table cannot time out. */
const SWEEP_BATCH = 5_000;
const SWEEP_MAX_BATCHES = 20;

export interface SweepResult {
  cutoff: number;
  tool_calls: number;
  auth_events: number;
  incomplete: boolean;
}

/**
 * Deletes anything older than the retention setting.
 *
 * Bounded work per run: a `DELETE ... WHERE ts < ?` over a year of rows is one
 * enormous statement, and D1 will cut it off partway rather than finish it.
 * Chunking by id keeps every statement small; whatever is left over is picked
 * up by tomorrow's run, which `incomplete` makes visible rather than silent.
 */
export async function sweepAuditLog(db: D1Database, settings: Settings): Promise<SweepResult> {
  const cutoff = Date.now() - settings.audit_retention_days * 86_400_000;
  const result: SweepResult = { cutoff, tool_calls: 0, auth_events: 0, incomplete: false };

  for (const table of ["tool_calls", "auth_events"] as const) {
    let batches = 0;
    for (;;) {
      const deleted = await db
        .prepare(
          `DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE ts < ?1 LIMIT ${SWEEP_BATCH})`,
        )
        .bind(cutoff)
        .run();
      const changes = deleted.meta?.changes ?? 0;
      result[table] += changes;
      if (changes < SWEEP_BATCH) break;
      if (++batches >= SWEEP_MAX_BATCHES) {
        result.incomplete = true;
        break;
      }
    }
  }

  return result;
}
