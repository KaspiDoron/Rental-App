// Cookie-based sessions with a three-tier role model.
//
// owner  - the single OWNER_EMAIL (default kaspidoron@gmail.com). Can do
//          everything, including managing management.
// admin  - ADMIN_EMAILS env allowlist + admins added at runtime by management
//          (stored in the encrypted Key Vault under ADMIN_EMAILS_EXTRA).
// user   - everyone else.
//
// The cookie is an HMAC-signed token holding only the email; the role is
// re-derived on every request so promotions/demotions apply instantly.

import "server-only";
import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { getConfig, setConfig } from "./runtime-config";
import type { Session, Role } from "./types";

const COOKIE = "wd_session";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function secret(): string {
  return process.env.SESSION_SECRET || "dev-insecure-secret-change-me";
}

export function ownerEmail(): string {
  return (process.env.OWNER_EMAIL || "kaspidoron@gmail.com").toLowerCase();
}

export function isOwner(email: string): boolean {
  return email.trim().toLowerCase() === ownerEmail();
}

function envAdmins(): string[] {
  return (process.env.ADMIN_EMAILS || "kaspidoron@gmail.com")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** Full management list: owner + env admins + runtime-added admins. */
export async function adminEmails(): Promise<string[]> {
  const extra = ((await getConfig("ADMIN_EMAILS_EXTRA")) || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set([ownerEmail(), ...envAdmins(), ...extra]));
}

export async function roleFor(email: string): Promise<Role> {
  const e = email.trim().toLowerCase();
  if (isOwner(e)) return "owner";
  if ((await adminEmails()).includes(e)) return "admin";
  return "user";
}

/** Add or remove a runtime admin (management action). Owner is immutable. */
export async function setAdmin(email: string, admin: boolean): Promise<void> {
  const e = email.trim().toLowerCase();
  if (isOwner(e)) return;
  const extra = new Set(
    ((await getConfig("ADMIN_EMAILS_EXTRA")) || "")
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean)
  );
  if (admin) extra.add(e);
  else extra.delete(e);
  await setConfig("ADMIN_EMAILS_EXTRA", Array.from(extra).join(","));
}

// ---- cookie plumbing --------------------------------------------------------

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("hex");
}

export function setSessionCookie(email: string) {
  const payload = JSON.stringify({
    email: email.toLowerCase(),
    issuedAt: Date.now(),
  });
  const b64 = Buffer.from(payload).toString("base64url");
  cookies().set(COOKIE, `${b64}.${sign(b64)}`, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export function clearSessionCookie() {
  cookies().delete(COOKIE);
}

function decode(token: string | undefined): { email: string; issuedAt: number } | null {
  if (!token) return null;
  const [b64, sig] = token.split(".");
  if (!b64 || !sig) return null;
  const expected = sign(b64);
  try {
    if (
      sig.length !== expected.length ||
      !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    ) {
      return null;
    }
    return JSON.parse(Buffer.from(b64, "base64url").toString());
  } catch {
    return null;
  }
}

/** Current session with a freshly-derived role, or null. */
export async function getSession(): Promise<Session | null> {
  const raw = decode(cookies().get(COOKIE)?.value);
  if (!raw?.email) return null;
  return { email: raw.email, issuedAt: raw.issuedAt, role: await roleFor(raw.email) };
}

/** True for owner or admin. */
export async function requireManagement(): Promise<Session | null> {
  const s = await getSession();
  return s && s.role !== "user" ? s : null;
}
