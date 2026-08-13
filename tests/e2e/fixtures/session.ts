import { createHmac } from "node:crypto";
import type { BrowserContext } from "@playwright/test";
import { E2E_SESSION_SECRET } from "../../../playwright.config";

// Session minting, lifted from scripts/mobile-check.mjs:69-73 - the same
// base64url + HMAC shape src/lib/session.ts writes. A dedicated guard spec
// (auth-redirects) proves a cookie signed with the WRONG secret bounces, so
// this fixture cannot silently drift into forging something the server would
// never accept.

export function mintSessionCookie(email: string, secret: string = E2E_SESSION_SECRET): string {
  const b64 = Buffer.from(JSON.stringify({ email, issuedAt: Date.now() })).toString("base64url");
  const sig = createHmac("sha256", secret).update(b64).digest("hex");
  return `${b64}.${sig}`;
}

/** Sign the context in as `email` (default: an ordinary traveller). */
export async function signIn(
  context: BrowserContext,
  email = "traveller@e2e.test",
  opts?: { secret?: string }
): Promise<void> {
  await context.addCookies([
    {
      name: "wd_session",
      value: mintSessionCookie(email, opts?.secret),
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
    },
  ]);
}
