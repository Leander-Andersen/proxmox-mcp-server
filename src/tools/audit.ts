import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "../env.js";
import { fail, run } from "../lib/result.js";
import { describeConfig, resolveConfig, seedConfigOverrides } from "../lib/config.js";
import { SCHEMA_VERSION } from "../lib/migrate.js";
import { loadSettings, saveSettings, seedSettings, settingsSchema } from "../lib/settings.js";

/**
 * Reading the log back, and changing the policy that governs it.
 *
 * The query tool exists because an audit trail nobody can consult is just disk
 * usage: "who stopped 101 last week" should be answerable in the same place the
 * stopping happened, not only from a wrangler shell.
 */

const RELATIVE = /^(\d+)\s*([mhdw])$/i;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** Accepts "24h", "7d", an ISO timestamp, or epoch milliseconds. */
function parseTime(value: string): number {
  const trimmed = value.trim();

  const relative = RELATIVE.exec(trimmed);
  if (relative) {
    const unit = UNIT_MS[relative[2].toLowerCase() as keyof typeof UNIT_MS];
    return Date.now() - parseInt(relative[1], 10) * unit;
  }
  if (/^\d{10,}$/.test(trimmed)) return parseInt(trimmed, 10);

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new Error(
      `Could not read "${value}" as a time. Use a relative window like "24h" or "7d", an ISO ` +
        `timestamp like "2026-08-01T00:00:00Z", or epoch milliseconds.`,
    );
  }
  return parsed;
}

const iso = (ts: number) => new Date(ts).toISOString();

const timeInput = {
  since: z
    .string()
    .optional()
    .describe('Start of the window: "24h", "7d", an ISO timestamp, or epoch ms. Default "7d".'),
  until: z.string().optional().describe("End of the window, same formats. Default now."),
  limit: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe("Rows to return, newest first. Default 50, max 500."),
};

export function registerAuditTools(server: McpServer, db: D1Database): void {
  server.registerTool(
    "audit_log",
    {
      title: "Query the audit log",
      description:
        "Search the record of what this connector has done: every tool call with its arguments, " +
        "result, duration and outcome, plus the authentication events behind them. Actors are " +
        "identified by the nonce of the bearer token they used -- look the same nonce up with " +
        'kind:"auth" to see the IP and time that token was issued. Results are omitted by default ' +
        "because they can be large; pass include_payloads to see arguments and results in full.",
      inputSchema: {
        kind: z
          .enum(["tools", "auth"])
          .optional()
          .describe(
            'What to search: "tools" for tool calls (default), "auth" for authorization, token ' +
              "and revocation events.",
          ),
        ...timeInput,
        tool: z.string().optional().describe('Only this tool, e.g. "run_script".'),
        event: z
          .string()
          .optional()
          .describe('kind:"auth" only. e.g. "authorize_fail", "token_issued", "access_denied".'),
        actor: z.string().optional().describe("Only calls made with this token nonce."),
        target: z
          .string()
          .optional()
          .describe('Substring match on the target, e.g. "vmid:101", "host", "/nodes/pve".'),
        status: z
          .enum(["ok", "error", "rejected"])
          .optional()
          .describe(
            '"ok" ran and succeeded, "error" ran and failed, "rejected" never ran because its ' +
              "arguments failed validation.",
          ),
        mutating: z
          .boolean()
          .optional()
          .describe("True for only the calls that changed something; false for only reads."),
        sudo: z
          .boolean()
          .optional()
          .describe(
            "True for only the scripts that ran as root on the Proxmox host itself. Guest targets " +
              "are not sudo -- they run as root inside a container or VM, which is a different " +
              "blast radius.",
          ),
        contains: z
          .string()
          .optional()
          .describe(
            "Substring search across arguments, results and error text. Use this to find, for " +
              'example, every script that mentioned a hostname.',
          ),
        include_payloads: z
          .boolean()
          .optional()
          .describe("Include the stored arguments and results on each row. Default false."),
      },
    },
    async (args) =>
      run(async () => {
        const since = parseTime(args.since ?? "7d");
        const until = args.until ? parseTime(args.until) : Date.now();
        const limit = args.limit ?? 50;

        // Every value is bound. Nothing from the caller is ever concatenated
        // into the SQL -- the column list and ordering are fixed literals.
        const where: string[] = ["ts >= ?", "ts <= ?"];
        const params: Array<string | number> = [since, until];
        const add = (clause: string, value: string | number) => {
          where.push(clause);
          params.push(value);
        };

        if (args.kind === "auth") {
          if (args.event) add("event = ?", args.event);
          if (args.actor) add("token_nonce = ?", args.actor);
          if (args.contains) add("detail LIKE ?", `%${args.contains}%`);

          const rows = await db
            .prepare(
              `SELECT id, ts, event, ip, country, user_agent, client_id, token_nonce, detail
                 FROM auth_events WHERE ${where.join(" AND ")} ORDER BY ts DESC LIMIT ?`,
            )
            .bind(...params, limit)
            .all<Record<string, unknown>>();

          return {
            window: { since: iso(since), until: iso(until) },
            count: rows.results.length,
            events: rows.results.map((r) => ({ ...r, ts: iso(r.ts as number) })),
          };
        }

        if (args.tool) add("tool = ?", args.tool);
        if (args.actor) add("actor_nonce = ?", args.actor);
        if (args.status) add("status = ?", args.status);
        if (args.mutating !== undefined) add("mutating = ?", args.mutating ? 1 : 0);
        if (args.sudo !== undefined) add("sudo = ?", args.sudo ? 1 : 0);
        if (args.target) add("target LIKE ?", `%${args.target}%`);
        if (args.contains) {
          where.push("(args_json LIKE ? OR result_json LIKE ? OR error LIKE ?)");
          const pattern = `%${args.contains}%`;
          params.push(pattern, pattern, pattern);
        }

        const payloads = args.include_payloads === true;
        const columns = [
          "id",
          "ts",
          "tool",
          "target",
          "mutating",
          "sudo",
          "status",
          "duration_ms",
          "actor_nonce",
          "ip",
          "country",
          "upid",
          "error",
          ...(payloads ? ["args_json", "args_bytes", "result_json", "result_bytes"] : []),
        ].join(", ");

        const rows = await db
          .prepare(
            `SELECT ${columns} FROM tool_calls WHERE ${where.join(" AND ")} ORDER BY ts DESC LIMIT ?`,
          )
          .bind(...params, limit)
          .all<Record<string, unknown>>();

        return {
          window: { since: iso(since), until: iso(until) },
          count: rows.results.length,
          note: rows.results.length === limit ? `Capped at ${limit} rows; narrow the window.` : undefined,
          calls: rows.results.map((r) => ({
            ...r,
            ts: iso(r.ts as number),
            mutating: r.mutating === 1,
            sudo: r.sudo === 1,
          })),
        };
      }),
  );
}

