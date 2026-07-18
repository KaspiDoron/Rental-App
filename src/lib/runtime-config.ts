// Runtime configuration store.
//
// Integration secrets (LLM tokens, WhatsApp credentials) can be set two ways:
//   1. Host environment variables (process.env) - the bootstrap / source of truth.
//   2. The admin Key Vault - persisted to Supabase, encrypted at rest, and read
//      back here at request time. This is what makes "paste a key in the admin
//      panel and it takes effect" work on serverless hosts like Vercel, where
//      per-instance memory resets and the app cannot write its own env vars.
//
// Resolution order for any key: Supabase override → process.env. Supabase reads
// are cached per-instance for a short TTL so we don't hit the DB on every call.
//
// When Supabase is not configured, overrides fall back to an in-memory map so
// the whole flow still works locally / in demo mode (non-persistent).

import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "crypto";

const CACHE_TTL_MS = 30_000;

declare global {
  // eslint-disable-next-line no-var
  var __wheeldeal_cfg__:
    | {
        cache: { data: Record<string, string>; exp: number } | null;
        mem: Record<string, string>;
      }
    | undefined;
}

function state() {
  if (!globalThis.__wheeldeal_cfg__) {
    globalThis.__wheeldeal_cfg__ = { cache: null, mem: {} };
  }
  return globalThis.__wheeldeal_cfg__;
}

function supabase(): { url: string; key: string } | null {
  // trim(): pasted Vercel env values often carry an invisible trailing
  // newline/space, which Supabase rejects as "Invalid API key".
  const url = (
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    ""
  ).trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ""), key };
}

/** Which Supabase role a JWT-style key carries ("service_role", "anon", ...). */
function jwtRole(key: string): string | null {
  const parts = key.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    return typeof payload.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

export interface SupabaseDiagnostics {
  configured: boolean;
  urlOk: boolean;
  keyRole: string | null; // must be "service_role"
  reachable: boolean;
  appConfigOk: boolean;
  detail: string;
}

/** Live end-to-end check of the Supabase connection, with an exact diagnosis. */
export async function supabaseDiagnostics(): Promise<SupabaseDiagnostics> {
  const conn = supabase();
  if (!conn) {
    return {
      configured: false,
      urlOk: false,
      keyRole: null,
      reachable: false,
      appConfigOk: false,
      detail:
        "SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY are not set in the host environment (Vercel -> Settings -> Environment Variables).",
    };
  }
  const urlOk = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(conn.url);
  const keyRole = jwtRole(conn.key);
  if (keyRole && keyRole !== "service_role") {
    return {
      configured: true,
      urlOk,
      keyRole,
      reachable: false,
      appConfigOk: false,
      detail: `SUPABASE_SERVICE_ROLE_KEY currently holds the "${keyRole}" key - that is the WRONG key. In Supabase: Settings -> API -> "Project API keys" -> copy the one labelled service_role (secret), paste it into Vercel, and redeploy.`,
    };
  }
  try {
    const res = await timedFetch(`${conn.url}/rest/v1/app_config?select=key&limit=1`, {
      headers: { apikey: conn.key, Authorization: `Bearer ${conn.key}` },
      cache: "no-store",
    });
    if (res.status === 401) {
      return {
        configured: true,
        urlOk,
        keyRole,
        reachable: true,
        appConfigOk: false,
        detail:
          "Supabase says the API key is invalid (401). Re-copy the service_role key from Supabase -> Settings -> API (watch for missing characters or extra spaces), update SUPABASE_SERVICE_ROLE_KEY in Vercel, and redeploy. If you rotated/regenerated your project's keys, the old value is dead.",
      };
    }
    if (res.status === 404) {
      return {
        configured: true,
        urlOk,
        keyRole,
        reachable: true,
        appConfigOk: false,
        detail:
          "Connected, but the app_config table is missing - run supabase/schema.sql in the Supabase SQL Editor.",
      };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        configured: true,
        urlOk,
        keyRole,
        reachable: true,
        appConfigOk: false,
        detail: `Supabase responded ${res.status}: ${body.slice(0, 160)}`,
      };
    }
    return {
      configured: true,
      urlOk,
      keyRole,
      reachable: true,
      appConfigOk: true,
      detail: "Connected - key vault persistence and durable accounts are working.",
    };
  } catch (e) {
    return {
      configured: true,
      urlOk,
      keyRole,
      reachable: false,
      appConfigOk: false,
      detail: `Could not reach Supabase: ${e instanceof Error ? e.message : "network error"}. Check that SUPABASE_URL is your project's https://xxxx.supabase.co URL.`,
    };
  }
}

