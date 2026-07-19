import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Env } from "./env.js";
import { buildServer, SERVER_VERSION } from "./server.js";
import {
  authorizePage,
  constantTimeEqual,
  generateAccessToken,
  generateAuthCode,
  isAllowedRedirectUri,
  oauthMetadata,
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

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...VERSION_HEADER },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const baseUrl = `${url.protocol}//${url.host}`;

    if (url.pathname === "/health" && request.method === "GET") {
      return json({
        status: "ok",
        version: SERVER_VERSION,
        pve_configured: Boolean(env.PVE_HOST && env.PVE_TOKEN),
        exec_configured: Boolean(env.EXEC_HOST),
        sudo_enabled: env.EXEC_SUDO_ENABLED === "true",
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

        if (!constantTimeEqual(str("password").trim(), apiKey.trim())) {
          return html(authorizePage({ redirectUri, state, codeChallenge, clientId, error: true }));
        }

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

      const contentType = request.headers.get("content-type") ?? "";
      const params = contentType.includes("application/json")
        ? new URLSearchParams(await request.json<Record<string, string>>())
        : new URLSearchParams(await request.text());

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
      if (!result.ok) {
        return json(
          {
            error: "invalid_grant",
            error_description: `Invalid or expired authorization code (${result.reason})`,
          },
          400,
        );
      }

      // Authorization codes are single use; KV remembers the ones already spent.
      if (env.PROXMOX_KV) {
        const usedKey = `code-used:${result.nonce}`;
        if (await env.PROXMOX_KV.get(usedKey)) {
          return json(
            { error: "invalid_grant", error_description: "Authorization code already used" },
            400,
          );
        }
        await env.PROXMOX_KV.put(usedKey, "1", { expirationTtl: 300 });
      }

      return json({
        access_token: await generateAccessToken(apiKey),
        token_type: "Bearer",
        expires_in: 30 * 24 * 60 * 60,
      });
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

    if (!authHeader.startsWith("Bearer ")) return unauthorized("invalid_request");
    if (!(await validateAccessToken(apiKey, authHeader.slice("Bearer ".length)))) {
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
      const server = buildServer(env);
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(transport);
      const response = await transport.handleRequest(request, { parsedBody: body });

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
} satisfies ExportedHandler<Env>;
