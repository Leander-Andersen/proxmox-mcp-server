/**
 * Tests for the self-applying schema.
 *
 * Run against real SQLite (node:sqlite) rather than a mock, because the claims
 * being made are claims about the database, not about the code's intentions:
 * that the DDL is valid, that a failed migration leaves nothing behind, and that
 * two isolates racing to migrate the same database cannot corrupt it.
 *
 * The shim below implements the slice of the D1 API that migrate.ts uses, with
 * batch() wrapped in BEGIN/COMMIT/ROLLBACK -- which is what D1 does with a
 * batch, and the property the whole design leans on.
 */

import { fakeD1, tables, indexes, ledger, columns } from "./d1.mjs";
import { ensureSchema, ensureSchemaOnce, resetSchemaMemo, MIGRATIONS, SCHEMA_VERSION } from "../dist/lib/migrate.js";

let pass = 0;
let fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  <- ${extra}`); }
};

// --- A fresh database becomes correct on its own -----------------------------

console.log("\n== a fresh database migrates itself ==");
{
  const db = fakeD1();
  const state = await ensureSchema(db);

  ok("reports what it applied", JSON.stringify(state.applied) === JSON.stringify([1]), JSON.stringify(state));
  ok("version matches the build", state.version === SCHEMA_VERSION && state.expected === SCHEMA_VERSION);
  ok("both audit tables exist", tables(db).includes("tool_calls") && tables(db).includes("auth_events"));
  ok("the ledger records the migration", ledger(db).length === 1 && ledger(db)[0].name === "audit_log");

  const idx = indexes(db);
  ok("indexes are created", idx.includes("tool_calls_ts") && idx.includes("auth_events_ts"));
  ok("partial indexes are valid SQL", idx.includes("tool_calls_mutations") && idx.includes("tool_calls_sudo"));

  const cols = columns(db, "tool_calls").map((c) => c.name);
  for (const expected of ["ts", "actor_nonce", "tool", "mutating", "sudo", "target", "status", "error", "upid"]) {
    ok(`tool_calls.${expected} exists`, cols.includes(expected));
  }
  const sudoCol = columns(db, "tool_calls").find((c) => c.name === "sudo");
  ok("sudo is a NOT NULL boolean defaulting to 0", sudoCol.notnull === 1 && sudoCol.dflt_value === "0");
}

// --- Running again does nothing ----------------------------------------------

console.log("\n== a second run is a no-op ==");
{
  const db = fakeD1();
  await ensureSchema(db);
  const appliedAt = db.one("SELECT applied_at FROM schema_migrations WHERE id = 1").applied_at;

  const second = await ensureSchema(db);
  ok("nothing is applied twice", second.applied.length === 0 && second.raced.length === 0);
  ok("version is unchanged", second.version === SCHEMA_VERSION);
  ok("the original timestamp is not rewritten",
    db.one("SELECT applied_at FROM schema_migrations WHERE id = 1").applied_at === appliedAt);
  ok("the ledger still has one row", ledger(db).length === 1);
}

// --- A new migration is picked up on the next deploy --------------------------

console.log("\n== adding a migration applies only the new one ==");
{
  const db = fakeD1();
  await ensureSchema(db);

  const next = [
    ...MIGRATIONS,
    { id: 2, name: "add_note", statements: [`ALTER TABLE tool_calls ADD COLUMN note TEXT`] },
  ];
  const state = await ensureSchema(db, next);

  ok("only the new migration runs", JSON.stringify(state.applied) === JSON.stringify([2]), JSON.stringify(state.applied));
  ok("version advances", state.version === 2 && state.expected === 2);
  ok("the column is really there", columns(db, "tool_calls").some((c) => c.name === "note"));
  ok("the ledger has both", ledger(db).length === 2);

  const again = await ensureSchema(db, next);
  ok("and is not re-applied", again.applied.length === 0);
}

// --- A failure must not leave a half-built schema -----------------------------

console.log("\n== a failing migration rolls back completely ==");
{
  const db = fakeD1();
  await ensureSchema(db);

  const broken = [
    ...MIGRATIONS,
    {
      id: 2,
      name: "broken",
      statements: [
        `CREATE TABLE partial_result (x INTEGER)`,
        `THIS IS NOT VALID SQL`,
      ],
    },
  ];

  let error;
  await ensureSchema(db, broken).catch((e) => (error = e));
  ok("the failure is surfaced, not swallowed", error instanceof Error, String(error));
  ok("the message names the migration", /migration 2 \(broken\)/.test(error?.message ?? ""), error?.message);
  ok("it says the database was left alone", /rolled back/.test(error?.message ?? ""));
  ok("the half-created table is gone", !tables(db).includes("partial_result"));
  ok("the ledger does not claim it ran", ledger(db).length === 1);

  // The earlier migration is untouched, so the database is still usable.
  ok("the previous schema still works", tables(db).includes("tool_calls"));
}

// --- Two isolates racing ------------------------------------------------------

console.log("\n== a lost race is not an error ==");
{
  // Another isolate inserts the ledger row after we read it but before we write:
  // our batch then violates the primary key and rolls back, which is correct --
  // their batch already built the schema.
  const db = fakeD1({
    afterRead: (raw) => {
      raw.exec("BEGIN");
      raw.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (1, 'audit_log', 1)").run();
      for (const sql of MIGRATIONS[0].statements) raw.exec(sql);
      raw.exec("COMMIT");
    },
  });

  const state = await ensureSchema(db);
  ok("the race is reported, not thrown", state.raced.includes(1) && state.applied.length === 0, JSON.stringify(state));
  ok("version still reflects reality", state.version === 1);
  ok("the winner's schema is intact", tables(db).includes("tool_calls") && tables(db).includes("auth_events"));
  ok("the ledger has exactly one row", ledger(db).length === 1);
}

console.log("\n== a genuine unique violation is still an error ==");
{
  const db = fakeD1();
  await ensureSchema(db);
  const conflicting = [
    ...MIGRATIONS,
    {
      id: 2,
      name: "dupe",
      statements: [
        `CREATE TABLE t (k INTEGER PRIMARY KEY)`,
        `INSERT INTO t (k) VALUES (1)`,
        `INSERT INTO t (k) VALUES (1)`,
      ],
    },
  ];
  let error;
  await ensureSchema(db, conflicting).catch((e) => (error = e));
  ok("a UNIQUE violation elsewhere is not mistaken for a lost race", error instanceof Error, String(error));
  ok("and the table is rolled back", !tables(db).includes("t"));
}

// --- Memoisation ---------------------------------------------------------------

console.log("\n== the per-isolate memo ==");
{
  const db = fakeD1();
  let reads = 0;
  const counting = { ...db, prepare: (sql) => { if (sql.startsWith("SELECT id FROM schema_migrations")) reads++; return db.prepare(sql); } };

  resetSchemaMemo(counting);
  await ensureSchemaOnce(counting);
  await ensureSchemaOnce(counting);
  await ensureSchemaOnce(counting);
  ok("the check runs once per isolate, not per call", reads === 1, `reads=${reads}`);

  resetSchemaMemo(counting);
  await ensureSchemaOnce(counting);
  ok("resetting forces a re-check", reads === 2, `reads=${reads}`);
}

console.log("\n== a failed check is retried, not cached forever ==");
{
  let attempts = 0;
  const flaky = {
    prepare(sql) {
      return {
        bind: () => flaky.prepare(sql),
        async run() { attempts++; if (attempts === 1) throw new Error("D1 unreachable"); return { meta: { changes: 0 } }; },
        async all() { return { results: [] }; },
      };
    },
    async batch() { return []; },
  };

  await ensureSchemaOnce(flaky).catch(() => {});
  const second = await ensureSchemaOnce(flaky).catch((e) => e);
  ok("a transient failure does not poison the isolate", !(second instanceof Error), String(second));
}

console.log(`\n${"=".repeat(46)}\n  ${pass} passed, ${fail} failed\n${"=".repeat(46)}`);
process.exit(fail ? 1 : 0);
