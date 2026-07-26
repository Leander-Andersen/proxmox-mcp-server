import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "../env.js";
import { callExecBridge, sudoEnabled } from "../lib/exec-client.js";
import { clampOutput } from "../lib/project.js";
import { fail, run } from "../lib/result.js";

/**
 * Roughly 10k tokens. The bridge caps at 200k characters, which is a quarter of
 * a context window from one command -- generous for real output, ruinous for an
 * unbounded `journalctl`. Raise per-call with max_output when that is genuinely
 * what you want.
 */
const DEFAULT_MAX_OUTPUT = 40_000;

/**
 * Best-effort screen for scripts that are almost certainly a mistake.
 *
 * This is a speed bump, not a security boundary -- any determined encoding
 * (base64, variable splicing, a here-doc) walks straight through it. The real
 * boundaries are the bridge user's sudoers file, the EXEC_SUDO_ENABLED kill
 * switch, and Cloudflare Access sitting in front of the tunnel.
 */
/**
 * Matches the start of a command rather than a bare word, so that reading
 * /etc/passwd or grepping logs for "reboot" is not mistaken for running them.
 */
const CMD = String.raw`(?:^|\n|[;&|(]\s*|\$\()\s*(?:sudo\s+(?:-\S+\s+)*)?`;
const cmd = (pattern: string) => new RegExp(CMD + pattern, "m");

const DENIED: Array<{ re: RegExp; reason: string }> = [
  { re: cmd(String.raw`rm\s+(?:-\S+\s+)*\/\s*(?:$|[;&|])`), reason: "rm targeting /" },
  {
    re: cmd(String.raw`rm\s+(?:-\S+\s+)*\/(?:etc|usr|bin|sbin|lib|lib64|boot|dev|proc|sys|var|root)\b`),
    reason: "rm targeting a system directory",
  },
  {
    re: cmd(String.raw`(?:passwd|chpasswd|usermod\s+[^\n]*-p\b)`),
    reason: "changing account passwords",
  },
  {
    re: cmd(String.raw`chmod\s+(?:-\S+\s+)*777\s+\/(?:etc|usr|bin|sbin|lib|boot|var|root|dev)\b`),
    reason: "chmod 777 on a system path",
  },
  {
    re: /(?:>|>>|\btee\b|\bcp\b|\bmv\b|\brm\b|\bsed\s+-i\b|\btruncate\b)[^\n]*\/etc\/pve\b/,
    reason: "writing to /etc/pve (the Proxmox cluster filesystem)",
  },
  { re: cmd(String.raw`mkfs(?:\.\w+)?\b`), reason: "formatting a filesystem" },
  { re: /\bdd\b[^\n]*\bof=\/dev\//, reason: "writing raw blocks to a device" },
  {
    re: cmd(String.raw`(?:shutdown|reboot|halt|poweroff|init\s+0\b)`),
    reason: "powering off or rebooting the host",
  },
];

function screen(script: string): string | null {
  for (const { re, reason } of DENIED) {
    if (re.test(script)) return reason;
  }
  return null;
}

export function registerExecTool(server: McpServer, env: Env): void {
  server.registerTool(
    "run_script",
    {
      title: "Run a shell script",
      description:
        "Run a bash script on the Proxmox host or inside a guest. Targets: 'host' for the Proxmox " +
        "node itself, 'lxc:<vmid>' for a container (runs as root via pct exec), or 'vm:<vmid>' for a " +
        "QEMU VM (requires the guest agent). Returns stdout, stderr and the exit code. " +
        (sudoEnabled(env)
          ? "Sudo is currently ENABLED for the 'host' target."
          : "Sudo is currently DISABLED, so 'host' scripts run unprivileged."),
      inputSchema: {
        target: z
          .string()
          .regex(
            /^(?:host|lxc:\d+|vm:\d+)$/,
            "target must be 'host', 'lxc:<vmid>' or 'vm:<vmid>'",
          )
          .describe("Where to run: 'host', 'lxc:<vmid>' or 'vm:<vmid>'."),
        script: z.string().min(1).describe("Bash script. Multiple lines are fine."),
        timeout: z
          .number()
          .int()
          .positive()
          .max(300)
          .optional()
          .describe("Seconds before the script is killed. Default 30."),
        max_output: z
          .number()
          .int()
          .positive()
          .max(200_000)
          .optional()
          .describe(
            "Characters of stdout/stderr to keep, default 40000. Output beyond this is cut from " +
              "the middle, keeping both ends. Prefer filtering on the host (grep, tail -n, " +
              "journalctl -n) over raising this.",
          ),
      },
    },
    async ({ target, script, timeout, max_output }) => {
      const reason = screen(script);
      if (reason) {
        return fail(
          `Refused to run this script: it looks like ${reason}. If that is genuinely what you want, ` +
            `run it directly on the host instead.`,
        );
      }

      console.log(`run_script target=${target} sudo=${sudoEnabled(env)} bytes=${script.length}`);

      return run(async () => {
        const result = await callExecBridge(env, { target, script, timeout: timeout ?? 30 });
        const cap = max_output ?? DEFAULT_MAX_OUTPUT;
        const clamped = {
          ...result,
          stdout: clampOutput(result.stdout ?? "", cap),
          stderr: clampOutput(result.stderr ?? "", cap),
        };
        if (clamped.timed_out) {
          return { ...clamped, note: `Script exceeded its ${timeout ?? 30}s timeout and was killed.` };
        }
        return clamped;
      });
    },
  );
}
