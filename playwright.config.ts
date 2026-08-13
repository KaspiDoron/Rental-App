import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

// THE BROWSER SUITE (owner report 3, wave 4.1).
//
// This repo's own stated failure mode is that a fully green unit suite missed
// every one of the owner's reported symptoms, because they were BROWSER facts:
// a clipped chevron, a mid-screen tab bar, a wordmark spelled backwards under
// RTL. scripts/mobile-check.mjs proved the harness (production build, real
// Chromium, seeded network); this config generalises it into a journey suite.
//
// WHAT IS REAL: the production `next start` build, the real React tree, the
// compiled CSS, real Chromium layout at real phone widths. WHAT IS FAKED: only
// the network edges that need external services (Places, Supabase, Evolution)
// - stubbed per-spec via page.route, exactly like mobile-check.
//
// NOT COVERED here, deliberately (each has its own harness or is out of
// browser reach): real WhatsApp pairing, inbound mid-poll webhook delivery
// (packages/testing owns that layer), LLM output quality, live Google Places,
// the PayPal off-site checkout, email OTP delivery, real push delivery, and
// server-side pacing/anti-ban behaviour (vitest owns those).
//
// scripts/mobile-check.mjs stays as the independent, falsified layout check -
// this suite does not replace it.

const PORT = 3399;

// TEST-ONLY literal, checked in on purpose (same rule as mobile-check's): the
// specs mint session cookies with it, so it must match the webServer env.
// Never a real secret.
export const E2E_SESSION_SECRET = "e2e-session-secret-not-a-real-one";

/** Resolve the preinstalled Chromium exactly like mobile-check's chromiumPath. */
function chromiumPath(): string | undefined {
  if (process.env.MOBILE_CHECK_CHROMIUM) return process.env.MOBILE_CHECK_CHROMIUM;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (root && existsSync(`${root}/chromium`)) return `${root}/chromium`;
  return undefined;
}
const exe = chromiumPath();

const mobile = (width: number, height = 844) => ({
  viewport: { width, height },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 40_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "on-first-retry",
    ...(exe ? { launchOptions: { executablePath: exe } } : {}),
  },
  // Playwright's own webServer replaces mobile-check's portIsBusy dance:
  // reuseExistingServer: false is the stale-build guard - it REFUSES to run
  // against a server it did not boot, so the suite can never silently measure
  // an hour-old orphan's build.
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}/welcome`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NODE_ENV: "production",
      SESSION_SECRET: E2E_SESSION_SECRET,
      // No Supabase, no Google, no Evolution: every integration degrades to a
      // no-key fallback, which is exactly what makes the suite runnable.
      SUPABASE_URL: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
      ADMIN_EMAILS: "admin@e2e.test",
      // The invite-only beta gate is ON by default and would clear any minted
      // session whose email is not on the owner's tester list. The switch is
      // the app's own documented dial, not a test backdoor.
      BETA_LOCK: "off",
    },
  },
  // PROJECTS. mobile-375 is the primary lane and runs every spec that is not
  // owned by a specialised project. The CLAUDE.md rule "test at 320-430px" is
  // encoded as the @allwidths tag: layout-sensitive specs opt in and run at
  // the ends of the range too. @rtl runs under a Hebrew-locale project,
  // @reduced under prefers-reduced-motion, @signedout with no session at all.
  projects: [
    {
      name: "mobile-375",
      grepInvert: /@rtl|@reduced/,
      use: mobile(375, 812),
    },
    { name: "mobile-320", grep: /@allwidths/, use: mobile(320) },
    { name: "mobile-430", grep: /@allwidths/, use: mobile(430, 932) },
    { name: "rtl-he", grep: /@rtl/, use: mobile(375, 812) },
    {
      name: "reduced-motion",
      grep: /@reduced/,
      use: { ...mobile(375, 812), contextOptions: { reducedMotion: "reduce" } },
    },
    { name: "signed-out", grep: /@signedout/, use: mobile(375, 812) },
  ],
});