export function supabaseConfigured(): boolean {
  return supabase() !== null;
}

/**
 * fetch with a HARD timeout. undici's fetch has no short overall request
 * timeout, so a Supabase connection that accepts but stalls would block the
 * handler until Vercel's maxDuration - and a single guardOutbound/drain pass
 * makes a dozen serial DB round-trips, so one stall cascades into killed
 * requests across the fleet instead of degrading gracefully. On abort the call
 * throws (AbortError), which every helper's existing catch already maps to its
 * fail-safe/fail-closed value (sbSelect -> [], sbSelectStrict -> "unavailable").
 */
async function timedFetch(url: string, init: RequestInit, ms = 8000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  // Deliberately do NOT clearTimeout at the header boundary. fetch() resolves as
  // soon as response HEADERS arrive, but the read helpers then `await
  // res.json()`/`res.text()`, and that body read shares this AbortController.
  // Clearing the timer here would leave the body read unbounded (undici's
  // default bodyTimeout is ~300s, far past Vercel's function limit), so a DB
  // that streams headers then stalls mid-body would still hang the handler - and
  // on the drain path a hung handler that Vercel kills LOSES an already-claimed
  // row. Keeping the deadline armed bounds headers+body together; once the body
  // is fully read the pending abort is a harmless no-op on a settled request.
  // unref() so a still-pending timer never keeps the runtime alive.
  (timer as { unref?: () => void }).unref?.();
  return fetch(url, { ...init, signal: ctrl.signal });
}

/** Read rows from a Supabase table via the service role. [] if unset. */
export async function sbSelect<T = Record<string, unknown>>(
  table: string,
  query = "select=*&limit=50"
): Promise<T[]> {
  const conn = supabase();
  if (!conn) return [];
  try {
    const res = await timedFetch(`${conn.url}/rest/v1/${table}?${query}`, {
      headers: { apikey: conn.key, Authorization: `Bearer ${conn.key}` },
      cache: "no-store",
    });
    if (!res.ok) return [];
    return (await res.json()) as T[];
  } catch {
    return [];
  }
}

/**
 * STRICT variant of sbSelect for guard-critical reads where "empty" and
 * "unreadable" mean opposite things. sbSelect collapses every failure to []
 * which makes safety gates FAIL OPEN (a Supabase blip reads as "nothing sent
 * today / no tombstones"). This returns:
 *   { rows }                     - the read genuinely succeeded ([] = empty)
 *   { error: "missing" }         - the table/column does not exist yet (schema
 *                                  not migrated): vacuously empty, safe to
 *                                  treat as "no rows can exist"
 *   { error: "unavailable" }     - transient failure: the truth is UNKNOWN and
 *                                  callers must fail CLOSED for automated sends
 */
export async function sbSelectStrict<T = Record<string, unknown>>(
  table: string,
  query = "select=*&limit=50"
): Promise<{ rows: T[] } | { error: "missing" | "unavailable" }> {
  const conn = supabase();
  // Unconfigured (demo mode) behaves like "missing": no table, no rows.
  if (!conn) return { error: "missing" };
  try {
    const res = await timedFetch(`${conn.url}/rest/v1/${table}?${query}`, {
      headers: { apikey: conn.key, Authorization: `Bearer ${conn.key}` },
      cache: "no-store",
    });
    if (res.ok) return { rows: (await res.json()) as T[] };
    // PostgREST: 404 = unknown relation; 400 + 42703/42P01 = missing column/table.
    if (res.status === 404) return { error: "missing" };
    if (res.status === 400) {
      const body = await res.text().catch(() => "");
      if (body.includes("42P01") || body.includes("42703")) return { error: "missing" };
    }
    return { error: "unavailable" };
  } catch {
    return { error: "unavailable" };
  }
}

