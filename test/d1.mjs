/**
 * A D1-compatible database backed by real SQLite, for tests.
 *
 * Worth the few lines over a mock: a mock accepts an INSERT whose column list
 * has drifted from the schema, and that is precisely the mistake worth catching.
 * Here the database rejects it, the same way D1 would.
 *
 * batch() is wrapped in BEGIN/COMMIT/ROLLBACK, which is what D1 does with a
 * batch and the property the migration runner depends on.
 */

import { DatabaseSync } from "node:sqlite";

export function fakeD1(hooks = {}) {
  const raw = new DatabaseSync(":memory:");

  const statement = (sql, params = []) => ({
    sql,
    bind: (...p) => statement(sql, p),
    async run() {
      const result = raw.prepare(sql).run(...params);
      return { meta: { changes: Number(result.changes ?? 0) } };
    },
    async all() {
      const results = raw.prepare(sql).all(...params);
      // Lets a test slip another isolate's write in between our read of the
      // ledger and our attempt to write to it.
      if (hooks.afterRead) {
        const hook = hooks.afterRead;
        hooks.afterRead = null;
        hook(raw);
      }
      return { results };
    },
  });

  return {
    raw,
    prepare: (sql) => statement(sql),
    async batch(statements) {
      raw.exec("BEGIN");
      try {
        const out = [];
        for (const s of statements) out.push(await s.run());
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
    /** Convenience for assertions. */
    query: (sql) => raw.prepare(sql).all(),
    one: (sql) => raw.prepare(sql).get(),
  };
}

export const tables = (db) =>
  db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map((r) => r.name);

export const indexes = (db) =>
  db
    .query("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .map((r) => r.name);

export const ledger = (db) => db.query("SELECT id, name FROM schema_migrations ORDER BY id");

export const columns = (db, table) => db.query(`PRAGMA table_info(${table})`);
