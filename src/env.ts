export interface Env {
  /** Password accepted on the /oauth/authorize page; also the HMAC signing key. */
  MCP_API_KEY: string;

  /** Tunnel hostname fronting pveproxy :8006, no trailing slash. */
  PVE_HOST: string;
  /** PVE API token: user@realm!tokenid=uuid */
  PVE_TOKEN: string;
  CF_ACCESS_CLIENT_ID: string;
  CF_ACCESS_CLIENT_SECRET: string;

  /** Phase 2. When unset, run_script is not registered. */
  EXEC_HOST?: string;
  EXEC_CF_ACCESS_CLIENT_ID?: string;
  EXEC_CF_ACCESS_CLIENT_SECRET?: string;
  EXEC_SHARED_SECRET?: string;
  EXEC_SUDO_PASSWORD?: string;
  /** "true" enables sudo for target: "host". Anything else disables it. */
  EXEC_SUDO_ENABLED?: string;

  /**
   * Required. Backs one-time use of authorization codes, the token revocation
   * deny-list, brute-force throttling on /oauth/authorize, and the runtime
   * settings blob. It used to be optional, which meant a deployment without it
   * silently lost replay protection; the endpoints now fail closed instead.
   */
  PROXMOX_KV: KVNamespace;

  /**
   * The audit log: a D1 (SQLite) database recording every tool call and every
   * authentication event.
   *
   * Optional, and deliberately so. Logging is a control on top of the server,
   * not a dependency of it -- an unbound database means no audit trail, not a
   * connector that refuses to start. /health reports whether it is bound, so
   * losing it is visible rather than silent.
   */
  AUDIT_DB?: D1Database;
}
