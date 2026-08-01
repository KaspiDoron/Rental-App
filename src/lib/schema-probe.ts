import "server-only";

// A DASHBOARD THAT CANNOT GO RED IS NOT A DASHBOARD.
//
// The deploy-info card exists to answer one question from a phone: "is the fix
// I shipped actually running, against a database that actually has the columns
// it needs?" It asked that question like this:
//
//   try { await sbSelect(table, "select=x&limit=1"); return { ok: true }; }
//   catch { return { ok: false }; }
//
// `sbSelect` has no throw path. It returns [] when Supabase is unconfigured, []
// when the response is not ok, and [] from its own catch. So the catch above was
// dead code and all seven schema probes reported "present" unconditionally - a
// green card over an empty database, which is the precise failure the card was
// built to make impossible.
//
// `sbSelectStrict` already distinguishes the three outcomes. This module is the
// small layer on top that the probes - and the consent gate - can share, so the
// same question is never asked two different ways.
//
// THE CACHE DIRECTION MATTERS MORE THAN THE CACHE.
//
// A "ready" answer is permanent: nothing in this app drops a column, so once a
// table is there it stays there and re-asking is waste. A "missing" answer is
// TEMPORARY BY DESIGN - the owner is about to run schema.sql, and if we cached
// that for the process lifetime the app would keep insisting the schema is
// absent long after it landed, with no way to clear it but a redeploy. So
// negatives expire fast and positives stick.

import { sbSelectStrict } from "./runtime-config";

export type SchemaState = "ready" | "missing" | "unavailable";

/** How long a negative answer is trusted. Short, because the owner running
 *  schema.sql must take effect without a redeploy. */
export const NEGATIVE_TTL_MS = 60_000;

type Entry = { state: SchemaState; at: number };

const cache = new Map<string, Entry>();

/** Test seam - the cache is a module singleton and would leak between cases. */
export function resetSchemaProbeCache(): void {
  cache.clear();
}

/**
 * Does this table (and this column) exist in the database we are actually
 * talking to?
 *
 *   "ready"       - the read succeeded. The column is there.
 *   "missing"     - the table or column does not exist: schema.sql has not been
 *                   run against this database.
 *   "unavailable" - Supabase did not answer. The truth is UNKNOWN, which is a
 *                   different thing from "no", and callers must decide which way
 *                   to fail rather than being handed a false "no".
 */
export async function tableReady(table: string, select: string): Promise<SchemaState> {
  const key = `${table}:${select}`;
  const hit = cache.get(key);
  if (hit) {
    // A positive never expires; a negative does.
    if (hit.state === "ready") return "ready";
    if (Date.now() - hit.at < NEGATIVE_TTL_MS) return hit.state;
  }
  const res = await sbSelectStrict(table, `select=${select}&limit=1`);
  const state: SchemaState = "rows" in res ? "ready" : res.error;
  cache.set(key, { state, at: Date.now() });
  return state;
}

/** The one sentence the card shows for each state. Kept here so the probe and
 *  its explanation cannot drift apart. */
export function schemaDetail(state: SchemaState): string {
  if (state === "ready") return "present";
  if (state === "missing") return "MISSING - run supabase/schema.sql";
  return "unreadable - Supabase did not answer";
}
