import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Env } from "./env.js";
import { buildServer, SERVER_VERSION } from "./server.js";
import { actorFromRequest, actorFromToken, Auditor, sweepAuditLog } from "./lib/audit.js";
import { ensureSchemaOnce, SCHEMA_VERSION } from "./lib/migrate.js";
import { resolveConfig, seedConfigOverrides, type ResolvedConfig } from "./lib/config.js";
import { loadSettings, seedSettings, type Settings } from "./lib/settings.js";
import { sudoEnabled } from "./lib/exec-client.js";
import {
  authorizeLockedOut,
  authorizePage,
  clearAuthorizeFailures,
  generateAccessToken,
  generateAuthCode,
  isAllowedRedirectUri,
  LOCKOUT,
  oauthMetadata,
  recordAuthorizeFailure,
  revokeAccessToken,
  secretEqual,
  validateAccessToken,
  validateAuthCode,
} from "./auth.js";

const VERSION_HEADER = { "X-MCP-Server-Version": SERVER_VERSION };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...VERSION_HEADER },
  });
}

/**
 * The tool calls an MCP request is asking for, read straight off the JSON-RPC
 * body before the SDK gets a look at it.
 *
 * This is how a call that never reaches its handler still gets logged: the SDK
 * validates arguments against the tool's schema first, so a `run_script` with a
 * target crafted to dodge the regex is refused upstream of any decorator.
 * Comparing this list against what actually ran leaves nothing unaccounted for.
 */
