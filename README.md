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

There is deliberately no tool for deleting a guest, a snapshot or a storage
volume. `pve_api` refuses `DELETE` outright, so destructive cleanup stays a
thing you do by hand in the Proxmox UI.

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
   The namespace does one job — stopping an OAuth authorization code from being
   redeemed twice. It holds nothing else, and entries expire after 5 minutes.
2. In the Cloudflare dashboard: **Workers & Pages → Create → Workers → Import a
   repository**. Defaults are correct: build `npm install`, deploy
   `npx wrangler deploy`.
3. Set the secrets (dashboard **Settings → Variables and Secrets**, or CLI):
   ```bash
   npx wrangler secret put MCP_API_KEY              # password you'll type when connecting
   npx wrangler secret put PVE_HOST                 # https://your-tunnel-hostname (no trailing slash)
   npx wrangler secret put PVE_TOKEN                # user@realm!tokenid=uuid
   npx wrangler secret put CF_ACCESS_CLIENT_ID
   npx wrangler secret put CF_ACCESS_CLIENT_SECRET
   ```
   Secrets survive a git-triggered redeploy, which is why nothing lives in
   `[vars]` and no real hostname is committed anywhere in this repo.
4. Check it came up:
   ```bash
   curl https://proxmox-mcp-server.<subdomain>.workers.dev/health
   ```
   You want `"pve_configured": true`. If a `/health` call returns HTML rather
   than JSON, Access rejected the service token.

### Connect it to Claude

In claude.ai: **Settings → Connectors → Add custom connector**, URL
`https://proxmox-mcp-server.<subdomain>.workers.dev/mcp`. You will be sent to an
authorize page — enter the `MCP_API_KEY` value. Only `claude.ai` and
`claude.com` redirect URIs are accepted.

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
| `PROXMOX_KV` | Marks OAuth authorization codes as spent so one cannot be redeemed twice. Entries expire after 5 minutes. Optional — without it the connector still works, you just lose replay protection. |

### Checking what is set

`GET /health` reports configuration state without exposing any value:

```json
{"status":"ok","version":"1.0.0","pve_configured":true,"exec_configured":true,"sudo_enabled":false}
```

`pve_configured` means `PVE_HOST` and `PVE_TOKEN` are both present, not that
they are correct. `exec_configured` reflects `EXEC_HOST` alone — it is what
decides whether `run_script` appears.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in real values; it is gitignored
npm run dev
npm run typecheck
```

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

## What is and isn't a security boundary

Real boundaries:

- **Cloudflare Access** in front of both tunnel hostnames — nothing reaches
  Proxmox without the service token.
- **The bearer token** on `/mcp`, derived by HMAC from `MCP_API_KEY`.
- **The PVE API token's role** — the ceiling on what the API tools can do.
- **The bridge user's sudoers file** and **`EXEC_SUDO_ENABLED`**.

Convenience only, not boundaries:

- The `pve_api` guardrails (no `DELETE`, no writes to `/access` or
  `/cluster/config`) and the `run_script` deny-list. They stop an obvious
  mistake; they are pattern matches and will not stop a determined encoding.
  **Set the API token's permissions as though these did not exist.**

Nothing sensitive is committed here. Credentials live in Worker secrets, and
local values in `.dev.vars`, which is gitignored — `.dev.vars.example` shows
the shape with placeholders.
