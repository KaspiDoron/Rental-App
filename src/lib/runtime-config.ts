// Runtime configuration store.
//
// Integration secrets (LLM tokens, WhatsApp credentials) can be set two ways:
//   1. Host environment variables (process.env) - the bootstrap / source of truth.
//   2. The admin Key Vault - persisted to Supabase, encrypted at rest, and read
//      back here at request time. This is what makes "paste a key in the admin
//      panel and it takes effect" work on serverless hosts like GCP Cloud Run, where
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

/** How long a FAILED vault read is trusted. Short, because the outage may be
 *  brief - but non-zero, because zero is what turned a slow Supabase into a
 *  fetch storm across all 140 getConfig call sites. */
const NEGATIVE_TTL_MS = 5_000;

declare global {
  // eslint-disable-next-line no-var
  var __wheeldeal_cfg__:
    | {
        cache: { data: Record<string, string>; exp: number } | null;
        mem: Record<string, string>;
        /** The in-flight vault read, shared by every concurrent caller. */
        inflight: Promise<Record<string, string>> | null;
      }
    | undefined;
}

function state() {
  if (!globalThis.__wheeldeal_cfg__) {
    globalThis.__wheeldeal_cfg__ = { cache: null, mem: {}, inflight: null };
  }
  // Older instances of this global (hot reload, or a module loaded before this
  // field existed) will not have `inflight`.
  if (globalThis.__wheeldeal_cfg__.inflight === undefined) {
    globalThis.__wheeldeal_cfg__.inflight = null;
  }
  return globalThis.__wheeldeal_cfg__;
}

