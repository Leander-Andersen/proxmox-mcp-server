/**
 * One declaration of every knob this Worker has, and where each one lives.
 *
 * The point is that "what can I configure?" should have a single answer you can
 * ask for, rather than being spread across wrangler.toml, a README table, and
 * whatever someone remembers typing into `wrangler secret put` months ago.
 *
 * The split between the two storage kinds is not stylistic, and it is the part
 * worth understanding:
 *
 *   storage: "secret"  Cloudflare Secrets. Encrypted at rest, write-only from
 *                      the dashboard, never readable back. Read from env and
 *                      nothing else. This code will report whether one is set;
 *                      it will never show or change its value.
 *
 *   storage: "kv"      The settings blob in KV. Readable and editable -- by the
 *                      dashboard, by the API, and by anyone holding a token for
 *                      this connector. Fine for policy. Ruinous for anything
 *                      that decides *who* the Worker trusts.
 *
 * On top of that sits an override layer: `config:v1` in KV can supply a value
 * for most secret-backed keys, and it wins when present. The resolution order is
 *
 *     KV override  ->  deployed secret  ->  default
 *
 * so a deployment that has never written to KV behaves exactly as it did before
 * any of this existed. That is the guarantee worth preserving: adding the layer
 * cannot break a working install, because an absent override changes nothing.
 * Every failure mode -- KV unreachable, blob corrupt, value blank -- falls back
 * to the secret rather than to nothing.
 *
 * `overridable` and `toolWritable` are separate on purpose. Editing KV by hand
 * requires dashboard access, and someone with that can already deploy code and
 * rewrite secrets, so the override grants them nothing new. A *tool* write is
 * different: that is anything holding a connector token. So the hostnames and
 * the sudo switch can be overridden by a human and not by a tool -- see
 * `why_secret` on each entry.
 */

import type { Env } from "../env.js";
import { DEFAULT_SETTINGS, type Settings } from "./settings.js";

export interface ConfigEntry {
  key: string;
  description: string;
  storage: "secret" | "kv";
  required: boolean;
  group: "core" | "proxmox" | "exec" | "audit";

  /**
   * Whether a KV entry may take precedence over the deployed secret.
   *
   * The resolution order is KV, then the secret, then the default -- so a
   * deployment that has never touched KV behaves exactly as it did before this
   * existed. Nothing breaks by adding the layer; something only changes when a
   * value is deliberately put in KV.
   */
  overridable: boolean;

  /**
   * Whether update_settings may change it.
   *
   * This is the line that matters, and it is not the same as `overridable`.
   * Being editable by a human with dashboard access is fine -- that person can
   * already deploy code and rewrite secrets, so KV grants them nothing new.
   * Being editable by *a tool* is different: that is anything holding a
   * connector token. Which is why the hostnames and the sudo switch are
   * overridable but not tool-writable.
   */
  toolWritable: boolean;

  /**
   * Whether the resolved value must never be shown. Hostnames and flags are
   * safe to display to an authenticated caller and useful for debugging;
   * credentials are reported as set/unset and nothing more.
   */
  sensitive: boolean;

  /** Present on secrets: why this one is not tool-writable. */
  why_secret?: string;
  /** Present on KV entries: the value used when nothing is set. */
  default?: string | number | boolean;
}

