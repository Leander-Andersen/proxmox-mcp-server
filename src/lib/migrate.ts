/**
 * The database schema, and the machinery that makes a D1 instance match it.
 *
 * The schema is defined here rather than in .sql files because a Worker has no
 * filesystem at runtime -- it can only apply what is bundled with it. Keeping
 * the definitions in code means the deployed Worker always carries the schema it
 * expects, so "what the code wants" and "what the database has" can be compared
 * and reconciled without anyone running a command.
 *
 * How it works: a `schema_migrations` ledger records which migrations have run.
 * On the first audit write after a deploy, anything missing is applied in order.
 * Add a migration by appending to MIGRATIONS below; the next deploy picks it up.
 *
 * Two rules, and the whole thing stays safe:
 *
 *   1. Never change or renumber a migration that has shipped. The ledger records
 *      ids, so editing one already applied means it silently never runs again --
 *      and databases created afterwards get a different schema from the ones
 *      created before. Fix mistakes by appending a new migration.
 *   2. Never assume a migration runs alone. Several isolates can boot at once
 *      and all find the same work pending; the ledger insert is what arbitrates.
 */

export interface Migration {
  /**
   * Monotonic, unique, permanent. This number *is* the identity of the
   * migration as far as the ledger is concerned.
   */
  id: number;
  name: string;
  /**
   * One SQL statement per entry. D1's prepare() takes a single statement, and
   * running them individually is also what lets the whole list share one
   * transaction via batch().
   */
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "audit_log",
    statements: [
      // Two tables rather than one, because "who did what" and "who got in" are
      // different questions with different shapes: a tool call always has an
      // actor, while an auth event is usually the story of someone who never
      // became one. Forcing both into a single events table would leave half the
      // columns null on every row.
      //
      // ts is epoch milliseconds as an integer, so range scans use the index and
      // comparisons never depend on SQLite's string collation.
      //
      // actor_nonce is the nonce from the bearer token -- there is no user
      // database (see auth.ts), so this is as close to an identity as exists.
      // The signature is deliberately absent: it is a live credential.
      //
      // status is one of 'ok' (ran, succeeded), 'error' (ran, failed or was
      // refused by a tool's own guard) or 'rejected' (never ran, because the
      // arguments failed their schema -- recorded from the raw request body,
      // since an attempt that was turned away is still an attempt).
      `CREATE TABLE IF NOT EXISTS tool_calls (
         id            INTEGER PRIMARY KEY AUTOINCREMENT,
         ts            INTEGER NOT NULL,
         request_id    TEXT    NOT NULL,
         actor_nonce   TEXT,
         actor_issued  INTEGER,
         actor_label   TEXT,
         client_id     TEXT,
         ip            TEXT,
         country       TEXT,
         user_agent    TEXT,
         tool          TEXT    NOT NULL,
         mutating      INTEGER NOT NULL DEFAULT 0,
         -- 1 only when the script actually ran with root on the Proxmox host:
         -- run_script against target "host" while the EXEC_SUDO_ENABLED kill
         -- switch was on. Container and VM targets are 0 -- they run as root
         -- inside a guest, which is a different blast radius entirely, and
         -- conflating the two would make "show me everything that touched the
         -- host as root" impossible to ask.
         sudo          INTEGER NOT NULL DEFAULT 0,
         target        TEXT,
         args_json     TEXT,
         args_bytes    INTEGER,
         status        TEXT    NOT NULL,
         duration_ms   INTEGER,
         result_json   TEXT,
         result_bytes  INTEGER,
         error         TEXT,
         upid          TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS tool_calls_ts       ON tool_calls (ts DESC)`,
      `CREATE INDEX IF NOT EXISTS tool_calls_actor_ts ON tool_calls (actor_nonce, ts DESC)`,
      `CREATE INDEX IF NOT EXISTS tool_calls_tool_ts  ON tool_calls (tool, ts DESC)`,
      `CREATE INDEX IF NOT EXISTS tool_calls_target   ON tool_calls (target, ts DESC)`,
      // Partial: "show me every change made this month" is the single most
      // common audit question, and mutations are a small fraction of the rows.
      `CREATE INDEX IF NOT EXISTS tool_calls_mutations ON tool_calls (ts DESC) WHERE mutating = 1`,
      `CREATE INDEX IF NOT EXISTS tool_calls_upid     ON tool_calls (upid) WHERE upid IS NOT NULL`,
      // Partial for the same reason: root-on-the-host is the rarest and most
      // interesting category, so it gets its own index rather than a scan.
      `CREATE INDEX IF NOT EXISTS tool_calls_sudo     ON tool_calls (ts DESC) WHERE sudo = 1`,

      // token_nonce on a token_issued row is what gives actor_nonce a meaning:
      // without it a nonce is an opaque string, with it you know which address
      // typed the password and when.
      `CREATE TABLE IF NOT EXISTS auth_events (
         id          INTEGER PRIMARY KEY AUTOINCREMENT,
         ts          INTEGER NOT NULL,
         request_id  TEXT,
         event       TEXT    NOT NULL,
         ip          TEXT,
         country     TEXT,
         user_agent  TEXT,
         client_id   TEXT,
         token_nonce TEXT,
         detail      TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS auth_events_ts       ON auth_events (ts DESC)`,
      `CREATE INDEX IF NOT EXISTS auth_events_event_ts ON auth_events (event, ts DESC)`,
      `CREATE INDEX IF NOT EXISTS auth_events_nonce    ON auth_events (token_nonce) WHERE token_nonce IS NOT NULL`,
    ],
  },
];

