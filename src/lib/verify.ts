// Email-ownership verification for signup. A user CANNOT create an account until
// they prove they control the email: we email a 6-digit code, store the pending
// signup (encrypted) + a hash of the code, and only create the account once the
// code is confirmed. Durable in Supabase so it survives serverless restarts.

import "server-only";
import { createHash, randomInt } from "crypto";
import {
  sbSelect,
  sbInsert,
  sbDelete,
  encryptString,
  decryptString,
  supabaseConfigured,
} from "./runtime-config";
import { sendEmail } from "./email";

const TTL_MS = 15 * 60_000; // codes expire after 15 minutes
const RESEND_GAP_MS = 30_000; // do not spam: 30s between sends per email

export interface PendingSignup {
  email: string;
  phone?: string;
  password?: string;
  acceptedTerms: boolean;
}

function hashCode(email: string, code: string): string {
  return createHash("sha256").update(`${email.toLowerCase()}:${code}`).digest("hex");
}

// In-memory fallback when Supabase is not configured (dev only).
declare global {
  // eslint-disable-next-line no-var
  var __wd_email_verify__: Map<string, { codeHash: string; payload: string; exp: number; sentAt: number }> | undefined;
}
function memStore() {
  if (!globalThis.__wd_email_verify__) globalThis.__wd_email_verify__ = new Map();
  return globalThis.__wd_email_verify__;
}

/** True when we can actually send verification emails (Brevo or Resend). */
export async function emailVerificationAvailable(): Promise<boolean> {
  const { getConfig } = await import("./runtime-config");
  return Boolean((await getConfig("BREVO_API_KEY")) || (await getConfig("RESEND_API_KEY")));
}

/**
 * Generate + email a 6-digit code and stash the pending signup. Returns
 * { ok } on success, or an error the caller surfaces to the user.
 */
export async function startEmailVerification(
  pending: PendingSignup
): Promise<{ ok: boolean; error?: string; cooldown?: boolean }> {
  const email = pending.email.toLowerCase();

  // Rate-limit resends.
  const existing = await readRow(email);
  if (existing && Date.now() - existing.sentAt < RESEND_GAP_MS) {
    return { ok: false, cooldown: true, error: "Please wait a few seconds before requesting another code." };
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const row = {
    codeHash: hashCode(email, code),
    payload: encryptString(JSON.stringify(pending)),
    exp: Date.now() + TTL_MS,
    sentAt: Date.now(),
  };
  await writeRow(email, row);

  const res = await sendEmail({
    to: [email],
    subject: `Your WheelDeal verification code: ${code}`,
    html: `<div style="font-family:system-ui,Arial,sans-serif;max-width:420px;margin:auto">
      <h2 style="color:#2f6fed">Confirm your email</h2>
      <p>Welcome to WheelDeal! Enter this code to finish creating your account:</p>
      <div style="font-size:34px;font-weight:800;letter-spacing:8px;background:#eef3ff;color:#1b2a4a;padding:16px;border-radius:14px;text-align:center">${code}</div>
      <p style="color:#6b7280;font-size:13px">This code expires in 15 minutes. If you did not request it, ignore this email.</p>
    </div>`,
  });
  if (!res.sent) {
    return {
      ok: false,
      error:
        res.reason === "unconfigured"
          ? "Email verification is not set up yet (owner: add a Resend API key in Owner -> Keys)."
          : `Could not send the verification email: ${res.error ?? "unknown error"}.`,
    };
  }
  return { ok: true };
}

/** Verify a code. On success returns the pending signup and clears the record. */
export async function confirmEmailVerification(
  emailRaw: string,
  code: string
): Promise<{ ok: boolean; pending?: PendingSignup; error?: string }> {
  const email = emailRaw.toLowerCase();
  const row = await readRow(email);
  if (!row) return { ok: false, error: "No pending verification - start signup again." };
  if (Date.now() > row.exp) {
    await clearRow(email);
    return { ok: false, error: "This code expired - start signup again to get a new one." };
  }
  if (row.codeHash !== hashCode(email, String(code).trim())) {
    return { ok: false, error: "Wrong code. Check the email and try again." };
  }
  const decoded = decryptString(row.payload);
  await clearRow(email);
  if (!decoded) return { ok: false, error: "Verification data was corrupted - start signup again." };
  return { ok: true, pending: JSON.parse(decoded) as PendingSignup };
}

// ---- storage (durable Supabase, else in-memory) ------------------------------

interface Row { codeHash: string; payload: string; exp: number; sentAt: number }

async function readRow(email: string): Promise<Row | null> {
  if (supabaseConfigured()) {
    const rows = await sbSelect<{ code_hash: string; payload: string; expires_at: string; sent_at: string }>(
      "email_verifications",
      `select=code_hash,payload,expires_at,sent_at&email=eq.${encodeURIComponent(email)}&limit=1`
    );
    const r = rows[0];
    return r
      ? { codeHash: r.code_hash, payload: r.payload, exp: Date.parse(r.expires_at), sentAt: Date.parse(r.sent_at) }
      : null;
  }
  return memStore().get(email) ?? null;
}

async function writeRow(email: string, row: Row): Promise<void> {
  if (supabaseConfigured()) {
    await sbInsert(
      "email_verifications",
      [
        {
          email,
          code_hash: row.codeHash,
          payload: row.payload,
          expires_at: new Date(row.exp).toISOString(),
          sent_at: new Date(row.sentAt).toISOString(),
        },
      ],
      "email"
    );
  } else {
    memStore().set(email, row);
  }
}

async function clearRow(email: string): Promise<void> {
  if (supabaseConfigured()) await sbDelete("email_verifications", `email=eq.${encodeURIComponent(email)}`);
  else memStore().delete(email);
}
