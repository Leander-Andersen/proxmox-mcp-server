# proxmox-mcp-server

A Cloudflare Worker that lets Claude manage a Proxmox VE host over MCP. It
handles everything structured through the Proxmox REST API, and hands shell
work to a companion service, **[proxmox-mcp-bridge](https://github.com/Leander-Andersen/proxmox-mcp-bridge)**,
which runs on the Proxmox host itself.

Nothing is exposed to the internet directly: the Worker reaches Proxmox through
a Cloudflare Tunnel, authenticating with a Cloudflare Access service token.

```
Claude (claude.ai connector)
    |  MCP over HTTPS, bearer token
proxmox-mcp-server  (this repo, a Cloudflare Worker)
    |  + CF-Access service token headers
Cloudflare Access -> Cloudflare Tunnel -> Proxmox host
                                          |- pveproxy :8006    REST API
                                          '- exec bridge :5000 shell
                                             (proxmox-mcp-bridge)
```

---

## Using it

Once the connector is added, you just talk to Claude normally. A few things
worth knowing about how it behaves:

**You rarely need to name the node.** `node` and `type` are optional on every
guest tool — the Worker looks the vmid up in `/cluster/resources` and fills
them in. On a single-node install you never type them at all. On a cluster you
still can, to disambiguate.

**Write operations return a task, not a result.** Proxmox runs starts, stops
and snapshots asynchronously and hands back a UPID. Claude gets that UPID and
can poll it with `task_status`, which also returns the task log — so "did that
actually work?" is answerable rather than assumed.

Things you can ask for directly:

- *"What's running on Proxmox right now?"* — `list_guests`, one call, shows
  every VM and container with status and memory use.
- *"How's the host doing?"* — `node_status` for cpu, memory, swap, root
  filesystem, load average and uptime.
- *"Snapshot container 101 before I upgrade it."* — `snapshot_guest`, then
  `rollback_snapshot` if the upgrade goes badly.
- *"Gracefully shut down VM 100, and tell me when it's actually down."* —
  `shutdown_guest` followed by `task_status` on the returned UPID.
- *"Anything failed on the host lately?"* — `list_tasks` with `errors: true`.
- *"What storage do I have configured?"* — no dedicated tool, so this falls to
  `pve_api` with `GET /nodes/<node>/storage`.

**Responses can be trimmed server-side.** `pve_api`, `list_guests`,
`guest_status`, `node_status` and `list_tasks` all take `fields` and
`omit_fields`; the list-shaped ones also take `limit`, which keeps the most
recent entries. Trimming happens before the payload is serialised, so it is a
real saving rather than a display filter.

Where it matters most:

- A week of `rrddata` is ~330 points of ~20 metrics. Asking for
  `fields: ["time","mem","maxmem"]` cuts roughly 70%; adding `limit` takes it
  past 90%.
- Guest configs from community install scripts carry large HTML blobs in
  `description`. `omit_fields: ["description"]` removes ~96% of a config read.
- `list_guests` also takes `status: "running"` to skip stopped guests entirely.

Two things happen automatically, with no parameters:

- **`task_status` fetches the task log only when the task failed or is still
  running.** The log of a successful start is noise, and this is the most-called
  tool since every write returns a UPID. Pass `log: true` to force it.
- **Responses over 2000 characters drop JSON indentation**, worth about a third
  of a large payload. Smaller ones stay pretty-printed.
- **`run_script` output is capped at 40000 characters** (~10k tokens), cut from
  the middle so both ends survive, with a marker saying how much was dropped.
  Raise it per-call with `max_output` — but filtering on the host with `grep`,
  `tail -n` or `journalctl -n` is almost always better.

With the bridge installed you additionally get `run_script`:

- *"Check disk usage inside container 101."* — runs `df -h` via `pct exec`.
- *"Restart nginx in 101 and show me the last 20 log lines."*
- *"What kernel is the host on?"*

## Tools

| Tool | What it does |
|---|---|
| `list_guests` | Every VM and container with id, name, node, status, usage |
| `guest_status` | Runtime detail for one guest |
| `start_guest` / `shutdown_guest` / `stop_guest` | Lifecycle. `shutdown` is graceful, `stop` is a hard power cut |
| `list_snapshots` / `snapshot_guest` / `rollback_snapshot` | Snapshot create, list and revert |
| `list_nodes` / `node_status` | Host health: cpu, memory, load, uptime |
| `list_tasks` / `task_status` | Task history, and polling the UPIDs the write tools return |
| `pve_api` | Escape hatch to any other API endpoint, with guardrails |
| `run_script` | Bash on the host, in an LXC, or in a VM. Only registered once `EXEC_HOST` is set |
| `audit_log` | Search what has been done and who authenticated. Only registered once `AUDIT_DB` is bound |
| `get_settings` | The whole configuration surface: which secrets are set (never their values), and every editable setting |
| `update_settings` | Change a runtime setting without a deploy. Secrets are not reachable from here |

There is deliberately no tool for deleting a guest, a snapshot or a storage
volume. `pve_api` refuses `DELETE` outright, so destructive cleanup stays a
thing you do by hand in the Proxmox UI.

There is also no tool for deleting audit rows. Retention is the only thing that
removes them, and changing retention is itself logged.

---

## Prerequisites

Set these up before deploying:

- A Cloudflare Tunnel with a public hostname pointing at `https://localhost:8006`,
  with `noTLSVerify: true` — pveproxy uses a self-signed cert, so the tunnel
  must not try to validate it.
- A Cloudflare Access application on that hostname with a **service token only**
  policy, and a service token issued for it.
- A Proxmox API token (*Datacenter → Permissions → API Tokens*). `PVEVMAdmin`
  on `/vms` plus `PVEAuditor` on `/` covers everything these tools do without
  letting the token touch users or realms. Copy the secret when it is shown —
  Proxmox displays it exactly once.

Phase 2 needs a **second** tunnel hostname pointing at `http://localhost:5000`,
with its own Access application and service token.

## Deploy

This repo is wired for Cloudflare's git integration — pushing to `main` builds
and deploys automatically.

1. Create the KV namespace and put its id in `wrangler.toml`:
   ```bash
   npx wrangler kv namespace create PROXMOX_KV
   ```
   Do this **before** connecting the repo; a placeholder id fails the build.
   The namespace is **required** — `/oauth/authorize` and `/oauth/token` return
   500 without it rather than silently dropping the protections it backs. It
   holds three kinds of short-lived entry and nothing else: spent authorization
   codes, revoked access tokens, failed-password counters, and the settings blob.
2. Create the audit database and put its id in `wrangler.toml` the same way:
   ```bash
   npx wrangler d1 create proxmox-mcp-audit
   ```
   There is no schema step. The Worker carries the schema it expects and brings
   the database up to it on first use, so this is the only command. Also a
   placeholder that fails the build until filled in; unlike KV this one is
   optional, so comment the `[[d1_databases]]` block out to deploy without an
   audit log. See [The audit log](#the-audit-log).
3. In the Cloudflare dashboard: **Workers & Pages → Create → Workers → Import a
   repository**. Defaults are correct: build `npm install`, deploy
   `npx wrangler deploy`.
4. Set the secrets (dashboard **Settings → Variables and Secrets**, or CLI):
   ```bash
   npx wrangler secret put MCP_API_KEY              # password you'll type when connecting
   npx wrangler secret put PVE_HOST                 # https://your-tunnel-hostname (no trailing slash)
   npx wrangler secret put PVE_TOKEN                # user@realm!tokenid=uuid
   npx wrangler secret put CF_ACCESS_CLIENT_ID
   npx wrangler secret put CF_ACCESS_CLIENT_SECRET
   ```
   Secrets survive a git-triggered redeploy, which is why nothing lives in
   `[vars]` and no real hostname is committed anywhere in this repo.
5. Check it came up:
   ```bash
   curl https://proxmox-mcp-server.<subdomain>.workers.dev/health
   ```
   You want `"pve_configured": true` and, if you did step 2,
   `"audit_configured": true`. If a `/health` call returns HTML rather than
   JSON, Access rejected the service token.

### Connect it to Claude

In claude.ai: **Settings → Connectors → Add custom connector**, URL
`https://proxmox-mcp-server.<subdomain>.workers.dev/mcp`. You will be sent to an
authorize page — enter the `MCP_API_KEY` value. Only `claude.ai` and
`claude.com` redirect URIs are accepted.

Five wrong passwords from one IP locks that IP out for 15 minutes. The page is
public and the password behind it reaches `run_script`, so an unthrottled guess
was the cheapest way in.

### Revoking a token

Access tokens last 30 days. To kill one without rotating `MCP_API_KEY` (which
would invalidate every client and change the login password):

```bash
curl -X POST https://proxmox-mcp-server.<subdomain>.workers.dev/oauth/revoke \
  -d "password=$MCP_API_KEY&token=$TOKEN_TO_KILL"
```

A client can also revoke its own token by presenting it as a bearer token with
no password. Revocation is remembered until the token would have expired anyway.

### Phase 2 secrets

Add these once [proxmox-mcp-bridge](https://github.com/Leander-Andersen/proxmox-mcp-bridge)
is running. `run_script` does not appear in the tool list until `EXEC_HOST` exists,
so Phase 1 deploys cleanly on its own.

```bash
npx wrangler secret put EXEC_HOST                    # https://your-exec-hostname
npx wrangler secret put EXEC_CF_ACCESS_CLIENT_ID     # service token for the exec hostname
npx wrangler secret put EXEC_CF_ACCESS_CLIENT_SECRET
npx wrangler secret put EXEC_SHARED_SECRET           # must match the bridge
npx wrangler secret put EXEC_SUDO_PASSWORD           # OS password of the bridge user
npx wrangler secret put EXEC_SUDO_ENABLED            # "true" or "false"
```

**`EXEC_SUDO_ENABLED` is the kill switch.** Set it to anything other than
`"true"` and the Worker stops sending the sudo password at all, so scripts
targeting `host` run as the unprivileged bridge user. Claude is never told the
password and it never appears in a tool result. Flipping it takes effect on the
next request — no redeploy, no push.

## Configuration reference

Everything is a Worker **secret** — there are no `[vars]`. Secrets are the only
binding type that survives `wrangler deploy`, so a value set in the dashboard is
never silently reverted by an unrelated code push. `EXEC_SUDO_ENABLED` is a
secret for that reason alone, not because `"true"`/`"false"` is sensitive.

Set any of them with `npx wrangler secret put <NAME>`, or in the dashboard under
**Settings → Variables and Secrets**.

### Phase 1 — required

| Secret | What it is | Where it comes from |
|---|---|---|
| `MCP_API_KEY` | Password you type on the authorize page when adding the connector. Also the HMAC key for the bearer tokens the Worker issues. | You invent it. `openssl rand -hex 32` |
| `PVE_HOST` | Origin of the tunnel hostname in front of pveproxy `:8006`. No trailing slash, no `/api2/json`. | Your Cloudflare Tunnel |
| `PVE_TOKEN` | Full Proxmox API token, `user@realm!tokenid=uuid` — all three parts, not just the secret. | *Datacenter → Permissions → API Tokens* |
| `CF_ACCESS_CLIENT_ID` | Access service token id, ends in `.access`. | *Zero Trust → Access → Service Auth* |
| `CF_ACCESS_CLIENT_SECRET` | The secret half. Shown once. | ditto |

### Phase 2 — optional

`run_script` is not registered at all unless `EXEC_HOST` is set. Setting it
without the rest means Claude sees the tool and every call fails, so set them
together.

| Secret | What it is | Where it comes from |
|---|---|---|
| `EXEC_HOST` | Origin of the tunnel hostname in front of the bridge `:5000`. | Your Cloudflare Tunnel |
| `EXEC_CF_ACCESS_CLIENT_ID` | Service token for that hostname. Service tokens are account-level, so the Phase 1 pair may be reused — the token just has to be in that application's policy. | *Zero Trust → Access → Service Auth* |
| `EXEC_CF_ACCESS_CLIENT_SECRET` | ditto | ditto |
| `EXEC_SHARED_SECRET` | Second check behind Access. Must match the bridge. | `cat /etc/claude-exec.env` on the host |
| `EXEC_SUDO_ENABLED` | `"true"` lets `target: "host"` escalate with sudo. **Any other value, or absent, disables it.** | You choose |
| `EXEC_SUDO_PASSWORD` | OS password of the bridge user. Only read when `EXEC_SUDO_ENABLED` is exactly `"true"`; never returned in a tool result. | The password set by `install.sh --with-host-sudo` |

### Bindings

| Binding | Purpose |
|---|---|
| `PROXMOX_KV` | **Required.** Marks OAuth authorization codes as spent so one cannot be redeemed twice, holds the access-token revocation list, counts failed password attempts for lockout, and stores the settings blob and secret overrides. All auth entries expire on their own. The OAuth endpoints fail closed without it. |
| `AUDIT_DB` | Optional. D1 (SQLite) database holding the audit log. Without it the connector runs normally and records nothing. |

### Settings

Settings are policy, not credentials, so they live in KV and change without a
deploy. Read them with `get_settings`, change them with `update_settings`, or
edit the `settings:v1` entry by hand in the KV browser — it is seeded with every
key, pretty-printed, so there is nothing to guess at.

| Setting | Default | What it does |
|---|---|---|
| `audit_enabled` | `true` | Master switch for all audit writes |
| `audit_retention_days` | `365` | How long rows are kept. The nightly sweep deletes the rest |
| `audit_log_reads` | `true` | Whether read-only calls are logged. Mutations always are, regardless |
| `audit_max_field_chars` | `8000` | Per-field cap on stored arguments and results |

Values are edge-cached for 60 seconds, so a change takes up to a minute to apply
everywhere. A hand-edited blob is validated field by field: a typo in one
setting falls back to that setting's default and is named in the log, leaving
its neighbours alone. Rejecting the whole file over one bad number would
silently revert everything else, which is the worst possible answer to a typo.

### Overriding a secret from KV

Most secret-backed keys can also be supplied from the KV entry `config:v1`,
which wins over the deployed secret when present:

```
KV override  →  deployed secret  →  default
```

**An untouched deployment is unaffected.** Every failure mode — no entry, an
empty one, a corrupt one, an unreachable namespace, a blank value, an unknown
key — falls through to the deployed secret. A configuration layer that can take
the credentials away would be worse than not having one, so it is written to
degrade towards "carry on as before" in every case.

The entry is seeded with a self-describing template, so the KV browser shows you
what you may set:

```json
{
  "_readme": "Values here override the deployed Worker secrets. Leave a key out (or blank) to keep using the secret.",
  "PVE_HOST": "https://pve.example.com"
}
```

`GET /health` reports `overridden_from_kv` (names only), and `get_settings`
gives the `source` of every key — `kv`, `secret` or `unset` — so an override
left behind months ago is discoverable rather than mysterious.

Two limits, both deliberate:

**`MCP_API_KEY` cannot be overridden.** It is the HMAC signing key *and* what
authenticates the caller, so it cannot live behind a tool that requires
authentication. An attempt to set it in KV is ignored and logged.

**No secret-backed key is writable by a tool.** `update_settings` can only
change the four audit settings. The distinction is not editability but *who*
gets to edit: a human with dashboard access can already deploy code and rewrite
secrets, so a KV override grants them nothing new — whereas a tool write is
anything holding a connector token. That matters most for:

| | |
|---|---|
| `PVE_HOST`, `EXEC_HOST` | These name **where the credentials get sent**. A writable hostname means the next call delivers `PVE_TOKEN`, the Access service token, the exec shared secret and the sudo password to a server of someone else's choosing |
| `EXEC_SUDO_ENABLED` | The sudo kill switch. Tool-writable, the connector could grant itself root on the hypervisor |

Note also that KV is not an encrypted store — its values are readable from the
dashboard and the API, whereas Cloudflare Secrets are encrypted at rest and
never readable back. Overriding a hostname there costs nothing; putting a
password there is a real, if modest, downgrade. Credential values are never
shown by `get_settings` regardless of which layer they came from.

### Checking what is set

`GET /health` reports configuration state without exposing any value:

```json
{"status":"ok","version":"1.1.0","pve_configured":true,"exec_configured":true,
 "sudo_enabled":false,"overridden_from_kv":[],"audit_configured":true,"audit_schema_version":1}
```

`pve_configured` means `PVE_HOST` and `PVE_TOKEN` are both present, not that
they are correct — and it reflects the *resolved* value, so a KV override that
redirects the host shows up here rather than hiding behind the secret it
replaced. `exec_configured` reflects `EXEC_HOST` alone — it is what decides
whether `run_script` appears. `overridden_from_kv` names any key currently
coming from the override layer, never its value; an empty list means the
deployment is running purely on its deployed secrets. `audit_configured`
reflects `AUDIT_DB`, and is worth watching: an audit log that quietly stopped
being written looks exactly like a quiet week.

---

## The audit log

Every tool call and every authentication event is written to a D1 database —
which is SQLite, so you can query it from the connector, from the CLI, or by
downloading the file.

### Setting it up

```bash
npx wrangler d1 create proxmox-mcp-audit
```

Paste the returned id into `wrangler.toml` under `[[d1_databases]]`. That is the
whole setup — there is no schema command.

Until the id is filled in, `wrangler deploy` will reject the config. To run
without an audit log, comment the block out — the binding is optional in code.

### The schema applies itself

The schema lives in [`src/lib/migrate.ts`](src/lib/migrate.ts), not in `.sql`
files, because a Worker has no filesystem at runtime and can only apply what is
bundled with it. Keeping it in code means the deployed Worker always carries the
schema it expects, so "what the code wants" and "what the database has" can be
reconciled without anyone running a command.

A `schema_migrations` ledger records what has run. On the first audit write after
a deploy, anything missing is applied — each migration as a single batch, which
D1 runs in a transaction, so a migration either lands completely or not at all.
Several isolates can boot at once and all find the same work pending; the ledger's
primary key arbitrates, and the losers roll back cleanly.

To change the schema later, append to `MIGRATIONS` and deploy. Two rules:

1. **Never edit or renumber a migration that has shipped.** The ledger records
   ids, so editing one already applied means it silently never runs again — and
   databases created afterwards get a different schema from those created before.
   Fix mistakes by appending a new migration.
2. **Never assume a migration runs alone.**

### What is recorded

`tool_calls`, one row per call:

| | |
|---|---|
| **who** | `actor_nonce` (the bearer token's nonce), `client_id`, `ip`, `country`, `user_agent` |
| **what** | `tool`, `target`, `args_json`, `mutating`, `sudo` |
| **when** | `ts`, `duration_ms`, `request_id` |
| **result** | `status`, `result_json`, `error`, `upid`, plus `*_bytes` giving the true pre-cap size |

`sudo` is 1 only when a script actually ran as root **on the Proxmox host** —
`run_script` against `target: "host"` while the `EXEC_SUDO_ENABLED` kill switch
was on. Container and VM targets are 0: they run as root inside a guest, which
is a different blast radius, and conflating the two would make "show me
everything that touched the hypervisor as root" impossible to ask.

```sql
SELECT datetime(ts/1000,'unixepoch') AS at, actor_nonce, status, args_json
  FROM tool_calls WHERE sudo = 1 ORDER BY ts DESC;
```

`status` distinguishes three outcomes: `ok` ran and succeeded, `error` ran and
failed (or was refused by a tool's own guard), and `rejected` never ran at all
because the arguments failed their schema. That last one matters — a
`run_script` with a target crafted to dodge the regex is turned away before any
handler sees it, and would otherwise leave no trace.

`auth_events` covers the other half: `authorize_ok`, `authorize_fail`,
`authorize_lockout`, `token_issued`, `token_denied`, `token_replay`,
`revoke_ok`, `revoke_denied`, `access_denied`.

### On "who"

There is no user database — one shared password, and tokens carrying no subject
(see [`src/auth.ts`](src/auth.ts)). So the actor is the token's nonce: stable for
one authorization, up to 30 days. It becomes meaningful by joining:

```sql
SELECT c.ts, c.tool, c.target, c.status, a.ip AS authorized_from, a.ts AS authorized_at
  FROM tool_calls c
  LEFT JOIN auth_events a
    ON a.token_nonce = c.actor_nonce AND a.event = 'token_issued'
 WHERE c.mutating = 1
 ORDER BY c.ts DESC;
```

That distinguishes actors and traces each back to the moment and address that
authorized it. It does not give them names. For real names you would either
split `MCP_API_KEY` into labelled passwords or put Cloudflare Access in front of
`/mcp` and read the verified email from its JWT; the `actor_label` column is
already there, empty, for whichever you choose.

### Querying it

Through the connector, `audit_log` filters by time (`"24h"`, `"7d"`, an ISO
timestamp), tool, actor, target, status, mutating, sudo, and a full-text
`contains` across arguments and results. From the CLI:

```bash
npx wrangler d1 execute proxmox-mcp-audit --remote --command "SELECT datetime(ts/1000,'unixepoch') AS at, tool, target, status, actor_nonce FROM tool_calls WHERE mutating = 1 ORDER BY ts DESC LIMIT 20"
```

### What is not written down

- **Bearer tokens.** Only the nonce; the HMAC that makes a token work is dropped.
- **Argument values under secret-looking keys** — `password`, `secret`, `token`,
  `api_key` and friends — replaced with `[redacted]` before the insert.
- **The sudo password**, which never enters a tool's arguments in the first place.

`run_script` scripts are stored verbatim, on purpose: a shell audit log that
hides the command is worthless. Treat the database as being as sensitive as the
host it describes.

### Retention

A cron trigger sweeps nightly at 04:17 UTC, deleting anything older than
`audit_retention_days`. Deletes are chunked so a first sweep over a large table
cannot time out; whatever is left over is picked up the next night.

### Failure behaviour

Audit writes are fire-and-forget through `waitUntil`. They add nothing to
response latency, and a database that is down or unbound produces a
`console.error` — never a failed `stop_guest`. The trade is deliberate: an audit
log that can take the server down is a liability dressed as a control. Watch
`audit_configured` on `/health` if that trade bothers you.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in real values; it is gitignored
npm run dev
npm run typecheck
npm test
```

The local D1 needs no setup either — it builds its own schema on first write.
It lives under `.wrangler/state` and is queryable with
`wrangler d1 execute proxmox-mcp-audit --local --command "..."`. To fire the
retention sweep by hand, run `wrangler dev --test-scheduled` and hit
`http://127.0.0.1:8787/__scheduled?cron=17+4+*+*+*`.

`npm test` covers four areas, each defending a specific way of being silently
wrong:

- **Path handling** — that `node` cannot be anything but a DNS label, and that
  the read-only guard on `pve_api` inspects the same path Proxmox receives. Both
  were places where a crafted value reached `/access/*`; see the privilege model
  below.
- **The schema**, against real SQLite via `node:sqlite` rather than a mock,
  because the claims are claims about the database: that the DDL is valid, that a
  failed migration leaves nothing behind, and that two isolates racing to migrate
  the same database cannot corrupt it.
- **Settings and the override layer**, on the assumption both blobs get
  hand-edited: a typo in one field must not revert the others, and no way of
  breaking the override entry may cost the deployment its credentials.
- **The audit trail**, chiefly that decorating `registerTool` logs a call without
  changing it — driven through a real MCP client over the SDK's in-memory
  transport, because a wrapper that misread the handler signature would log the
  wrong thing and nobody would notice until the day the log was needed. These
  also write to real SQLite, since a mock would happily accept an `INSERT` whose
  columns had drifted from the schema.

The tunnel hostname is publicly reachable, so `wrangler dev` can talk to the
real Proxmox API. To call `/mcp` by hand you need a bearer token; mint one with
the same HMAC the Worker uses:

```bash
node -e 'const{createHmac,randomBytes}=require("crypto");const b=x=>x.toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");const p=`${Date.now()}.${b(randomBytes(12))}`;console.log(`${p}.${b(createHmac("sha256",process.argv[1]).update(`token:${p}`).digest())}`)' "$MCP_API_KEY"
```

```bash
curl -s localhost:8787/mcp -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Privilege model

Worth reading once rather than inferring, because the parts interact in ways
that are easy to get wrong.

### What the tool layer blocks

| Blocked | Where |
|---|---|
| `DELETE`, every path | `pve_api` — the only hard write-wall in the Worker |
| Non-GET to `/access/*` and `/cluster/config/*` | `pve_api`, checked against the **resolved** path |
| Any path escaping `/api2/json` | `PveClient`, for every tool |
| `node` that is not a DNS label | schema, and again in `resolveGuest`/`resolveNode` |
| Writes to `/etc/pve`, `rm -rf` on system paths, `mkfs`, `passwd`, reboots | `run_script` deny-list |

The last two exist because `node` and `path` are interpolated into API URLs, and
`new URL` collapses `..` while `fetch` discards anything after `#`. Before that
was constrained, a crafted `node` on `start_guest` — or a `..` in a `pve_api`
path — reached `POST /access/*` and could mint a Proxmox API token. `npm test`
holds that closed.

### What it deliberately does not block

- **`POST` and `PUT` to everything else.** These reach Proxmox and are gated by
  the **API token's role**, not by this Worker. If you widen that role, the
  Worker will not be what stops a destructive write.

  This is worth acting on rather than just knowing: scope `PVE_TOKEN` to the
  least role that does your job (`PVEVMAdmin` on `/vms` for lifecycle work,
  `PVEAuditor` on `/` for reads). A token that cannot touch `/access` makes the
  whole class of path bugs above unexploitable, whatever the Worker does.
- **Reads of `/etc/pve`.** The `run_script` guard is *write-scoped*. `ls` and
  `cat` pass — which is harmless, because the files inside are `root:www-data
  0640` and the unprivileged script account cannot read them anyway.
- **Arbitrary host commands.** The deny-list is a small blocklist of obviously
  destructive patterns. It does not reason about whether a command is harmful.
  `rm -f somefile` on the host runs and is stopped only by filesystem
  permissions.

### How privilege actually works

This is the part most often stated incorrectly. The bridge account is **not**
free of sudo rights:

```
claude ALL=(root)       NOPASSWD: /usr/sbin/pct exec *
claude ALL=(root)       NOPASSWD: /usr/sbin/qm guest exec *
claude ALL=(claude-run) NOPASSWD: ALL
```

The first two are **NOPASSWD**, so they apply *regardless of
`EXEC_SUDO_ENABLED`* — which is exactly why `run_script` gets root inside any
container while `/health` reports `sudo_enabled: false`. And `pct exec` into a
**privileged** container is a well-known route back to root on the host.

`EXEC_SUDO_ENABLED` governs one narrow thing: whether the Worker attaches a
password, which only affects `target: "host"`. It is not a global privilege
switch, and it does not gate container access.

What it *does* now do reliably is bound `target: "host"`. The third rule runs
unprivileged host scripts as `claude-run`, an account that owns nothing — so
with sudo disabled a host script can no longer read the bridge's shared secret,
rewrite its code, or wait around for you to enable sudo. Before that split it
ran as the bridge's own user and could do all three, which made the kill switch
a delay rather than a boundary. See the bridge repo's INSTALL.md.

If the host was installed with `--with-host-sudo`, the account is additionally
in the `sudo` group with a password — full root, password-gated.

Check what is actually granted rather than assuming:

```bash
sudo -l -U claude
```

### The real boundaries

In rough order of how much they carry:

1. **Cloudflare Access** on both tunnel hostnames — nothing reaches Proxmox
   without the service token.
2. **The PVE API token's role** — the ceiling on every API tool, and the only
   thing gating non-DELETE writes.
3. **The bridge user's sudoers file** — the ceiling on `run_script`. Broad by
   design, since `pct exec` is the whole point.
4. **The bearer token** on `/mcp`, HMAC-derived from `MCP_API_KEY`.
5. **`EXEC_SUDO_ENABLED`** — host-sudo only, per the caveat above.

Everything in "what the tool layer blocks" is a **speed bump, not a boundary**.
Those are pattern matches; a determined encoding walks through them. Set the API
token's role and the sudoers file as though the guardrails did not exist.

Nothing sensitive is committed here. Credentials live in Worker secrets, and
local values in `.dev.vars`, which is gitignored — `.dev.vars.example` shows
the shape with placeholders.