export const CONFIG: ConfigEntry[] = [
  {
    key: "MCP_API_KEY",
    overridable: false,
    toolWritable: false,
    sensitive: true,
    description: "Password typed on the authorize page, and the HMAC key for every token issued.",
    storage: "secret",
    required: true,
    group: "core",
    why_secret:
      "It is the signing key. Anything that can read it can mint valid tokens; anything that can " +
      "write it can replace the lock. It is also needed to authenticate a caller in the first " +
      "place, so it could never be edited through an authenticated tool anyway.",
  },
  {
    key: "PVE_HOST",
    overridable: true,
    toolWritable: false,
    sensitive: false,
    description: "Origin of the tunnel hostname in front of pveproxy :8006.",
    storage: "secret",
    required: true,
    group: "proxmox",
    why_secret:
      "This is the address the Proxmox API token is sent to. Rewriting it points the connector at " +
      "a server of the attacker's choosing, which then receives PVE_TOKEN and the Access service " +
      "token on the very next call. Not secret in the sense of being confidential -- secret in the " +
      "sense that being able to change it is equivalent to stealing the credentials.",
  },
  {
    key: "PVE_TOKEN",
    overridable: true,
    toolWritable: false,
    sensitive: true,
    description: "Proxmox API token, user@realm!tokenid=uuid.",
    storage: "secret",
    required: true,
    group: "proxmox",
    why_secret: "It is the credential.",
  },
  {
    key: "CF_ACCESS_CLIENT_ID",
    overridable: true,
    toolWritable: false,
    sensitive: false,
    description: "Cloudflare Access service token id for the Proxmox hostname.",
    storage: "secret",
    required: true,
    group: "proxmox",
    why_secret: "Half of a credential pair; useless alone but pointless to separate.",
  },
  {
    key: "CF_ACCESS_CLIENT_SECRET",
    overridable: true,
    toolWritable: false,
    sensitive: true,
    description: "The secret half of that pair.",
    storage: "secret",
    required: true,
    group: "proxmox",
    why_secret: "It is the credential.",
  },
  {
    key: "EXEC_HOST",
    overridable: true,
    toolWritable: false,
    sensitive: false,
    description: "Origin of the tunnel hostname in front of the exec bridge :5000. Absent disables run_script entirely.",
    storage: "secret",
    required: false,
    group: "exec",
    why_secret:
      "Same reasoning as PVE_HOST, and worse: this is where the shared secret and the sudo " +
      "password are sent. It also acts as the switch that decides whether run_script exists at all.",
  },
  {
    key: "EXEC_CF_ACCESS_CLIENT_ID",
    overridable: true,
    toolWritable: false,
    sensitive: false,
    description: "Access service token for the exec hostname. May reuse the Proxmox pair.",
    storage: "secret",
    required: false,
    group: "exec",
    why_secret: "Half of a credential pair.",
  },
  {
    key: "EXEC_CF_ACCESS_CLIENT_SECRET",
    overridable: true,
    toolWritable: false,
    sensitive: true,
    description: "The secret half of that pair.",
    storage: "secret",
    required: false,
    group: "exec",
    why_secret: "It is the credential.",
  },
  {
    key: "EXEC_SHARED_SECRET",
    overridable: true,
    toolWritable: false,
    sensitive: true,
    description: "Second check behind Access; must match the bridge's own config.",
    storage: "secret",
    required: false,
    group: "exec",
    why_secret: "It is the credential.",
  },
  {
    key: "EXEC_SUDO_ENABLED",
    overridable: true,
    toolWritable: false,
    sensitive: false,
    description: '"true" lets run_script escalate to root on the host. Any other value disables it.',
    storage: "secret",
    required: false,
    group: "exec",
    why_secret:
      "The sudo kill switch, and the single most consequential flag here. In KV it would be " +
      "writable by anything holding a connector token -- meaning the connector could grant itself " +
      "root on the hypervisor. It stays somewhere only a human with dashboard access can reach.",
  },
  {
    key: "EXEC_SUDO_PASSWORD",
    overridable: true,
    toolWritable: false,
    sensitive: true,
    description: "OS password of the bridge user. Only read when the switch above is exactly \"true\".",
    storage: "secret",
    required: false,
    group: "exec",
    why_secret: "It is the credential.",
  },

  // --- Editable settings ----------------------------------------------------

  {
    key: "audit_enabled",
    overridable: true,
    toolWritable: true,
    sensitive: false,
    description: "Master switch for audit writes.",
    storage: "kv",
    required: false,
    group: "audit",
    default: DEFAULT_SETTINGS.audit_enabled,
  },
  {
    key: "audit_retention_days",
    overridable: true,
    toolWritable: true,
    sensitive: false,
    description: "How long audit rows are kept before the nightly sweep removes them.",
    storage: "kv",
    required: false,
    group: "audit",
    default: DEFAULT_SETTINGS.audit_retention_days,
  },
  {
    key: "audit_log_reads",
    overridable: true,
    toolWritable: true,
    sensitive: false,
    description: "Whether read-only calls are logged. Mutations are logged regardless.",
    storage: "kv",
    required: false,
    group: "audit",
    default: DEFAULT_SETTINGS.audit_log_reads,
  },
  {
    key: "audit_max_field_chars",
    overridable: true,
    toolWritable: true,
    sensitive: false,
    description: "Per-field cap on stored arguments and results.",
    storage: "kv",
    required: false,
    group: "audit",
    default: DEFAULT_SETTINGS.audit_max_field_chars,
  },
];

const CONFIG_KEY = "config:v1";
const CONFIG_CACHE_TTL = 60;

/** Keys a KV override is allowed to supply, resolved once at module load. */
const OVERRIDABLE = new Map(
  CONFIG.filter((c) => c.storage === "secret" && c.overridable).map((c) => [c.key, c]),
);

export type ValueSource = "kv" | "secret" | "unset";

/**
 * Where each secret-backed key's value actually came from.
 *
 * Kept alongside the resolved env rather than recomputed, because "why is it
 * talking to that host" is the question you ask at 2am, and the answer -- an
 * override someone left in KV months ago -- is otherwise invisible.
 */
export type ResolvedSources = Record<string, ValueSource>;

export interface ResolvedConfig {
  env: Env;
  sources: ResolvedSources;
  /** Set when a KV override existed but could not be read or parsed. */
  warning?: string;
}

/**
 * Layers KV overrides on top of the deployed secrets.
 *
 * Returns a *new* Env; the original is never mutated, so a failure part-way
 * through cannot leave a half-applied configuration behind. Nothing here throws:
 * every error path returns the untouched env, because an unreadable override
 * must degrade to "the connector keeps working" and never to "the connector
 * loses its credentials".
 */
