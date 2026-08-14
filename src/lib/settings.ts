/**
 * Runtime settings, stored in KV rather than baked into secrets.
 *
 * The distinction that decides what belongs here: a *secret* is something the
 * Worker needs in order to talk to something else, and changing one is a
 * deployment event. A *setting* is a policy choice the operator makes about how
 * the Worker behaves, and changing one should be a two-second decision that
 * takes effect without a deploy. Retention is squarely the second kind -- "keep
 * a year" is an opinion, not a credential.
 *
 * Everything lives in one JSON blob under a single key. Per-key entries would
 * mean one KV read per setting on every request, and KV has no transactions, so
 * a multi-key write could half-apply. One blob is one read, one write, and no
 * partial states.
 */

import { z } from "zod";

const SETTINGS_KEY = "settings:v1";

/**
 * Edge-cache the blob. KV is eventually consistent anyway, so a read is already
 * not a guarantee of freshness; paying a round trip per request to pretend
 * otherwise buys nothing. The practical effect is that a settings change takes
 * up to a minute to reach every colo, which is stated in the update_settings
 * tool description so it is not a surprise.
 */
const SETTINGS_CACHE_TTL = 60;

export const settingsSchema = z.object({
  audit_enabled: z
    .boolean()
    .describe("Master switch. When false nothing is written to the audit log."),
  audit_retention_days: z
    .number()
    .int()
    .min(1)
    .max(3650)
    .describe("How long audit rows are kept. The nightly sweep deletes anything older."),
  audit_log_reads: z
    .boolean()
    .describe(
      "Log read-only calls (list_guests, guest_status, ...) as well as mutations. " +
        "Mutations are always logged and cannot be switched off here.",
    ),
  audit_max_field_chars: z
    .number()
    .int()
    .min(500)
    .max(100_000)
    .describe(
      "Per-field cap on stored arguments and results. The true length is kept " +
        "alongside, so a capped row still says how much was cut.",
    ),
});

export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  audit_enabled: true,
  audit_retention_days: 365,
  audit_log_reads: true,
  // run_script alone can return 200k characters. A year of those at full size
  // is the difference between a database you can download and one you cannot.
  audit_max_field_chars: 8_000,
};

/**
 * Reads the settings blob, falling back to defaults for anything missing.
 *
 * Never throws. A settings store that can fail closed would take the whole
 * server down over a malformed JSON blob, which is a far worse outcome than
 * running on defaults and saying so in the log.
 */
export async function loadSettings(kv: KVNamespace | undefined): Promise<Settings> {
  if (!kv) return { ...DEFAULT_SETTINGS };
  try {
    const raw = await kv.get(SETTINGS_KEY, { cacheTtl: SETTINGS_CACHE_TTL });
    if (!raw) return { ...DEFAULT_SETTINGS };

    const stored = JSON.parse(raw) as Record<string, unknown>;
    const result = { ...DEFAULT_SETTINGS };

    // Validated field by field rather than as a whole, because this blob is
    // meant to be hand-edited in the dashboard. Rejecting the entire file over
    // one mistyped number would silently revert every other setting too -- the
    // worst possible response to a typo. A bad field falls back to its default
    // and says so; its neighbours are untouched.
    for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
      if (!(key in stored)) continue;
      const field = settingsSchema.shape[key].safeParse(stored[key]);
      if (field.success) {
        Object.assign(result, { [key]: field.data });
      } else {
        console.warn(
          `settings: ${key}=${JSON.stringify(stored[key])} is not valid, using the default ` +
            `${JSON.stringify(DEFAULT_SETTINGS[key])} (${field.error.issues[0]?.message ?? "invalid"})`,
        );
      }
    }
    return result;
  } catch (e) {
    console.warn(`settings: could not read KV, using defaults (${e})`);
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Writes the defaults into KV if nothing is there yet.
 *
 * Without this the settings key simply does not exist until someone changes
 * something, so opening the KV browser to see what is configurable shows an
 * empty namespace. Seeding puts the full set of keys in front of you, filled in
 * with what is actually in force, ready to be edited by hand.
 *
 * Deliberately not called on the request path: it is a write, and the read path
 * already falls back to exactly these values.
 */
export async function seedSettings(kv: KVNamespace | undefined): Promise<boolean> {
  if (!kv) return false;
  if (await kv.get(SETTINGS_KEY)) return false;
  await kv.put(SETTINGS_KEY, format(DEFAULT_SETTINGS));
  return true;
}

/** Pretty-printed, because a human is expected to read and edit this. */
function format(settings: Settings): string {
  return JSON.stringify(settings, null, 2);
}

/**
 * Applies a partial update and returns the settings as they now stand.
 *
 * Read-modify-write on a shared blob is a lost-update race in principle. In
 * practice this is one operator changing a policy knob by hand, so the window
 * is theoretical; making it airtight would mean a Durable Object, which is a
 * lot of machinery for a retention number.
 */
export async function saveSettings(
  kv: KVNamespace,
  patch: Partial<Settings>,
): Promise<{ settings: Settings; changed: Partial<Settings> }> {
  const current = await loadSettings(kv);
  const next = settingsSchema.parse({ ...current, ...patch });

  const changed: Partial<Settings> = {};
  for (const key of Object.keys(next) as Array<keyof Settings>) {
    if (next[key] !== current[key]) Object.assign(changed, { [key]: next[key] });
  }

  await kv.put(SETTINGS_KEY, format(next));
  return { settings: next, changed };
}
