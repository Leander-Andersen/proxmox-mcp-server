# Proxmox MCP — Worker

A Cloudflare Worker that exposes a Proxmox VE host to Claude over MCP. It talks
to the Proxmox REST API for everything structured, and to a small [exec
bridge](../Client) for running shell scripts on the host or inside guests.

```
Claude (claude.ai connector)
    |  MCP over HTTPS, bearer token
proxmox-mcp Worker
    |  + CF-Access service token headers
Cloudflare Access  ->  Cloudflare Tunnel  ->  Proxmox host
                                              |- pveproxy :8006   (REST API)
                                              '- exec bridge :5000 (shell)
```

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

`node` and `type` are optional everywhere — the Worker resolves them from the
vmid via `/cluster/resources`, so single-node users never type them, and cluster
users can still pass `node` explicitly to disambiguate.

## Prerequisites

Set these up before deploying:

- A Cloudflare Tunnel with a public hostname for `https://localhost:8006`
  (`noTLSVerify: true`, since pveproxy uses a self-signed cert).
- A Cloudflare Access application on that hostname with a **service token only**
  policy, and a service token issued for it.
- A Proxmox API token (`Datacenter -> Permissions -> API Tokens`) with a role
  covering what you want Claude to do. `PVEVMAdmin` on `/vms` plus `PVEAuditor`
  on `/` is a reasonable start.

## Deploy

This repo is wired for Cloudflare's git integration — pushing to `main`
builds and deploys automatically.

1. Push this directory to its own GitHub repo.
2. In the Cloudflare dashboard (**Leander.yeboy@outlook.com's account**):
   **Workers & Pages -> Create -> Workers -> Import a repository**, pick the
   repo, and accept the defaults (build `npm install`, deploy `npx wrangler deploy`).
3. Create the KV namespace and paste its id into `wrangler.toml`:
   ```bash
   npx wrangler kv namespace create PROXMOX_KV
   ```
   This is only used to stop an OAuth authorization code being redeemed twice.
4. Set the secrets (dashboard **Settings -> Variables and Secrets**, or CLI):
   ```bash
   npx wrangler secret put MCP_API_KEY              # password you'll type when connecting
   npx wrangler secret put PVE_HOST                 # https://pve-api.example.com
   npx wrangler secret put PVE_TOKEN                # user@realm!tokenid=uuid
   npx wrangler secret put CF_ACCESS_CLIENT_ID
   npx wrangler secret put CF_ACCESS_CLIENT_SECRET
   ```
   Secrets survive a git-triggered redeploy, which is why nothing lives in
   `[vars]`.
5. Check it came up:
   ```bash
   curl https://proxmox-mcp.<subdomain>.workers.dev/health
   ```

### Connect it to Claude

In claude.ai: **Settings -> Connectors -> Add custom connector**, URL
`https://proxmox-mcp.<subdomain>.workers.dev/mcp`. You will be sent to an
authorize page; enter the `MCP_API_KEY` value. Only `claude.ai` and
`claude.com` redirect URIs are accepted.

### Phase 2 secrets

Add these once the [exec bridge](../Client) is running. `run_script` does not
appear in the tool list until `EXEC_HOST` exists.

```bash
npx wrangler secret put EXEC_HOST                    # https://pve-exec.example.com
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

- The `pve_api` guardrails (no DELETE, no writes to `/access` or
  `/cluster/config`) and the `run_script` deny-list. They stop an obvious
  mistake; they are pattern matches and will not stop a determined encoding.
  Set the API token's permissions as though these did not exist.
