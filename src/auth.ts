/**
 * Minimal OAuth 2.1 + PKCE authorization server, just enough for claude.ai's
 * custom-connector flow. There is no user database: the single shared password
 * (MCP_API_KEY) both authenticates the human at /oauth/authorize and acts as
 * the HMAC key for the codes and tokens issued afterwards.
 */

const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ALLOWED_REDIRECT_HOSTS = new Set(["claude.ai", "claude.com"]);

export function isAllowedRedirectUri(uri: string): boolean {
  if (!uri) return false;
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  if (ALLOWED_REDIRECT_HOSTS.has(host)) return true;
  for (const allowed of ALLOWED_REDIRECT_HOSTS) {
    if (host.endsWith("." + allowed)) return true;
  }
  return false;
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function b64urlDecode(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

async function hmacSign(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return b64url(new Uint8Array(sig));
}

async function hmacVerify(secret: string, message: string, sig: string): Promise<boolean> {
  return constantTimeEqual(await hmacSign(secret, message), sig);
}

function randomNonce(): string {
  return b64url(crypto.getRandomValues(new Uint8Array(12)));
}

export async function generateAuthCode(
  secret: string,
  codeChallenge: string,
  redirectUri: string,
): Promise<string> {
  const visible = `${Date.now()}.${randomNonce()}.${b64url(new TextEncoder().encode(codeChallenge))}`;
  return `${visible}.${await hmacSign(secret, `code:${visible}|${redirectUri}`)}`;
}

export type AuthCodeResult =
  | { ok: true; nonce: string }
  | { ok: false; reason: string; detail?: string };

export async function validateAuthCode(
  secret: string,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<AuthCodeResult> {
  try {
    const parts = code.split(".");
    if (parts.length !== 4) {
      return { ok: false, reason: "malformed", detail: `expected 4 parts, got ${parts.length}` };
    }
    const [ts, nonce, cc, sig] = parts;
    const age = Date.now() - parseInt(ts, 10);
    if (!Number.isFinite(age) || age > AUTH_CODE_TTL_MS) {
      return { ok: false, reason: "expired", detail: `${Math.round(age / 1000)}s old` };
    }
    const visible = `${ts}.${nonce}.${cc}`;
    if (!(await hmacVerify(secret, `code:${visible}|${redirectUri}`, sig))) {
      return { ok: false, reason: "hmac_mismatch" };
    }
    const verifierHash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(codeVerifier),
    );
    const computed = b64url(new Uint8Array(verifierHash));
    const expected = new TextDecoder().decode(b64urlDecode(cc));
    if (!constantTimeEqual(computed, expected)) {
      return { ok: false, reason: "pkce_mismatch" };
    }
    return { ok: true, nonce };
  } catch (e) {
    return { ok: false, reason: "exception", detail: String(e) };
  }
}

export async function generateAccessToken(secret: string): Promise<string> {
  const payload = `${Date.now()}.${randomNonce()}`;
  return `${payload}.${await hmacSign(secret, `token:${payload}`)}`;
}

export async function validateAccessToken(secret: string, token: string): Promise<boolean> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const [ts, nonce, sig] = parts;
    const age = Date.now() - parseInt(ts, 10);
    if (!Number.isFinite(age) || age > ACCESS_TOKEN_TTL_MS) return false;
    return hmacVerify(secret, `token:${ts}.${nonce}`, sig);
  } catch {
    return false;
  }
}

export function oauthMetadata(baseUrl: string) {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
  };
}

export function authorizePage(params: {
  redirectUri: string;
  state: string;
  codeChallenge: string;
  clientId: string;
  error?: boolean;
}): string {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => entities[c]);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Proxmox MCP &mdash; Authorize</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
      background: #f3f4f6; font-family: system-ui, sans-serif;
    }
    .card {
      background: #fff; border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,.1);
      padding: 2rem; width: 360px; max-width: 90vw;
    }
    h1 { font-size: 1.25rem; margin: 0 0 .5rem; color: #111; }
    p  { color: #555; font-size: .9rem; margin: 0 0 1.5rem; }
    .error { color: #dc2626; font-size: .85rem; margin-bottom: 1rem; }
    label { font-size: .85rem; font-weight: 600; color: #374151; }
    input[type=password] {
      display: block; width: 100%; margin: .4rem 0 1.25rem;
      padding: .6rem .75rem; border: 1px solid #d1d5db;
      border-radius: 6px; font-size: 1rem;
    }
    input[type=password]:focus { outline: none; border-color: #e07000; box-shadow: 0 0 0 3px rgba(224,112,0,.15); }
    button {
      width: 100%; padding: .7rem;
      background: #e07000; color: #fff; border: none;
      border-radius: 6px; font-size: 1rem; font-weight: 600;
      cursor: pointer;
    }
    button:hover { background: #c46200; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Proxmox MCP</h1>
    <p>Claude is requesting access to your Proxmox host. Enter your MCP access password to authorize.</p>
    ${params.error ? '<p class="error">Incorrect password &mdash; try again.</p>' : ""}
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="redirect_uri"   value="${esc(params.redirectUri)}" />
      <input type="hidden" name="state"          value="${esc(params.state)}" />
      <input type="hidden" name="code_challenge" value="${esc(params.codeChallenge)}" />
      <input type="hidden" name="client_id"      value="${esc(params.clientId)}" />
      <label for="pw">Access Password</label>
      <input type="password" id="pw" name="password" autofocus autocomplete="current-password" />
      <button type="submit">Authorize</button>
    </form>
  </div>
</body>
</html>`;
}