/** Insert rows into a Supabase table via the service role. No-op if unset. */
export async function sbInsert(
  table: string,
  rows: Record<string, unknown>[],
  onConflict?: string
): Promise<boolean> {
  const conn = supabase();
  if (!conn || rows.length === 0) return false;
  try {
    const url = onConflict
      ? `${conn.url}/rest/v1/${table}?on_conflict=${onConflict}`
      : `${conn.url}/rest/v1/${table}`;
    const res = await timedFetch(url, {
      method: "POST",
      headers: {
        apikey: conn.key,
        Authorization: `Bearer ${conn.key}`,
        "Content-Type": "application/json",
        Prefer: onConflict
          ? "return=minimal,resolution=merge-duplicates"
          : "return=minimal",
      },
      body: JSON.stringify(rows),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Atomic slot claim: plain INSERT with NO conflict resolution, so a duplicate
 * primary key is a hard 409 - the one signal PostgREST gives us that another
 * concurrent invocation already owns the slot. This is the lock-free
 * serialization primitive for sends (see wa_send_claims).
 *   "won"   - this invocation owns the slot
 *   "lost"  - another invocation owns it (409 conflict)
 *   "error" - unknown (network/5xx/missing table): callers must fail CLOSED
 */
export async function sbInsertClaim(
  table: string,
  row: Record<string, unknown>
): Promise<"won" | "lost" | "error"> {
  const conn = supabase();
  if (!conn) return "error";
  try {
    const res = await timedFetch(`${conn.url}/rest/v1/${table}`, {
      method: "POST",
      headers: {
        apikey: conn.key,
        Authorization: `Bearer ${conn.key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify([row]),
    });
    if (res.ok) return "won";
    if (res.status === 409) return "lost";
    return "error";
  } catch {
    return "error";
  }
}

/** Insert and return the created rows (needs the id back, e.g. feedback). */
export async function sbInsertReturning<T = Record<string, unknown>>(
  table: string,
  rows: Record<string, unknown>[]
): Promise<T[]> {
  const conn = supabase();
  if (!conn || rows.length === 0) return [];
  try {
    const res = await timedFetch(`${conn.url}/rest/v1/${table}`, {
      method: "POST",
      headers: {
        apikey: conn.key,
        Authorization: `Bearer ${conn.key}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(rows),
    });
    if (!res.ok) return [];
    return (await res.json()) as T[];
  } catch {
    return [];
  }
}

/** Delete rows matching a PostgREST filter (e.g. `id=eq.42`). */
export async function sbDelete(table: string, filter: string): Promise<boolean> {
  const conn = supabase();
  if (!conn) return false;
  try {
    const res = await timedFetch(`${conn.url}/rest/v1/${table}?${filter}`, {
      method: "DELETE",
      headers: {
        apikey: conn.key,
        Authorization: `Bearer ${conn.key}`,
        Prefer: "return=minimal",
      },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Delete rows and return the ones actually deleted (PostgREST
 * `return=representation`). This is an ATOMIC CLAIM: two concurrent callers
 * deleting the same rows each get back only the rows THEY deleted - exactly
 * one wins per row. Used to make outbox draining exactly-once.
 */
export async function sbDeleteReturning<T = Record<string, unknown>>(
  table: string,
  filter: string
): Promise<T[]> {
  const conn = supabase();
  if (!conn) return [];
  try {
    const res = await timedFetch(`${conn.url}/rest/v1/${table}?${filter}`, {
      method: "DELETE",
      headers: {
        apikey: conn.key,
        Authorization: `Bearer ${conn.key}`,
        Prefer: "return=representation",
      },
    });
    if (!res.ok) return [];
    return (await res.json()) as T[];
  } catch {
    return [];
  }
}

/** Patch rows matching a PostgREST filter with the given values. */
export async function sbUpdate(
  table: string,
  filter: string,
  values: Record<string, unknown>
): Promise<boolean> {
  const conn = supabase();
  if (!conn) return false;
  try {
    const res = await timedFetch(`${conn.url}/rest/v1/${table}?${filter}`, {
      method: "PATCH",
      headers: {
        apikey: conn.key,
        Authorization: `Bearer ${conn.key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(values),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---- encryption (AES-256-GCM, key derived from SESSION_SECRET) --------------

function cryptoKey(): Buffer {
  const secret = process.env.SESSION_SECRET || "dev-insecure-secret-change-me";
  return scryptSync(secret, "wheeldeal-config-v1", 32);
}

function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", cryptoKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString(
    "base64"
  )}`;
}

/** AES-256-GCM encrypt an arbitrary string (used for transient signup payloads). */
export function encryptString(plain: string): string {
  return encrypt(plain);
}
/** Decrypt a string produced by encryptString. Returns null on tamper/failure. */
export function decryptString(blob: string): string | null {
  return decrypt(blob);
}

function decrypt(blob: string): string | null {
  try {
    const [v, ivB, tagB, dataB] = blob.split(":");
    if (v !== "v1") return null;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      cryptoKey(),
      Buffer.from(ivB, "base64")
    );
    decipher.setAuthTag(Buffer.from(tagB, "base64"));
    return (
      decipher.update(Buffer.from(dataB, "base64")).toString("utf8") +
      decipher.final("utf8")
    );
  } catch {
    return null;
  }
}

// ---- Supabase REST ----------------------------------------------------------

async function loadOverrides(): Promise<Record<string, string>> {
  const s = state();
  const conn = supabase();
  if (!conn) return s.mem;

  if (s.cache && s.cache.exp > Date.now()) return { ...s.cache.data, ...s.mem };
  try {
    const res = await timedFetch(
      `${conn.url}/rest/v1/app_config?select=key,value`,
      {
        headers: {
          apikey: conn.key,
          Authorization: `Bearer ${conn.key}`,
        },
        cache: "no-store",
      }
    );
    if (!res.ok) throw new Error(`supabase ${res.status}`);
    const rows = (await res.json()) as { key: string; value: string }[];
    const data: Record<string, string> = {};
    for (const row of rows) {
      const plain = decrypt(row.value);
      if (plain) data[row.key] = plain;
    }
    s.cache = { data, exp: Date.now() + CACHE_TTL_MS };
    // In-memory overrides (e.g. saved while Supabase was unreachable) win.
    return { ...data, ...s.mem };
  } catch {
    return { ...(s.cache?.data ?? {}), ...s.mem };
  }
}

/** Effective value for a key: Supabase override first, then process.env. */
export async function getConfig(name: string): Promise<string | undefined> {
  const overrides = await loadOverrides();
  return overrides[name] ?? process.env[name];
}

/**
 * Persist (or clear) a runtime override. Returns a clear error message when
 * durable persistence fails, so the admin UI never fails silently.
 */
export async function setConfig(
  name: string,
  value: string
): Promise<{ ok: boolean; persistent: boolean; error?: string }> {
  const s = state();
  const conn = supabase();

  if (!conn) {
    if (value) s.mem[name] = value;
    else delete s.mem[name];
    s.cache = null;
    return {
      ok: true,
      persistent: false,
      error:
        "Saved for this session only: Supabase is not connected (set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in Vercel), so the value will reset on the next deploy/restart.",
    };
  }

  try {
    let res: Response;
    if (value) {
      res = await timedFetch(`${conn.url}/rest/v1/app_config?on_conflict=key`, {
        method: "POST",
        headers: {
          apikey: conn.key,
          Authorization: `Bearer ${conn.key}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal,resolution=merge-duplicates",
        },
        body: JSON.stringify([
          { key: name, value: encrypt(value), updated_at: new Date().toISOString() },
        ]),
      });
    } else {
      res = await timedFetch(
        `${conn.url}/rest/v1/app_config?key=eq.${encodeURIComponent(name)}`,
        {
          method: "DELETE",
          headers: { apikey: conn.key, Authorization: `Bearer ${conn.key}` },
        }
      );
    }
    s.cache = null;
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const hint =
        res.status === 401
          ? "Invalid Supabase key: SUPABASE_SERVICE_ROLE_KEY in Vercel is wrong (it may be the anon key, have a typo, or the project keys were rotated). Copy the service_role key from Supabase -> Settings -> API, update Vercel, redeploy, then use Admin -> Keys -> Test Supabase."
          : /relation .*app_config.* does not exist|404/.test(detail + res.status)
          ? "The app_config table is missing - run supabase/schema.sql in the Supabase SQL Editor."
          : detail.slice(0, 180);
      // Keep an in-memory copy so it at least works right now.
      if (value) s.mem[name] = value;
      return { ok: false, persistent: false, error: `Could not save to Supabase (${res.status}). ${hint}` };
    }
    return { ok: true, persistent: true };
  } catch (e) {
    if (value) s.mem[name] = value;
    s.cache = null;
    return {
      ok: false,
      persistent: false,
      error: `Could not reach Supabase: ${e instanceof Error ? e.message : "network error"}`,
    };
  }
}
