import type { Env } from "../env.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  runtime_ms?: number;
  timed_out?: boolean;
}

export interface ExecRequest {
  target: string;
  script: string;
  timeout: number;
}

/** True when the bridge is configured; run_script is only registered if so. */
export function execConfigured(env: Env): boolean {
  return Boolean(env.EXEC_HOST);
}

export function sudoEnabled(env: Env): boolean {
  return env.EXEC_SUDO_ENABLED === "true";
}

/**
 * Posts a script to the exec bridge running on the Proxmox host.
 *
 * The sudo password is attached here and nowhere else: it is only sent when
 * EXEC_SUDO_ENABLED is exactly "true", and it never appears in a tool result.
 */
export async function callExecBridge(env: Env, req: ExecRequest): Promise<ExecResult> {
  if (!env.EXEC_HOST) {
    throw new Error("The exec bridge is not configured (EXEC_HOST is unset).");
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.EXEC_CF_ACCESS_CLIENT_ID && env.EXEC_CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = env.EXEC_CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = env.EXEC_CF_ACCESS_CLIENT_SECRET;
  }
  if (env.EXEC_SHARED_SECRET) headers["X-Exec-Token"] = env.EXEC_SHARED_SECRET;

  const body = {
    target: req.target,
    script: req.script,
    timeout: req.timeout,
    sudo_password: sudoEnabled(env) ? env.EXEC_SUDO_PASSWORD : undefined,
  };

  const base = env.EXEC_HOST.replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}/exec`, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (e) {
    // The runtime redacts the underlying message, so say something useful.
    throw new Error(
      `Could not reach the exec bridge at ${base} -- the request failed before any response came ` +
        `back. Check that the bridge service is running on the Proxmox host and that the tunnel is up. ` +
        `(${e instanceof Error ? e.message : String(e)})`,
    );
  }
  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Exec bridge returned ${res.status}: ${text.slice(0, 800)}`);
  }
  try {
    return JSON.parse(text) as ExecResult;
  } catch {
    throw new Error(
      `Exec bridge returned non-JSON (${res.status}). This usually means CF Access rejected the ` +
        `request. Body: ${text.slice(0, 300)}`,
    );
  }
}