export function registerSettingsTools(server: McpServer, env: Env): void {
  const kv = env.PROXMOX_KV;

  server.registerTool(
    "get_settings",
    {
      title: "Show the connector's configuration",
      description:
        "The whole configuration surface in one place: which secrets are set (presence only -- " +
        "secret values are never readable), and what every editable setting currently is. Use this " +
        "to find out what is missing or what can be changed.",
      inputSchema: {},
    },
    async () =>
      run(async () => {
        // Seeding here rather than on the request path: these are writes, and
        // this tool is exactly the moment someone wants the KV entries to exist
        // so they can go and edit them.
        const seeded = [
          (await seedSettings(kv)) ? "settings:v1" : null,
          (await seedConfigOverrides(kv)) ? "config:v1" : null,
        ].filter(Boolean);

        const settings = await loadSettings(kv);
        // `env` here is already the resolved view -- buildServer is handed the
        // overridden env -- so re-resolving is only to recover which layer each
        // value came from.
        const { sources, warning } = await resolveConfig(env, kv);

        return {
          ...describeConfig(env, settings, sources),
          audit: { configured: Boolean(env.AUDIT_DB), schema_version: SCHEMA_VERSION },
          storage: kv
            ? `Overrides in the PROXMOX_KV entry "config:v1", settings in "settings:v1"` +
              (seeded.length ? ` (just created: ${seeded.join(", ")})` : "")
            : "PROXMOX_KV is not bound, so the deployed secrets and defaults are in force.",
          ...(warning ? { warning } : {}),
        };
      }),
  );

  server.registerTool(
    "update_settings",
    {
      title: "Change connector settings",
      description:
        "Change one or more runtime settings. Only the fields passed are touched; the rest keep " +
        "their current values. Changes are cached at the edge, so allow up to a minute for one to " +
        "apply everywhere. This call is itself recorded in the audit log. Secrets cannot be " +
        "changed here -- see get_settings for why each one is a secret.",
      inputSchema: settingsSchema.partial().shape,
    },
    async (patch) => {
      if (!kv) {
        return fail(
          "PROXMOX_KV is not bound, so there is nowhere to store settings. The connector is " +
            "running on defaults.",
        );
      }

      const supplied = Object.fromEntries(
        Object.entries(patch).filter(([, v]) => v !== undefined),
      );
      if (Object.keys(supplied).length === 0) {
        return fail("Nothing to change -- pass at least one setting. Use get_settings to see them.");
      }

      return run(async () => {
        const { settings, changed } = await saveSettings(kv, supplied);
        return {
          settings,
          changed: Object.keys(changed).length ? changed : "nothing (values were already set)",
          note: "Cached for up to 60 seconds at the edge; a change may take that long to apply.",
        };
      });
    },
  );
}