export async function resolveConfig(env: Env, kv?: KVNamespace): Promise<ResolvedConfig> {
  const resolved = { ...env } as Env;
  const sources: ResolvedSources = {};
  const record = (key: string, source: ValueSource) => {
    sources[key] = source;
  };

  const has = (key: string) => Boolean((env as unknown as Record<string, unknown>)[key]);
  for (const key of OVERRIDABLE.keys()) record(key, has(key) ? "secret" : "unset");

  if (!kv) return { env: resolved, sources };

  let overrides: Record<string, unknown>;
  try {
    const raw = await kv.get(CONFIG_KEY, { cacheTtl: CONFIG_CACHE_TTL });
    if (!raw) return { env: resolved, sources };
    overrides = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    // Deliberately not fatal. A malformed override blob means the deployment
    // carries on with its secrets, which is the state it was in yesterday.
    const warning = `config: could not read ${CONFIG_KEY}, using deployed secrets (${e})`;
    console.warn(warning);
    return { env: resolved, sources, warning };
  }

  for (const [key, value] of Object.entries(overrides)) {
    // `_` keys are notes for whoever is editing the blob by hand.
    if (key.startsWith("_")) continue;
    const entry = OVERRIDABLE.get(key);
    if (!entry) {
      console.warn(`config: ignoring "${key}" -- not an overridable key`);
      continue;
    }
    // Blank is treated as absent rather than as an empty value, so clearing a
    // field in the dashboard falls back to the secret instead of breaking the
    // connector with an empty hostname.
    if (typeof value !== "string" || value.trim() === "") continue;

    Object.assign(resolved, { [key]: value.trim() });
    record(key, "kv");
  }

  return { env: resolved, sources };
}

/**
 * Writes a commented, empty override blob if none exists.
 *
 * Same reasoning as seedSettings: an empty namespace tells you nothing about
 * what you are allowed to put in it. JSON has no comments, so the guidance goes
 * in `_readme` keys, which resolveConfig skips.
 */
export async function seedConfigOverrides(kv: KVNamespace | undefined): Promise<boolean> {
  if (!kv) return false;
  if (await kv.get(CONFIG_KEY)) return false;

  const template: Record<string, string> = {
    _readme:
      "Values here override the deployed Worker secrets. Leave a key out (or blank) to keep " +
      "using the secret. Order of precedence: this file, then the secret, then the default.",
    _keys: [...OVERRIDABLE.keys()].join(", "),
    _not_overridable: "MCP_API_KEY -- it authenticates the caller, so it cannot live behind an authenticated tool.",
  };
  await kv.put(CONFIG_KEY, JSON.stringify(template, null, 2));
  return true;
}

export interface ConfigReport {
  secrets: Array<{
    key: string;
    description: string;
    group: string;
    required: boolean;
    set: boolean;
    source: ValueSource;
    overridable: boolean;
    /** Only for keys marked non-sensitive; credentials never carry a value. */
    value?: string;
    why_secret?: string;
  }>;
  settings: Array<{
    key: string;
    description: string;
    value: unknown;
    default: unknown;
    customised: boolean;
  }>;
  missing_required: string[];
  note: string;
}

/**
 * The whole configuration surface: which secrets are set (never their values),
 * and what every editable setting currently is.
 */
export function describeConfig(
  env: Env,
  settings: Settings,
  sources: ResolvedSources = {},
): ConfigReport {
  const secrets = CONFIG.filter((c) => c.storage === "secret").map((entry) => {
    const raw = (env as unknown as Record<string, unknown>)[entry.key];
    const set = Boolean(raw);
    return {
      key: entry.key,
      description: entry.description,
      group: entry.group,
      required: entry.required,
      set,
      // Which layer won. This is what makes an override discoverable months
      // later, instead of leaving you wondering why the host is not the one in
      // the dashboard's secret list.
      source: sources[entry.key] ?? (set ? ("secret" as const) : ("unset" as const)),
      overridable: entry.overridable,
      // Hostnames and flags are useful to see and safe to show an authenticated
      // caller. Credentials get presence and nothing else, whichever layer they
      // came from -- an override does not make a password printable.
      ...(!entry.sensitive && set ? { value: String(raw) } : {}),
      why_secret: entry.why_secret,
    };
  });

  const editable = CONFIG.filter((c) => c.storage === "kv").map((entry) => {
    const value = (settings as unknown as Record<string, unknown>)[entry.key];
    return {
      key: entry.key,
      description: entry.description,
      value,
      default: entry.default,
      customised: value !== entry.default,
    };
  });

  return {
    secrets,
    settings: editable,
    missing_required: secrets.filter((s) => s.required && !s.set).map((s) => s.key),
    note:
      "Values resolve as: KV override, then deployed secret, then default -- `source` says which " +
      "one won. Overrides live in the PROXMOX_KV entry `config:v1` and are editable only by hand " +
      "in the dashboard, never through a tool. Runtime settings live in `settings:v1` and can be " +
      "changed with update_settings. Credential values are never shown, from either layer.",
  };
}
