// Passwordless, cookie-based sessions.
//
// Production wiring would send a magic link via email (Supabase Auth / Resend).
// For a zero-setup demo we issue a signed session as soon as an email is
// submitted. The cookie is an HMAC-signed token - it cannot be forged without
// SESSION_SECRET - and admin status is derived from the ADMIN_EMAILS allowlist,
// never from client input.

import "server-only";
import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import type { Session } from "./types";

const COOKIE = "wd_session";
const MAX_AGE = 60 * 60 * 24 * 7; // 7 days

function secret(): string {
  return process.env.SESSION_SECRET || "dev-insecure-secret-change-me";
}

export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS || "doron@pristivo.com")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminEmail(email: string): boolean {
  return adminEmails().includes(email.trim().toLowerCase());
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("hex");
}

export function encodeSession(email: string): string {
  const payload = JSON.stringify({
    email: email.toLowerCase(),
    isAdmin: isAdminEmail(email),
    issuedAt: Date.now(),
  });
  const b64 = Buffer.from(payload).toString("base64url");
  return `${b64}.${sign(b64)}`;
}

export function decodeSession(token: string | undefined): Session | null {
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
    const session = JSON.parse(
      Buffer.from(b64, "base64url").toString()
    ) as Session;
    // Re-derive admin from the current allowlist so revocation is instant.
    session.isAdmin = isAdminEmail(session.email);
    return session;
  } catch {
    return null;
  }
}

export function setSessionCookie(email: string) {
  cookies().set(COOKIE, encodeSession(email), {
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

export function getSession(): Session | null {
  return decodeSession(cookies().get(COOKIE)?.value);
}
