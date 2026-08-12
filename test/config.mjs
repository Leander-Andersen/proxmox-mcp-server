/**
 * Tests for the KV override layer.
 *
 * One property matters more than all the others here, and every failure mode is
 * pointed at it:
 *
 *   A deployment that has never written to KV must behave exactly as it did
 *   before this layer existed.
 *
 * So: no KV binding, no override entry, an empty entry, a corrupt entry, an
 * unreachable namespace, a blank value, an unknown key -- all of them must fall
 * through to the deployed secret rather than to nothing. A configuration layer
 * that can take the credentials away is worse than not having one.
 */

import { CONFIG, describeConfig, resolveConfig, seedConfigOverrides } from "../dist/lib/config.js";
import { DEFAULT_SETTINGS } from "../dist/lib/settings.js";

let pass = 0;
let fail = 0;
const ok = (label, cond, extra = "") => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  <- ${extra}`); }
};

const SECRETS = {
  MCP_API_KEY: "deployed-key",
  PVE_HOST: "https://pve.deployed.example",
  PVE_TOKEN: "claude@pve!mcp=deployed",
  CF_ACCESS_CLIENT_ID: "deployed.access",
  CF_ACCESS_CLIENT_SECRET: "deployed-secret",
  EXEC_SUDO_ENABLED: "false",
};

function fakeKV(blob) {
  const store = new Map(blob === undefined ? [] : [["config:v1", blob]]);
  return {
    writes: 0,
    async get(key) { return store.get(key) ?? null; },
    async put(key, value) { this.writes++; store.set(key, value); },
    raw: () => store.get("config:v1"),
  };
}

const warnings = [];
const realWarn = console.warn;
console.warn = (...a) => warnings.push(a.join(" "));

// --- Nothing in KV: the deployed secrets are untouched -------------------------

console.log("\n== an untouched deployment is unaffected ==");
for (const [label, kv] of [
  ["no KV binding at all", undefined],
  ["an empty namespace", fakeKV()],
  ["an empty override object", fakeKV("{}")],
  ["a template with only _ notes", fakeKV(JSON.stringify({ _readme: "hi", _keys: "PVE_HOST" }))],
]) {
  const { env, sources } = await resolveConfig({ ...SECRETS }, kv);
  ok(`${label}: every secret survives`,
    env.PVE_HOST === SECRETS.PVE_HOST && env.PVE_TOKEN === SECRETS.PVE_TOKEN && env.MCP_API_KEY === SECRETS.MCP_API_KEY);
  ok(`${label}: source reads "secret"`, sources.PVE_HOST === "secret");
}

// --- Broken KV must never cost the credentials --------------------------------

console.log("\n== a broken override layer falls back, never fails ==");
{
  warnings.length = 0;
  const { env, warning } = await resolveConfig({ ...SECRETS }, fakeKV("{not json at all"));
  ok("a corrupt blob keeps the secrets", env.PVE_HOST === SECRETS.PVE_HOST && env.PVE_TOKEN === SECRETS.PVE_TOKEN);
  ok("and reports the problem rather than hiding it", typeof warning === "string" && warning.includes("config:v1"));
}
{
  const unreachable = { async get() { throw new Error("KV unreachable"); } };
  const { env, warning } = await resolveConfig({ ...SECRETS }, unreachable);
  ok("an unreachable namespace keeps the secrets", env.PVE_HOST === SECRETS.PVE_HOST);
  ok("and warns", typeof warning === "string");
}
{
  const { env, sources } = await resolveConfig({ ...SECRETS }, fakeKV(JSON.stringify({ PVE_HOST: "   " })));
  ok("a blank override is treated as absent, not as an empty host", env.PVE_HOST === SECRETS.PVE_HOST);
  ok("and the source still says secret", sources.PVE_HOST === "secret");
}
{
  warnings.length = 0;
  const { env } = await resolveConfig({ ...SECRETS }, fakeKV(JSON.stringify({ NOT_A_REAL_KEY: "x" })));
  ok("an unknown key is ignored", env.NOT_A_REAL_KEY === undefined);
  ok("and is named in a warning", warnings.some((w) => w.includes("NOT_A_REAL_KEY")), warnings.join(" | "));
}

// --- An override, when deliberately set ----------------------------------------

console.log("\n== an override wins when present ==");
{
  const kv = fakeKV(JSON.stringify({ PVE_HOST: "https://pve.override.example", EXEC_SUDO_ENABLED: "true" }));
  const { env, sources } = await resolveConfig({ ...SECRETS }, kv);
  ok("the overridden value is used", env.PVE_HOST === "https://pve.override.example");
  ok("the source says so", sources.PVE_HOST === "kv");
  ok("untouched keys keep their secret", env.PVE_TOKEN === SECRETS.PVE_TOKEN && sources.PVE_TOKEN === "secret");
  ok("a flag can be overridden too", env.EXEC_SUDO_ENABLED === "true");
  ok("whitespace is trimmed", (await resolveConfig({ ...SECRETS }, fakeKV(JSON.stringify({ PVE_HOST: "  https://x  " })))).env.PVE_HOST === "https://x");
}
{
  const kv = fakeKV(JSON.stringify({ EXEC_HOST: "https://exec.override.example" }));
  const { env } = await resolveConfig({ ...SECRETS }, kv);
  ok("a key with no secret at all can be supplied entirely by KV", env.EXEC_HOST === "https://exec.override.example");
}
{
  // The original object must not be mutated: a half-applied config would be
  // worse than none.
  const original = { ...SECRETS };
  await resolveConfig(original, fakeKV(JSON.stringify({ PVE_HOST: "https://elsewhere" })));
  ok("the caller's env is never mutated", original.PVE_HOST === SECRETS.PVE_HOST);
}

// --- MCP_API_KEY is deliberately not overridable --------------------------------

console.log("\n== the signing key stays out of it ==");
{
  warnings.length = 0;
  const kv = fakeKV(JSON.stringify({ MCP_API_KEY: "attacker-chosen-key" }));
  const { env } = await resolveConfig({ ...SECRETS }, kv);
  ok("MCP_API_KEY cannot be replaced from KV", env.MCP_API_KEY === SECRETS.MCP_API_KEY);
  ok("the attempt is rejected as an unknown key", warnings.some((w) => w.includes("MCP_API_KEY")));
  ok("it is marked non-overridable in the registry",
    CONFIG.find((c) => c.key === "MCP_API_KEY").overridable === false);
}

// --- Nothing security-relevant is tool-writable ---------------------------------

console.log("\n== the tool-write boundary ==");
{
  const writable = CONFIG.filter((c) => c.toolWritable).map((c) => c.key);
  ok("only the audit settings are tool-writable",
    JSON.stringify(writable.sort()) === JSON.stringify(Object.keys(DEFAULT_SETTINGS).sort()), JSON.stringify(writable));
  ok("no secret-backed key is tool-writable", CONFIG.every((c) => c.storage !== "secret" || !c.toolWritable));
  for (const key of ["PVE_HOST", "EXEC_HOST", "EXEC_SUDO_ENABLED"]) {
    const entry = CONFIG.find((c) => c.key === key);
    ok(`${key} is overridable by hand but not by a tool`, entry.overridable === true && entry.toolWritable === false);
  }
  ok("every secret explains itself", CONFIG.filter((c) => c.storage === "secret").every((c) => typeof c.why_secret === "string"));
}

// --- The report must never leak a value -----------------------------------------

console.log("\n== the config report ==");
{
  const kv = fakeKV(JSON.stringify({ PVE_HOST: "https://pve.override.example" }));
  const { env, sources } = await resolveConfig({ ...SECRETS }, kv);
  const report = describeConfig(env, DEFAULT_SETTINGS, sources);
  const text = JSON.stringify(report);

  ok("no credential value appears anywhere", !text.includes("deployed-secret") && !text.includes("mcp=deployed") && !text.includes("deployed-key"));
  ok("a non-sensitive value is shown, because it is useful",
    report.secrets.find((s) => s.key === "PVE_HOST").value === "https://pve.override.example");
  ok("a credential carries no value field at all",
    !("value" in report.secrets.find((s) => s.key === "PVE_TOKEN")));
  ok("presence is still reported for credentials", report.secrets.find((s) => s.key === "PVE_TOKEN").set === true);
  ok("the winning layer is reported", report.secrets.find((s) => s.key === "PVE_HOST").source === "kv");
  ok("missing required keys are listed", describeConfig({}, DEFAULT_SETTINGS, {}).missing_required.length > 0);
  ok("a fully configured deployment lists none", report.missing_required.length === 0, JSON.stringify(report.missing_required));
}

// --- Seeding ---------------------------------------------------------------------

console.log("\n== seeding the override template ==");
{
  const kv = fakeKV();
  ok("an empty namespace is seeded", (await seedConfigOverrides(kv)) === true);
  const template = JSON.parse(kv.raw());
  ok("the template explains itself", typeof template._readme === "string");
  ok("it lists the keys you may set", template._keys.includes("PVE_HOST") && template._keys.includes("EXEC_SUDO_ENABLED"));
  ok("it does not list the one you may not", !template._keys.includes("MCP_API_KEY"));
  ok("it sets no actual values", Object.keys(template).every((k) => k.startsWith("_")));

  const writes = kv.writes;
  ok("seeding twice does not overwrite", (await seedConfigOverrides(kv)) === false && kv.writes === writes);

  // The seeded template must itself be a no-op when read back.
  const { env, sources } = await resolveConfig({ ...SECRETS }, kv);
  ok("the freshly seeded template changes nothing", env.PVE_HOST === SECRETS.PVE_HOST && sources.PVE_HOST === "secret");
}

console.warn = realWarn;
console.log(`\n${"=".repeat(46)}\n  ${pass} passed, ${fail} failed\n${"=".repeat(46)}`);
process.exit(fail ? 1 : 0);