/** The schema version this build of the Worker expects. */
export const SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.id), 0);

const LEDGER = `CREATE TABLE IF NOT EXISTS schema_migrations (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  applied_at INTEGER NOT NULL
)`;

export interface SchemaState {
  /** Highest migration id the database has. */
  version: number;
  /** Highest migration id this build carries. */
  expected: number;
  /** Ids applied by this call, in order. Empty when there was nothing to do. */
  applied: number[];
  /** Ids another isolate applied first while this call was running. */
  raced: number[];
}

/**
 * A duplicate ledger row means a concurrent isolate got there first.
 *
 * Matched narrowly, on the ledger table by name: a UNIQUE violation from
 * anywhere else is a real failure and must not be swallowed as a lost race.
 */
function isLostRace(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed:\s*schema_migrations/i.test(message);
}

/**
 * Brings the database up to the schema this build expects.
 *
 * Each migration is applied as one batch, which D1 runs inside a transaction --
 * so a migration either lands completely or not at all, and a half-applied
 * schema is not a state that can be reached. The ledger insert goes first in the
 * batch so that a concurrent isolate is turned away by the primary key before
 * any DDL runs, and its whole batch rolls back.
 */
export async function ensureSchema(
  db: D1Database,
  migrations: Migration[] = MIGRATIONS,
): Promise<SchemaState> {
  await db.prepare(LEDGER).run();

  const ledger = await db.prepare("SELECT id FROM schema_migrations").all<{ id: number }>();
  const done = new Set((ledger.results ?? []).map((row) => row.id));

  const pending = migrations
    .filter((m) => !done.has(m.id))
    .sort((a, b) => a.id - b.id);

  const state: SchemaState = {
    version: done.size ? Math.max(...done) : 0,
    expected: migrations.reduce((max, m) => Math.max(max, m.id), 0),
    applied: [],
    raced: [],
  };

  for (const migration of pending) {
    try {
      await db.batch([
        db
          .prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?1, ?2, ?3)")
          .bind(migration.id, migration.name, Date.now()),
        ...migration.statements.map((sql) => db.prepare(sql)),
      ]);
      state.applied.push(migration.id);
    } catch (error) {
      if (isLostRace(error)) {
        // Someone else applied it. Their batch was atomic too, so the schema is
        // correct either way -- there is nothing to do but carry on.
        state.raced.push(migration.id);
        continue;
      }
      throw new Error(
        `Schema migration ${migration.id} (${migration.name}) failed, so the database is still at ` +
          `version ${state.version}. It was rolled back, not half-applied. ` +
          `(${error instanceof Error ? error.message : String(error)})`,
      );
    }
    state.version = migration.id;
  }

  if (state.raced.length) state.version = Math.max(state.version, ...state.raced);
  return state;
}

/**
 * Per-isolate memo, so the check costs one query per isolate rather than one per
 * request.
 *
 * A rejected result clears the memo: a database that was briefly unreachable
 * should not leave this isolate permanently convinced the schema is broken.
 * Successes are kept for the life of the isolate, which is the whole point.
 */
const inflight = new WeakMap<D1Database, Promise<SchemaState>>();

export function ensureSchemaOnce(db: D1Database): Promise<SchemaState> {
  let pending = inflight.get(db);
  if (!pending) {
    pending = ensureSchema(db).catch((error) => {
      inflight.delete(db);
      throw error;
    });
    inflight.set(db, pending);
  }
  return pending;
}

/** Test seam: forget what this process has already checked. */
export function resetSchemaMemo(db: D1Database): void {
  inflight.delete(db);
}