function supabase(): { url: string; key: string } | null {
  // trim(): pasted env values often carry an invisible trailing
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
        "SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY are not set in the host environment (GCP Secret Manager).",
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
      detail: `SUPABASE_SERVICE_ROLE_KEY currently holds the "${keyRole}" key - that is the WRONG key. In Supabase: Settings -> API -> "Project API keys" -> copy the one labelled service_role (secret), paste it into GCP Secret Manager, and redeploy.`,
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
          "Supabase says the API key is invalid (401). Re-copy the service_role key from Supabase -> Settings -> API (watch for missing characters or extra spaces), update SUPABASE_SERVICE_ROLE_KEY in GCP Secret Manager, and redeploy. If you rotated/regenerated your project's keys, the old value is dead.",
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
 * handler until Cloud Run's request timeout - and a single guardOutbound/drain pass
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
  // default bodyTimeout is ~300s, far past Cloud Run's request limit), so a DB
  // that streams headers then stalls mid-body would still hang the handler - and
  // on the drain path a hung handler that Cloud Run terminates LOSES an already-claimed
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
 * How many rows match, without transferring any of them.
 *
 * The alternative - selecting rows and taking `.length` - is bounded by a
 * `limit`, so it silently under-reports the moment the real count exceeds it.
 * That is fine for a preview and wrong for a counter. PostgREST answers the
 * exact number in `Content-Range` when asked with `count=exact`, and
 * `Range: 0-0` keeps the body to a single row.
 *
 * Returns 0 on any failure - a metric is not worth throwing over - so callers
 * that need to distinguish "none" from "could not read" must use sbSelectStrict.
 */
export async function sbCount(table: string, filter: string): Promise<number> {
  const conn = supabase();
  if (!conn) return 0;
  try {
    const res = await timedFetch(`${conn.url}/rest/v1/${table}?select=id&${filter}`, {
      headers: {
        apikey: conn.key,
        Authorization: `Bearer ${conn.key}`,
        Prefer: "count=exact",
        Range: "0-0",
      },
      cache: "no-store",
    });
    if (!res.ok) return 0;
    // "0-0/1234" or "*/1234" - the total is after the slash.
    const total = res.headers.get("content-range")?.split("/")[1];
    const n = Number(total);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * EVERY WAY POSTGREST SAYS "THAT DOES NOT EXIST YET".
 *
 * Three dialects, and only the first two were ever matched:
 *   - Postgres SQLSTATE in the body: 42P01 (undefined table), 42703 (undefined
 *     column).
 *   - PGRST204 / PGRST205: PostgREST's OWN schema-cache misses, which carry no
 *     Postgres code at all because the query never reached the database.
 *   - Bare prose ("column x does not exist", "relation y does not exist") from
 *     versions that forward the message without the code.
 *
 * Exported so a test can prove all three map to "missing" rather than
 * "unavailable" - the two answers send callers in opposite directions.
 */
export function isMissingSchemaBody(body: string): boolean {
  if (!body) return false;
  return (
    body.includes("42P01") ||
    body.includes("42703") ||
    body.includes("PGRST204") ||
    body.includes("PGRST205") ||
    /does not exist/i.test(body) ||
    /schema cache/i.test(body)
  );
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
    //
    // THE CODES ARE NOT THE ONLY SHAPE. PostgREST answers a missing column from
    // its own schema cache as PGRST204 with no Postgres code at all, and several
    // versions return only the prose ("column x does not exist"). A miss here
    // degrades to "unavailable", and the two errors point callers in OPPOSITE
    // directions - "missing" means the schema has not been run and the read is
    // vacuously empty; "unavailable" means the truth is unknown and a guard must
    // fail closed. Matching only the codes made a not-yet-migrated database look
    // like a flaky one.
    if (res.status === 404) return { error: "missing" };
    if (res.status === 400) {
      const body = await res.text().catch(() => "");
      if (isMissingSchemaBody(body)) return { error: "missing" };
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

/**
 * Patch rows matching a PostgREST filter and return the ones actually updated.
 *
 * This is what makes a CONDITIONAL UPDATE usable as an atomic claim: two callers
 * patching the same row with a predicate in the filter serialize on the row
 * lock, and the loser re-evaluates the predicate against the winner's committed
 * row - so exactly one of them gets a row back. Used by the outbound lifecycle
 * to claim a queued message without deleting it (see wa/outbox-lifecycle).
 */
export async function sbUpdateReturning<T = Record<string, unknown>>(
  table: string,
  filter: string,
  values: Record<string, unknown>
): Promise<T[]> {
  const conn = supabase();
  if (!conn) return [];
  try {
    const res = await timedFetch(`${conn.url}/rest/v1/${table}?${filter}`, {
      method: "PATCH",
      headers: {
        apikey: conn.key,
        Authorization: `Bearer ${conn.key}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(values),
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

// A 71-MILLISECOND SYNCHRONOUS BLOCK, ONCE PER ROW, ON EVERY VAULT READ.
//
// scryptSync is deliberately expensive - that is the point of a KDF - and it is
// SYNCHRONOUS, so it does not merely take time, it blocks the entire Node event
// loop. This function was called once per row inside decrypt(), and
// loadOverrides() decrypts the whole table, so a single vault read cost
// (rows x 71ms) of dead server. With ~19 concurrent misses on a cold /profile
// that measured around 27 seconds during which NO route could be answered.
//
// The derivation is a pure function of the secret, and the secret set is
// bounded and tiny (SESSION_SECRET + SESSION_SECRET_PREVIOUS). Memoizing it is
// therefore both safe and complete: the cache can never grow beyond the number
// of secrets the operator has configured, and it removes the scrypt from
// encrypt() and from encryptString/decryptString on the signup path too.
const KEY_CACHE = new Map<string, Buffer>();

function cryptoKeyFrom(secret: string): Buffer {
  const s = secret || "dev-insecure-secret-change-me";
  let k = KEY_CACHE.get(s);
  if (!k) {
    k = scryptSync(s, "wheeldeal-config-v1", 32);
    KEY_CACHE.set(s, k);
  }
  return k;
}

/** Test seam - the memo is a module singleton. */
export function _resetKeyCache(): void {
  KEY_CACHE.clear();
}

// The CURRENT secret - new writes (encrypt) always use this one.
function cryptoKey(): Buffer {
  return cryptoKeyFrom(process.env.SESSION_SECRET || "dev-insecure-secret-change-me");
}

// Secrets to TRY when DECRYPTING, newest first. This is the graceful-recovery
// path for a rotated SESSION_SECRET (e.g. a host migration): the
// vault is AES-encrypted with a key derived from SESSION_SECRET, so a changed
// secret makes every stored key undecryptable and the whole vault reads empty.
// Set SESSION_SECRET_PREVIOUS to the OLD secret (comma-separated for several) and
// old rows decrypt again immediately - WITHOUT reverting the new secret. Any key
// re-saved afterwards is re-encrypted under the current secret, so the vault
// migrates itself over time. Unset -> only the current secret is tried (no
// behavior change).
function decryptSecrets(): string[] {
  const cur = process.env.SESSION_SECRET || "dev-insecure-secret-change-me";
  const prev = (process.env.SESSION_SECRET_PREVIOUS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [cur, ...prev];
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
  const [v, ivB, tagB, dataB] = blob.split(":");
  if (v !== "v1") return null;
  // Try the current secret first, then any SESSION_SECRET_PREVIOUS (rotation
  // recovery). Each attempt is isolated: a wrong key throws on final()/auth-tag
  // check, so we fall through to the next secret rather than failing the row.
  for (const secret of decryptSecrets()) {
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        cryptoKeyFrom(secret),
        Buffer.from(ivB, "base64")
      );
      decipher.setAuthTag(Buffer.from(tagB, "base64"));
      return (
        decipher.update(Buffer.from(dataB, "base64")).toString("utf8") +
        decipher.final("utf8")
      );
    } catch {
      /* wrong secret for this blob - try the next one */
    }
  }
  return null;
}

// ---- Supabase REST ----------------------------------------------------------

/**
 * THE VAULT IS NOT THE ONLY THING IN THIS TABLE.
 *
 * `/api/translate` caches its dictionaries into `app_config` under `I18N_<lang>`
 * via setConfig, which AES-encrypts them. This read had no key filter, so every
 * cold start downloaded and decrypted THE ENTIRE TRANSLATION CORPUS FOR ALL 20
 * LANGUAGES before it could answer "what is OPERATOR_NAME".
 *
 * That made the cold-start cost a monotonically increasing function of how much
 * text the app had ever translated - permanently, for everyone. And it had a
 * terminal state: once the corpus exceeded what transfers inside timedFetch's 8s
 * deadline, this threw, the catch returned {}, and getConfig silently fell
 * through to process.env for every key - where most of them are not declared.
 * The app would lose every integration key with no error anywhere.
 *
 * PostgREST `not.like` keeps the big rows server-side. They are still readable
 * by their own reader, which asks for them by exact key.
 */
const VAULT_SELECT = "select=key,value&key=not.like.I18N_*";

/**
 * WAS THE LAST VAULT READ REAL?
 *
 * loadOverrides swallows every failure and returns {} (now a short-lived
 * negative cache). That is right for the 140 call sites that want a value or a
 * default - and catastrophic for the handful that are SAFETY GATES, because
 * "the key is absent" and "I could not read the table" arrive as the same empty
 * object. `KILL_SWITCH` reads OFF during a Supabase brownout for exactly that
 * reason. This records which of the two actually happened.
 *
 * "unconfigured" is deliberately distinct from "unavailable": with no Supabase
 * connection at all the app is in env-only/demo mode, which is a supported
 * state and must not trip a fail-closed branch.
 */
type VaultReadState = "ok" | "unconfigured" | "unavailable";
let lastVaultRead: VaultReadState = "unconfigured";

export function vaultReadState(): VaultReadState {
  return lastVaultRead;
}

async function loadOverrides(): Promise<Record<string, string>> {
  const s = state();
  const conn = supabase();
  if (!conn) {
    lastVaultRead = "unconfigured";
    return s.mem;
  }

  if (s.cache && s.cache.exp > Date.now()) return { ...s.cache.data, ...s.mem };

  // ONE FETCH FOR N CONCURRENT CALLERS.
  //
  // The cache was only consulted before the await and only written after it, so
  // every caller that arrived during an in-flight read missed and started its
  // own - each paying the full download + decrypt. getSession() calls getConfig,
  // and every route calls getSession(), so a cold instance fanned this out
  // across every request in the burst. Sharing the pending promise collapses
  // that back to one.
  if (s.inflight) return s.inflight;
  const run = (async () => {
    try {
      return await fetchOverrides(conn, s);
    } finally {
      s.inflight = null;
    }
  })();
  s.inflight = run;
  return run;
}

async function fetchOverrides(
  conn: { url: string; key: string },
  s: ReturnType<typeof state>
): Promise<Record<string, string>> {
  try {
    const res = await timedFetch(
      `${conn.url}/rest/v1/app_config?${VAULT_SELECT}`,
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
    let undecryptable = 0;
    for (const row of rows) {
      const plain = decrypt(row.value);
      if (plain) data[row.key] = plain;
      // A ROW THAT WILL NOT DECRYPT IS A KEY THE APP HAS SILENTLY LOST.
      //
      // SESSION_SECRET is BOTH the cookie signing key and the vault encryption
      // key, so rotating it makes every stored key undecryptable. That was
      // handled by dropping the row with no counter, no log and no diagnostic:
      // the owner saw a working app with every integration blank and nothing
      // anywhere saying why. Count it, so the health surface can say
      // "N of M keys failed to decrypt - set SESSION_SECRET_PREVIOUS".
      else undecryptable += 1;
    }
    lastUndecryptable = { count: undecryptable, of: rows.length, at: Date.now() };
    if (undecryptable > 0) {
      console.error(
        `[vault] ${undecryptable}/${rows.length} rows failed to decrypt - SESSION_SECRET was probably rotated. Set SESSION_SECRET_PREVIOUS to the old value.`
      );
    }
    s.cache = { data, exp: Date.now() + CACHE_TTL_MS };
    lastVaultRead = "ok";
    // In-memory overrides (e.g. saved while Supabase was unreachable) win.
    return { ...data, ...s.mem };
  } catch {
    // NEGATIVE CACHING: A SLOW SUPABASE MUST NOT BECOME A FETCH STORM.
    //
    // The cache was written only on the success path, so while Supabase was
    // unhealthy there was effectively NO cache: all 140 getConfig call sites
    // issued a fresh request with an 8s abort, on every call, for as long as
    // the outage lasted. Caching the (possibly empty) fallback for a short
    // window turns an unbounded amplification into one retry per window.
    const fallback = s.cache?.data ?? {};
    s.cache = { data: fallback, exp: Date.now() + NEGATIVE_TTL_MS };
    lastVaultRead = "unavailable";
    return { ...fallback, ...s.mem };
  }
}

/** How many vault rows could not be decrypted on the last successful read.
 *  Surfaced by the health route so a rotated secret is visible, not silent. */
let lastUndecryptable: { count: number; of: number; at: number } | null = null;

export function vaultDecryptHealth(): { count: number; of: number; at: number } | null {
  return lastUndecryptable;
}

/** Effective value for a key: Supabase override first, then process.env. */
export async function getConfig(name: string): Promise<string | undefined> {
  const overrides = await loadOverrides();
  return overrides[name] ?? process.env[name];
}

/**
 * THE EXACT-KEY READER THE VAULT COMMENT PROMISED - I-6a.
 *
 * `VAULT_SELECT` filters `key=not.like.I18N_*` so the huge translation
 * dictionaries never ride the whole-table vault read (they would make cold
 * start a monotonically growing cost for every key lookup). The comment beside
 * it claimed those rows were "still readable by their own reader, which asks
 * for them by exact key" - but that reader was never written, and the translate
 * route read the cache with plain `getConfig`, which goes through the SAME
 * filtered load and therefore returned undefined every time.
 *
 * The consequence was a live LLM cost leak: every cold load in a non-English
 * language re-translated the ENTIRE catalogue and wrote back a row that nothing
 * could ever read, so the next cold load did it again. This is the reader that
 * closes the loop - one row, by exact key, decrypted the same way the vault
 * decrypts everything else.
 *
 * It deliberately does NOT touch the loadOverrides cache: these rows are large
 * and read rarely (once per language per cold load), so caching them is exactly
 * what the exclusion filter exists to prevent.
 */
export async function getConfigExact(name: string): Promise<string | undefined> {
  const s = state();
  // A value written this session (Supabase unreachable) is plaintext in mem.
  if (s.mem[name]) return s.mem[name];
  const conn = supabase();
  if (!conn) return process.env[name];
  try {
    const res = await timedFetch(
      `${conn.url}/rest/v1/app_config?select=value&key=eq.${encodeURIComponent(name)}&limit=1`,
      {
        headers: { apikey: conn.key, Authorization: `Bearer ${conn.key}` },
        cache: "no-store",
      }
    );
    if (!res.ok) return process.env[name];
    const rows = (await res.json()) as { value: string }[];
    const raw = rows[0]?.value;
    if (raw === undefined) return process.env[name];
    // setConfig always encrypts, so decrypt first; fall back to the raw value
    // for any legacy plaintext row, mirroring how fetchOverrides treats rows.
    return decrypt(raw) ?? raw;
  } catch {
    return process.env[name];
  }
}

/**
 * STRICT variant of getConfig for SAFETY GATES, where "not set" and "could not
 * be read" must lead to opposite decisions.
 *
 * getConfig cannot tell them apart: a brownout makes loadOverrides return {},
 * and if the key is not in process.env either (KILL_SWITCH is not in the deploy
 * env list) the caller sees `undefined` and concludes the switch is off. The
 * kill switch turning ITSELF off during a dependency wobble is the single worst
 * failure mode in this file.
 *
 * A value found in process.env is still authoritative during an outage - the
 * environment does not go unreadable - so only a genuine miss escalates.
 */
export async function getConfigStrict(
  name: string
): Promise<{ value: string | undefined } | { error: "unavailable" }> {
  const overrides = await loadOverrides();
  const hit = overrides[name] ?? process.env[name];
  if (hit !== undefined) return { value: hit };
  if (vaultReadState() === "unavailable") return { error: "unavailable" };
  return { value: undefined };
}

/**
 * MANY KEYS, ONE VAULT READ.
 *
 * `Promise.all(names.map(getConfig))` looks equivalent and is not: before the
 * in-flight dedupe above, revealKeys() fanned 52 keys into 52 simultaneous
 * full-table downloads, and /api/config/public did the same with 6. The dedupe
 * fixes the worst of that, but this makes the intent explicit at the call site
 * and is correct regardless of how the cache is behaving.
 */
export async function getConfigMany(
  names: readonly string[]
): Promise<Record<string, string | undefined>> {
  const overrides = await loadOverrides();
  const out: Record<string, string | undefined> = {};
  for (const n of names) out[n] = overrides[n] ?? process.env[n];
  return out;
}

/**
 * Resolve the Google OAuth client ID with a resilient, multi-source fallback so
 * Google sign-in survives a vault miss (a decryption failure when SESSION_SECRET
 * differs between hosts, an unreachable Supabase, or the value simply never
 * pasted into the Key Vault). getConfig already fails over from the vault to
 * `process.env.GOOGLE_OAUTH_CLIENT_ID`; this adds the alternate PUBLIC env name
 * that the build inlines (`NEXT_PUBLIC_GOOGLE_CLIENT_ID`), which is the name the
 * client ID is usually provided under on a fresh Cloud Run deploy. The
 * client ID is public by design, so surfacing it from any of these sources is
 * safe - it only ever gates which account the button signs in as. `||` (not
 * `??`) also skips an empty-string stored value, not just a null one.
 */
export async function getGoogleClientId(): Promise<string | undefined> {
  return (
    (await getConfig("GOOGLE_OAUTH_CLIENT_ID")) ||
    process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ||
    undefined
  );
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
        "Saved for this session only: Supabase is not connected (set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in GCP Secret Manager), so the value will reset on the next deploy/restart.",
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
          ? "Invalid Supabase key: SUPABASE_SERVICE_ROLE_KEY in GCP Secret Manager is wrong (it may be the anon key, have a typo, or the project keys were rotated). Copy the service_role key from Supabase -> Settings -> API, update GCP Secret Manager, redeploy, then use Admin -> Keys -> Test Supabase."
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
