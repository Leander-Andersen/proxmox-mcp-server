/**
 * Tests for the KV-backed settings store.
 *
 * The blob is meant to be edited by hand in the Cloudflare dashboard, which is
 * the assumption everything here defends: a typo in one field must not silently
 * revert the others, an unknown key must not break the read, and a value that is
 * out of range must not be accepted just because someone wrote it directly.
 */

import { DEFAULT_SETTINGS, loadSettings, saveSettings, seedSettings } from "../dist/lib/settings.js";

let pass = 0;
let fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  <- ${extra}`); }
};

/** Minimal KVNamespace: get/put, with a record of what was written. */
function fakeKV(initial) {
  const store = new Map(initial ? [["settings:v1", initial]] : []);
  return {
    writes: 0,
    async get(key) { return store.get(key) ?? null; },
    async put(key, value) { this.writes++; store.set(key, value); },
    raw: () => store.get("settings:v1"),
  };
}

const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => warnings.push(args.join(" "));

// --- Defaults ------------------------------------------------------------------

console.log("\n== defaults ==");
{
  ok("retention defaults to a year", DEFAULT_SETTINGS.audit_retention_days === 365);
  ok("an empty namespace yields defaults",
    JSON.stringify(await loadSettings(fakeKV())) === JSON.stringify(DEFAULT_SETTINGS));
  ok("no KV binding at all still yields defaults",
    JSON.stringify(await loadSettings(undefined)) === JSON.stringify(DEFAULT_SETTINGS));
}

// --- Seeding --------------------------------------------------------------------

console.log("\n== seeding ==");
{
  const kv = fakeKV();
  ok("seeding an empty namespace writes", (await seedSettings(kv)) === true);
  ok("the stored blob is the defaults",
    JSON.stringify(JSON.parse(kv.raw())) === JSON.stringify(DEFAULT_SETTINGS));
  ok("it is pretty-printed for hand editing", kv.raw().includes("\n  \"audit_retention_days\""), kv.raw());
  ok("every key is present, so nothing is hidden",
    Object.keys(JSON.parse(kv.raw())).length === Object.keys(DEFAULT_SETTINGS).length);

  const writesBefore = kv.writes;
  ok("seeding again does nothing", (await seedSettings(kv)) === false && kv.writes === writesBefore);
  ok("seeding without KV is a no-op", (await seedSettings(undefined)) === false);
}

// --- Hand-edited blobs ----------------------------------------------------------

console.log("\n== a hand-edited blob ==");
{
  const kv = fakeKV(JSON.stringify({ audit_retention_days: 30, audit_log_reads: false }));
  const s = await loadSettings(kv);
  ok("edited fields are honoured", s.audit_retention_days === 30 && s.audit_log_reads === false);
  ok("omitted fields fall back to defaults",
    s.audit_enabled === DEFAULT_SETTINGS.audit_enabled && s.audit_max_field_chars === DEFAULT_SETTINGS.audit_max_field_chars);
}
{
  warnings.length = 0;
  const kv = fakeKV(JSON.stringify({ audit_retention_days: "three hundred", audit_log_reads: false }));
  const s = await loadSettings(kv);
  ok("a typo in one field falls back to that field's default", s.audit_retention_days === 365);
  ok("its neighbours are NOT reverted", s.audit_log_reads === false);
  ok("the bad field is named in a warning", warnings.some((w) => w.includes("audit_retention_days")), warnings.join(" | "));
}
{
  const kv = fakeKV(JSON.stringify({ audit_retention_days: 99999 }));
  ok("an out-of-range value is rejected, not clamped", (await loadSettings(kv)).audit_retention_days === 365);
}
{
  const kv = fakeKV(JSON.stringify({ audit_retention_days: 30, favourite_colour: "orange" }));
  const s = await loadSettings(kv);
  ok("an unknown key is ignored rather than fatal", s.audit_retention_days === 30);
  ok("and does not appear in the result", !("favourite_colour" in s));
}
{
  const kv = fakeKV("{ this is not json");
  ok("a corrupt blob falls back to defaults rather than throwing",
    JSON.stringify(await loadSettings(kv)) === JSON.stringify(DEFAULT_SETTINGS));
}
{
  const kv = { async get() { throw new Error("KV unreachable"); }, async put() {} };
  ok("an unreachable KV does not take the connector down",
    JSON.stringify(await loadSettings(kv)) === JSON.stringify(DEFAULT_SETTINGS));
}

// --- Writing --------------------------------------------------------------------

console.log("\n== update ==");
{
  const kv = fakeKV();
  const { settings, changed } = await saveSettings(kv, { audit_retention_days: 30 });
  ok("the change is applied", settings.audit_retention_days === 30);
  ok("only the changed field is reported",
    JSON.stringify(changed) === JSON.stringify({ audit_retention_days: 30 }), JSON.stringify(changed));
  ok("other fields are preserved", settings.audit_enabled === DEFAULT_SETTINGS.audit_enabled);
  ok("the stored blob stays pretty-printed", kv.raw().includes("\n  \""));

  const second = await saveSettings(kv, { audit_retention_days: 30 });
  ok("a no-op change reports nothing changed", Object.keys(second.changed).length === 0);

  const third = await saveSettings(kv, { audit_log_reads: false });
  ok("an unrelated later change keeps the earlier one", third.settings.audit_retention_days === 30);
}
{
  const kv = fakeKV();
  let error;
  await saveSettings(kv, { audit_retention_days: 0 }).catch((e) => (error = e));
  ok("a value below the minimum is refused", error !== undefined);
  ok("and nothing is written", kv.writes === 0);
}
{
  const kv = fakeKV();
  let error;
  await saveSettings(kv, { audit_retention_days: 4000 }).catch((e) => (error = e));
  ok("a value above the maximum is refused", error !== undefined);
  ok("ten years is the ceiling", (await saveSettings(kv, { audit_retention_days: 3650 })).settings.audit_retention_days === 3650);
}

console.warn = realWarn;
console.log(`\n${"=".repeat(46)}\n  ${pass} passed, ${fail} failed\n${"=".repeat(46)}`);
process.exit(fail ? 1 : 0);
