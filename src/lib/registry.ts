/**
 * This server's entry in the shared audit registry.
 *
 * Several MCP servers can log into one D1 database (Workers Free allows only a
 * few), each to its own tables. They announce themselves in `audit_instances`:
 * one row per instance saying where its tables are, what it logs, and what each
 * of its tools means. Hindsight reads that table to discover every instance, so
 * a new server appears in the viewer without Hindsight being changed.
 *
 * This server's tables predate the registry and keep their unprefixed names
 * (`tool_calls`, `auth_events`) -- nothing is moved or renamed. All this adds is
 * the one row pointing at them.
 *
 * Rules shared by every server that writes the registry:
 *   - CREATE TABLE IF NOT EXISTS: whoever gets there first creates it.
 *   - Each server only ever updates its own row; the ON CONFLICT ... WHERE
 *     clause makes an id registered by a different server a no-op, and the
 *     read-back turns that into a logged error instead of a silent one.
 *   - Columns are never changed, only added (nullable).
 */

import type { Settings } from "./settings.js";
import { SCHEMA_VERSION } from "./migrate.js";

export const INSTANCE_ID = "proxmox";
export const SERVER = "proxmox-mcp-server";
const REGISTRY_FORMAT = 1;

const REGISTRY = `CREATE TABLE IF NOT EXISTS audit_instances (
  instance_id       TEXT    PRIMARY KEY,
  server            TEXT    NOT NULL,
  display_name      TEXT    NOT NULL,
  format            INTEGER NOT NULL,
  tool_calls_table  TEXT    NOT NULL,
  auth_events_table TEXT,
  schema_version    INTEGER NOT NULL,
  settings_json     TEXT,
  tools_json        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
)`;

export interface ManifestTool {
  name: string;
  title: string;
  description: string;
  mutating: boolean;
}

/** What a reader of the log needs to know about what is, and is not, recorded. */
export function registrySettings(settings: Settings): Record<string, unknown> {
  return {
    enabled: settings.audit_enabled,
    logs_tool_calls: true,
    logs_reads: settings.audit_log_reads,
    logs_auth_events: true,
    retention_days: settings.audit_retention_days,
    max_field_chars: settings.audit_max_field_chars,
    redacts: ["secret-like argument keys", "bearer token signature"],
  };
}

export async function registerInstance(
  db: D1Database,
  settings: Settings,
  tools: ManifestTool[] | undefined,
): Promise<void> {
  await db.prepare(REGISTRY).run();
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO audit_instances (
         instance_id, server, display_name, format, tool_calls_table, auth_events_table,
         schema_version, settings_json, tools_json, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
       ON CONFLICT (instance_id) DO UPDATE SET
         display_name = excluded.display_name,
         format = excluded.format,
         tool_calls_table = excluded.tool_calls_table,
         auth_events_table = excluded.auth_events_table,
         schema_version = excluded.schema_version,
         settings_json = excluded.settings_json,
         tools_json = COALESCE(excluded.tools_json, audit_instances.tools_json),
         updated_at = excluded.updated_at
       WHERE audit_instances.server = excluded.server`,
    )
    .bind(
      INSTANCE_ID,
      SERVER,
      "Proxmox",
      REGISTRY_FORMAT,
      "tool_calls",
      "auth_events",
      SCHEMA_VERSION,
      JSON.stringify(registrySettings(settings)),
      tools && tools.length ? JSON.stringify(tools) : null,
      now,
    )
    .run();

  const row = await db
    .prepare("SELECT server FROM audit_instances WHERE instance_id = ?1")
    .bind(INSTANCE_ID)
    .first<{ server: string }>();
  if (row && row.server !== SERVER) {
    throw new Error(`audit_instances id "${INSTANCE_ID}" is registered by "${row.server}", not this server`);
  }
}

/**
 * Once per isolate: one write per cold start rather than per request, which is
 * what matters on the Workers Free D1 budget. A failure clears the memo so the
 * next write retries.
 */
const done = new WeakMap<D1Database, Promise<void>>();

export function registerOnce(
  db: D1Database,
  settings: Settings,
  tools: ManifestTool[] | undefined,
): Promise<void> {
  let pending = done.get(db);
  if (!pending) {
    pending = registerInstance(db, settings, tools).catch((error) => {
      done.delete(db);
      throw error;
    });
    done.set(db, pending);
  }
  return pending;
}

/** Test seam. */
export function resetRegistryMemo(db: D1Database): void {
  done.delete(db);
}
