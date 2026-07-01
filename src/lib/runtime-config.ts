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
  const url =
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ""), key };
}

export function supabaseConfigured(): boolean {
  return supabase() !== null;
}

/** Insert rows into a Supabase table via the service role. No-op if unset. */
export async function sbInsert(
  table: string,
  rows: Record<string, unknown>[]
): Promise<boolean> {
  const conn = supabase();
  if (!conn || rows.length === 0) return false;
  try {
    const res = await fetch(`${conn.url}/rest/v1/${table}`, {
      method: "POST",
      headers: {
        apikey: conn.key,
        Authorization: `Bearer ${conn.key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(rows),
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

  if (s.cache && s.cache.exp > Date.now()) return s.cache.data;
  try {
    const res = await fetch(
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
    return data;
  } catch {
    return s.cache?.data ?? {};
  }
}

/** Effective value for a key: Supabase override first, then process.env. */
export async function getConfig(name: string): Promise<string | undefined> {
  const overrides = await loadOverrides();
  return overrides[name] ?? process.env[name];
}

/** Persist (or clear) a runtime override. */
export async function setConfig(name: string, value: string): Promise<void> {
  const s = state();
  const conn = supabase();

  if (!conn) {
    if (value) s.mem[name] = value;
    else delete s.mem[name];
    s.cache = null;
    return;
  }

  if (value) {
    await fetch(`${conn.url}/rest/v1/app_config`, {
      method: "POST",
      headers: {
        apikey: conn.key,
        Authorization: `Bearer ${conn.key}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify([
        { key: name, value: encrypt(value), updated_at: new Date().toISOString() },
      ]),
    });
  } else {
    await fetch(
      `${conn.url}/rest/v1/app_config?key=eq.${encodeURIComponent(name)}`,
      {
        method: "DELETE",
        headers: { apikey: conn.key, Authorization: `Bearer ${conn.key}` },
      }
    );
  }
  s.cache = null;
}
