/**
 * Regression tests for the path-handling fixes.
 *
 * No test framework: `npm test` compiles src/lib/pve.ts into dist/ and runs this.
 *
 * The invariant being defended is narrow and worth stating plainly, because the
 * original bug was not "traversal is possible" but "the guard and the request
 * disagreed about what path was being called":
 *
 *   For any input, the path the read-only guard inspects is the same path
 *   Proxmox receives.
 *
 * Traversal that stays inside /api2/json is therefore fine to allow -- it just
 * has to be normalised before anyone makes a decision about it. Traversal that
 * leaves /api2/json is refused outright.
 */

import { resolvePath, isValidNodeName } from "../dist/lib/pve.js";

const BASE = "https://pve.example.com";
const READ_ONLY = ["/access/", "/cluster/config/"];

let pass = 0;
let fail = 0;

function ok(label, cond) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}`);
  }
}

/** Mirrors what pve_api does: resolve, then decide. */
function guard(method, path) {
  let apiPath;
  try {
    apiPath = resolvePath(BASE, path).apiPath;
  } catch {
    return "rejected";
  }
  if (method === "DELETE") return "blocked";
  if (method !== "GET" && READ_ONLY.some((p) => apiPath.startsWith(p))) return "blocked";
  return `allowed:${apiPath}`;
}

// --- C1: node is interpolated into a path, so it must be a DNS label ---------

console.log("\n== C1: node values that used to rewrite the path ==");
for (const n of [
  "../../json/access/acl?", // `?` discarded the tool's own path suffix
  "../../json/access/users/root@pam/token/evil?", // minted a PVE API token
  "../access/acl/..",
  "../../json/access/acl#", // `#` is never transmitted by fetch
  "pve/../../access",
  "..",
  "pve/qemu",
  "",
]) {
  ok(`rejected: ${JSON.stringify(n)}`, !isValidNodeName(n));
}

console.log("\n== C1: real node names still accepted ==");
for (const n of ["pve", "pve1", "node-01", "pve.lan", "PVE", "a"]) {
  ok(`accepted: ${JSON.stringify(n)}`, isValidNodeName(n));
}

// --- C2: escaping the API root is refused ------------------------------------

console.log("\n== C2: paths that leave /api2/json are refused ==");
for (const p of [
  "/../../json/access/users",
  "/nodes/pve/../../../../etc/passwd",
  "/../../../",
  "/access/acl#/ignored", // a fragment would silently change the path
]) {
  ok(`rejected: ${JSON.stringify(p)}`, guard("POST", p) === "rejected");
}

// --- C2: the guard and the request now agree ---------------------------------

console.log("\n== C2: traversal inside the root is normalised before the guard runs ==");
for (const p of [
  "/nodes/pve/../../access/acl",
  "/../json/access/users",
  "/nodes/pve/../../access/users/root@pam/token/evil",
  "/cluster/../cluster/config/nodes",
]) {
  ok(`write blocked: ${JSON.stringify(p)}`, guard("POST", p) === "blocked");
}

// The pre-fix behaviour, stated as a test so a regression is obvious.
ok(
  "resolved path is what the guard sees",
  resolvePath(BASE, "/nodes/pve/../../access/acl").apiPath === "/access/acl",
);

console.log("\n== C2: legitimate calls are unaffected ==");
for (const [p, expected] of [
  ["/nodes/pve/storage", "/nodes/pve/storage"],
  ["/cluster/resources", "/cluster/resources"],
  ["/nodes/pve/qemu/100/status/current", "/nodes/pve/qemu/100/status/current"],
]) {
  ok(`POST ${p}`, guard("POST", p) === `allowed:${expected}`);
}

// Reads of /access were always permitted, and still are.
ok("GET /access/users still allowed", guard("GET", "/access/users") === "allowed:/access/users");
ok("POST /access/users still blocked", guard("POST", "/access/users") === "blocked");

// A query string in the path is load-bearing for pve_api and must survive.
const q = resolvePath(BASE, "/nodes/pve/tasks?limit=5");
ok(
  "query string preserved",
  q.url.searchParams.get("limit") === "5" && q.apiPath === "/nodes/pve/tasks",
);

console.log(`\n${"=".repeat(46)}\n  ${pass} passed, ${fail} failed\n${"=".repeat(46)}`);
process.exit(fail ? 1 : 0);
