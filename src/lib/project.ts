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