function requestedToolCalls(body: unknown): Array<{ name: string; args: unknown }> {
  const messages = Array.isArray(body) ? body : [body];
  const calls: Array<{ name: string; args: unknown }> = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const { method, params } = message as { method?: unknown; params?: unknown };
    if (method !== "tools/call" || !params || typeof params !== "object") continue;
    const { name, arguments: args } = params as { name?: unknown; arguments?: unknown };
    if (typeof name === "string") calls.push({ name, args });
  }
  return calls;
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...VERSION_HEADER },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const baseUrl = `${url.protocol}//${url.host}`;

    // One id for the whole request, so several tool calls arriving in one MCP
    // POST can be recognised afterwards as having come in together.
    const requestId = crypto.randomUUID();
    // Memoised and lazy: most requests log nothing, and there is no reason for
    // /health or OAuth discovery to pay for a KV read.
    // Both memoised and lazy, for the same reason: most requests need neither,
    // and the OAuth endpoints in particular should not pay a KV read for
    // configuration they never look at.
    let settings: Promise<Settings> | undefined;
    let config: Promise<ResolvedConfig> | undefined;
    const currentSettings = () => (settings ??= loadSettings(env.PROXMOX_KV));
    const currentConfig = () => (config ??= resolveConfig(env, env.PROXMOX_KV));

    const audit = new Auditor(
      env.AUDIT_DB,
      ctx,
      actorFromRequest(request, requestId),
      currentSettings,
      // A thunk, so resolving the override layer is deferred to the first row
      // that actually needs it -- which is only ever a run_script call.
      async () => sudoEnabled((await currentConfig()).env),
    );

    if (url.pathname === "/health" && request.method === "GET") {
      // Resolved, so that health reflects what the Worker will actually use --
      // a KV override that redirects PVE_HOST should be visible here, not
      // hidden behind the secret it replaced.
      const { env: cfg, sources } = await currentConfig();
      const overridden = Object.entries(sources)
        .filter(([, source]) => source === "kv")
        .map(([key]) => key);

      return json({
        status: "ok",
        version: SERVER_VERSION,
        pve_configured: Boolean(cfg.PVE_HOST && cfg.PVE_TOKEN),
        exec_configured: Boolean(cfg.EXEC_HOST),
        sudo_enabled: cfg.EXEC_SUDO_ENABLED === "true",
        // Names only, never values. Says at a glance whether this deployment is
        // running purely on its deployed secrets or not.
        overridden_from_kv: overridden,
        // Surfaced so that an audit log which quietly stopped being written --
        // an unbound binding after a config change, say -- is noticeable
        // without having to go looking for missing rows.
        audit_configured: Boolean(env.AUDIT_DB),
        // The schema this build expects. The database brings itself up to it on
        // first use, so there is no version to compare against here -- this is
        // just what shipped.
        audit_schema_version: SCHEMA_VERSION,
      });
    }

    // --- OAuth discovery ---------------------------------------------------

    if (url.pathname === "/.well-known/oauth-authorization-server" && request.method === "GET") {
      return json(oauthMetadata(baseUrl));
    }

    if (
      (url.pathname === "/.well-known/oauth-protected-resource" ||
        url.pathname.startsWith("/.well-known/oauth-protected-resource/")) &&
      request.method === "GET"
    ) {
      return json({
        resource: baseUrl,
        authorization_servers: [baseUrl],
        bearer_methods_supported: ["header"],
      });
    }

    // --- Authorization -----------------------------------------------------

    if (url.pathname === "/oauth/authorize") {
      const apiKey = env.MCP_API_KEY;
      if (!apiKey) {
        return json(
          { error: "server_error", error_description: "MCP_API_KEY is not configured" },
          500,
        );
      }
      if (!env.PROXMOX_KV) {
        return json(
          {
            error: "server_error",
            error_description:
              "PROXMOX_KV is not bound. It is required for brute-force throttling and " +
              "single-use authorization codes; refusing to authorize without it.",
          },
          500,
        );
      }

      if (request.method === "GET") {
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        if (!isAllowedRedirectUri(redirectUri)) {
          return json(
            {
              error: "invalid_request",
              error_description: "redirect_uri is not on the allow-list (claude.ai / claude.com only)",
            },
            400,
          );
        }
        return html(
          authorizePage({
            redirectUri,
            state: url.searchParams.get("state") ?? "",
            codeChallenge: url.searchParams.get("code_challenge") ?? "",
            clientId: url.searchParams.get("client_id") ?? "",
          }),
        );
      }

      if (request.method === "POST") {
        const form = await request.formData();
        const str = (k: string) => String(form.get(k) ?? "");
        const redirectUri = str("redirect_uri");
        const state = str("state");
        const codeChallenge = str("code_challenge");
        const clientId = str("client_id");

        if (!isAllowedRedirectUri(redirectUri)) {
          return json({ error: "invalid_request", error_description: "redirect_uri not allowed" }, 400);
        }

        // Throttle before comparing, so a locked-out client cannot keep guessing.
        const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
        if (await authorizeLockedOut(env.PROXMOX_KV, ip)) {
          console.warn(`authorize: ${ip} is locked out after ${LOCKOUT.MAX_FAILURES} failures`);
          audit.authEvent("authorize_lockout", {
            clientId,
            detail: `locked out after ${LOCKOUT.MAX_FAILURES} failures`,
          });
          return new Response(
            `Too many failed attempts. Try again in ${LOCKOUT.LOCKOUT_SECONDS / 60} minutes.`,
            {
              status: 429,
              headers: { "Retry-After": String(LOCKOUT.LOCKOUT_SECONDS), ...VERSION_HEADER },
            },
          );
        }

        if (!(await secretEqual(str("password").trim(), apiKey.trim()))) {
          const count = await recordAuthorizeFailure(env.PROXMOX_KV, ip);
          console.warn(`authorize: bad password from ${ip} (${count}/${LOCKOUT.MAX_FAILURES})`);
          audit.authEvent("authorize_fail", {
            clientId,
            detail: `attempt ${count} of ${LOCKOUT.MAX_FAILURES}`,
          });
          return html(authorizePage({ redirectUri, state, codeChallenge, clientId, error: true }));
        }
        await clearAuthorizeFailures(env.PROXMOX_KV, ip);
        audit.authEvent("authorize_ok", { clientId, detail: `redirect_uri=${redirectUri}` });

        const code = await generateAuthCode(apiKey, codeChallenge, redirectUri);
        const redirect = new URL(redirectUri);
        redirect.searchParams.set("code", code);
        redirect.searchParams.set("state", state);
        return Response.redirect(redirect.toString(), 302);
      }

      return new Response("Method Not Allowed", { status: 405, headers: VERSION_HEADER });
    }

    // --- Token exchange ----------------------------------------------------

    if (url.pathname === "/oauth/token" && request.method === "POST") {
      const apiKey = env.MCP_API_KEY;
      if (!apiKey) return json({ error: "server_error" }, 500);
      if (!env.PROXMOX_KV) {
        return json(
          {
            error: "server_error",
            error_description:
              "PROXMOX_KV is not bound. It is required to enforce single-use authorization codes.",
          },
          500,
        );
      }

      // A malformed body used to throw out here, past the only try/catch in this
      // handler, and surface as an unhandled 500 rather than invalid_request.
      const contentType = request.headers.get("content-type") ?? "";
      let params: URLSearchParams;
      try {
        params = contentType.includes("application/json")
          ? new URLSearchParams(await request.json<Record<string, string>>())
          : new URLSearchParams(await request.text());
      } catch {
        return json(
          { error: "invalid_request", error_description: "Malformed request body" },
          400,
        );
      }

      if (params.get("grant_type") !== "authorization_code") {
        return json({ error: "unsupported_grant_type" }, 400);
      }

      const code = params.get("code") ?? "";
      const result = await validateAuthCode(
        apiKey,
        code,
        params.get("code_verifier") ?? "",
        params.get("redirect_uri") ?? "",
      );
      const tokenClientId = params.get("client_id") ?? undefined;
      if (!result.ok) {
        audit.authEvent("token_denied", {
          clientId: tokenClientId,
          detail: `${result.reason}${result.detail ? `: ${result.detail}` : ""}`,
        });
        return json(
          {
            error: "invalid_grant",
            error_description: `Invalid or expired authorization code (${result.reason})`,
          },
          400,
        );
      }

      // Authorization codes are single use; KV remembers the ones already spent.
      // This is still a check-then-set rather than an atomic one, so two truly
      // simultaneous redemptions can both win. Closing that properly needs a
      // Durable Object; the code's 5-minute lifetime bounds the exposure.
      const usedKey = `code-used:${result.nonce}`;
      if (await env.PROXMOX_KV.get(usedKey)) {
        audit.authEvent("token_replay", {
          clientId: tokenClientId,
          detail: `authorization code ${result.nonce} redeemed twice`,
        });
        return json(
          { error: "invalid_grant", error_description: "Authorization code already used" },
          400,
        );
      }
      await env.PROXMOX_KV.put(usedKey, "1", { expirationTtl: 300 });

      // This is the row that gives every later actor_nonce a meaning: it ties an
      // opaque token identifier to the IP, client and moment it was handed out.
      const accessToken = await generateAccessToken(apiKey);
      audit.authEvent("token_issued", {
        clientId: tokenClientId,
        tokenNonce: actorFromToken(accessToken).nonce,
        detail: "30 day lifetime",
      });

      return json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 30 * 24 * 60 * 60,
      });
    }

    // --- Revocation --------------------------------------------------------

    // Tokens are stateless HMACs with a 30-day life, so without this the only
    // way to invalidate one is rotating MCP_API_KEY -- which invalidates every
    // client and changes the login password. Revoking by password is the case
    // that actually matters: a token you need to kill is usually one you no
    // longer hold.
    if (url.pathname === "/oauth/revoke" && request.method === "POST") {
      const apiKey = env.MCP_API_KEY;
      if (!apiKey || !env.PROXMOX_KV) return json({ error: "server_error" }, 500);

      let form: URLSearchParams;
      try {
        const ct = request.headers.get("content-type") ?? "";
        form = ct.includes("application/json")
          ? new URLSearchParams(await request.json<Record<string, string>>())
          : new URLSearchParams(await request.text());
      } catch {
        return json({ error: "invalid_request" }, 400);
      }

      const bearer = (request.headers.get("Authorization") ?? "").startsWith("Bearer ")
        ? (request.headers.get("Authorization") as string).slice("Bearer ".length)
        : "";
      const password = form.get("password") ?? "";
      const target = form.get("token") || bearer;
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";

      if (password) {
        if (await authorizeLockedOut(env.PROXMOX_KV, ip)) {
          return json({ error: "too_many_requests" }, 429);
        }
        if (!(await secretEqual(password.trim(), apiKey.trim()))) {
          await recordAuthorizeFailure(env.PROXMOX_KV, ip);
          audit.authEvent("revoke_denied", { detail: "wrong password" });
          return json({ error: "invalid_client" }, 401);
        }
        await clearAuthorizeFailures(env.PROXMOX_KV, ip);
      } else if (!bearer || target !== bearer) {
        return json(
          {
            error: "invalid_client",
            error_description:
              "Present the token you are revoking as a Bearer token, or supply the password to " +
              "revoke an arbitrary one.",
          },
          401,
        );
      } else if (!(await validateAccessToken(apiKey, bearer, env.PROXMOX_KV))) {
        return json({ error: "invalid_token" }, 401);
      }

      if (!target) return json({ error: "invalid_request" }, 400);
      const revoked = await revokeAccessToken(apiKey, target, env.PROXMOX_KV);
      console.log(`revoke: ${revoked ? "accepted" : "rejected"} from ${ip}`);
      // Record which token died, not the token itself -- the nonce is what the
      // rest of the log is keyed on, so this closes out that actor's history.
      audit.authEvent(revoked ? "revoke_ok" : "revoke_denied", {
        tokenNonce: actorFromToken(target).nonce,
        detail: password ? "authorised by password" : "self-revoked with bearer token",
      });
      return json({ revoked });
    }

    // --- Everything below needs a bearer token -----------------------------

    const apiKey = env.MCP_API_KEY;
    if (!apiKey) return json({ error: "server_error" }, 500);

    const authHeader = request.headers.get("Authorization") ?? "";
    const unauthorized = (detail: string) =>
      new Response("Unauthorized", {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer realm="Proxmox MCP", error="${detail}"`,
          "WWW-Authenticate-Resource": `${baseUrl}/.well-known/oauth-protected-resource`,
          ...VERSION_HEADER,
        },
      });

    if (!authHeader.startsWith("Bearer ")) {
      audit.authEvent("access_denied", { detail: `no bearer token on ${url.pathname}` });
      return unauthorized("invalid_request");
    }
    if (!(await validateAccessToken(apiKey, authHeader.slice("Bearer ".length), env.PROXMOX_KV))) {
      // Expired, revoked or forged -- validateAccessToken deliberately does not
      // say which, and neither does this. The nonce is already on the row via
      // the actor context, which is enough to tell a revoked token being
      // retried from a stranger guessing.
      audit.authEvent("access_denied", { detail: `rejected token on ${url.pathname}` });
      return unauthorized("invalid_token");
    }

    if (url.pathname !== "/mcp" && url.pathname !== "/message") {
      return new Response("Not Found", { status: 404, headers: VERSION_HEADER });
    }
    if (!["GET", "POST", "DELETE"].includes(request.method)) {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET, POST, DELETE", ...VERSION_HEADER },
      });
    }

    let body: unknown;
    if (request.method === "POST") {
      try {
        body = await request.json();
      } catch {
        return new Response("Bad Request: invalid JSON", { status: 400, headers: VERSION_HEADER });
      }
    }

    try {
      // Resolved here and nowhere deeper: every tool, the PveClient and the exec
      // bridge all read their configuration off this object, so applying the
      // override layer once at the boundary means nothing downstream has to know
      // the layer exists.
      const { env: cfg } = await currentConfig();
      const server = buildServer(cfg, audit);
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(transport);
      const response = await transport.handleRequest(request, { parsedBody: body });

      // Responses are buffered (enableJsonResponse), so every handler that was
      // going to run has run by now. Anything the body asked for that did not
      // reach a handler was rejected before it -- record it as such, matching by
      // name so a batch where only some calls were valid is accounted for
      // one-for-one rather than all-or-nothing.
      const unhandled = [...audit.handled];
      for (const { name, args } of requestedToolCalls(body)) {
        const index = unhandled.indexOf(name);
        if (index >= 0) {
          unhandled.splice(index, 1);
        } else {
          audit.rejectedToolCall(name, args, "rejected before the handler ran (invalid arguments, or no such tool)");
        }
      }

      const headers = new Headers(response.headers);
      for (const [k, v] of Object.entries(VERSION_HEADER)) headers.set(k, v);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (error) {
      console.error("MCP request failed:", error);
      return new Response("Internal Server Error", { status: 500, headers: VERSION_HEADER });
    }
  },

  /**
   * Nightly retention sweep.
   *
   * Retention is a setting rather than a constant because "how long do I keep
   * this" is a policy question the operator owns -- see lib/settings.ts. The
   * sweep reads it fresh on every run, so shortening the window takes effect
   * the following night with no deploy.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        // Makes both KV entries appear in the dashboard browser on a deployment
        // where nobody has called get_settings yet -- an empty namespace says
        // nothing about what you are allowed to put in it.
        if (await seedSettings(env.PROXMOX_KV)) {
          console.log("settings: seeded settings:v1 with defaults");
        }
        if (await seedConfigOverrides(env.PROXMOX_KV)) {
          console.log("config: seeded config:v1 override template");
        }
      })(),
    );

    if (!env.AUDIT_DB) return;
    ctx.waitUntil(
      (async () => {
        // Also a second chance at the schema. The lazy path only runs when
        // something is actually logged, so on a quiet deployment this is what
        // notices a pending migration.
        const schema = await ensureSchemaOnce(env.AUDIT_DB!);
        if (schema.applied.length) {
          console.log(`audit schema: applied migrations ${schema.applied.join(", ")}`);
        }

        const settings = await loadSettings(env.PROXMOX_KV);
        if (!settings.audit_enabled) return;
        const swept = await sweepAuditLog(env.AUDIT_DB!, settings);
        console.log(
          `audit sweep: removed ${swept.tool_calls} tool calls and ${swept.auth_events} auth ` +
            `events older than ${new Date(swept.cutoff).toISOString()} ` +
            `(retention ${settings.audit_retention_days}d)` +
            (swept.incomplete ? " -- hit the per-run batch limit, continuing tomorrow" : ""),
        );
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
