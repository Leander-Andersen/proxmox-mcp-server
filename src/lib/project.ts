import { z } from "zod";

/**
 * Optional server-side shaping of Proxmox responses.
 *
 * Some endpoints are enormous relative to their useful signal: a week of
 * `rrddata` is ~330 points x ~20 metrics, and guest configs from community
 * install scripts carry multi-line HTML blobs in `description`. Projecting
 * before the payload is serialised keeps that out of the conversation entirely.
 *
 * All of this is opt-in -- with no options the data is returned untouched.
 */

export interface ProjectOptions {
  fields?: string[];
  omitFields?: string[];
  limit?: number;
}

/**
 * Shared input schema fragment, so every read tool offers the same trimming
 * vocabulary rather than each inventing its own.
 */
export const projectionInput = {
  fields: z
    .array(z.string())
    .optional()
    .describe("Keep only these keys. Applied per row for list results."),
  omit_fields: z.array(z.string()).optional().describe("Drop these keys from the result."),
};

export const listProjectionInput = {
  ...projectionInput,
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Keep only the last N entries (the most recent)."),
};

/** Maps the snake_case tool args onto ProjectOptions. */
export function toOptions(args: {
  fields?: string[];
  omit_fields?: string[];
  limit?: number;
}): ProjectOptions {
  return { fields: args.fields, omitFields: args.omit_fields, limit: args.limit };
}

function projectRow(row: unknown, opts: ProjectOptions): unknown {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return row;

  const source = row as Record<string, unknown>;
  let keys = Object.keys(source);

  if (opts.fields?.length) {
    const wanted = new Set(opts.fields);
    keys = keys.filter((k) => wanted.has(k));
  }
  if (opts.omitFields?.length) {
    const unwanted = new Set(opts.omitFields);
    keys = keys.filter((k) => !unwanted.has(k));
  }

  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = source[k];
  return out;
}

export function project(data: unknown, opts: ProjectOptions): unknown {
  const hasFieldFilter = Boolean(opts.fields?.length || opts.omitFields?.length);

  if (Array.isArray(data)) {
    // Keep the most recent rows: RRD and task listings are chronological, and
    // the tail is what anyone asking about "recent" or "current" actually wants.
    const rows = opts.limit && opts.limit < data.length ? data.slice(-opts.limit) : data;
    return hasFieldFilter ? rows.map((r) => projectRow(r, opts)) : rows;
  }

  return hasFieldFilter ? projectRow(data, opts) : data;
}

/** True when any shaping was actually requested. */
export function hasProjection(opts: ProjectOptions): boolean {
  return Boolean(opts.fields?.length || opts.omitFields?.length || opts.limit);
}

/**
 * Trims command output to a token budget, keeping both ends.
 *
 * The interesting part of a log is usually at one end or the other -- the
 * command that started it, or the error that ended it -- so cutting from the
 * middle preserves more signal than a plain head truncation.
 */
export function clampOutput(text: string, max: number): string {
  if (text.length <= max) return text;

  const notice = (omitted: number) =>
    `\n\n... [${omitted} characters omitted -- ${text.length} total. ` +
    `Filter on the host (grep, tail -n, journalctl -n) or raise max_output.] ...\n\n`;

  // The notice counts against the budget. `max` is what the caller asked to
  // receive, not what they asked to keep before we append our own commentary --
  // run_script clamps stdout and stderr separately, so overshooting on both
  // doubled the error. Budgeting with text.length is a safe over-estimate,
  // since `omitted` can never have more digits than it does.
  const budget = Math.max(0, max - notice(text.length).length);
  const head = Math.floor(budget * 0.6);
  const tail = budget - head;
  const omitted = text.length - budget;

  // slice(-0) returns the whole string, so an empty tail has to be special-cased.
  return text.slice(0, head) + notice(omitted) + (tail > 0 ? text.slice(-tail) : "");
}
