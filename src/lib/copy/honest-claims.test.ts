import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const REPO = process.cwd();
const read = (p: string) => readFileSync(join(REPO, p), "utf8");

// THE APP TOLD USERS IT DID THINGS IT DID NOT DO.
//
// Six independent investigations that were not looking for this each found it,
// in different files. Eight user-facing strings asserted safety properties the
// verified code did not have - on the exact surface that induces someone to
// link their personal phone number.
//
// A disclaimer elsewhere does not cure an affirmative misstatement of present
// fact made to induce the transaction. That is the shape of the exposure, and
// it is also just dishonest, which is reason enough.
//
// Two rules are pinned here, and they pull in opposite directions:
//   1. NOWHERE may claim an outcome we do not control.
//   2. The consent screen MUST name the risk plainly - vagueness there is the
//      failure, not the safety.

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\/.*$/gm, "");

/**
 * The three files where naming the risk plainly is REQUIRED. Everywhere else
 * the app describes pacing in quality-control terms, because a traveller
 * mid-search does not need to be told about bans - but consent has to be
 * informed to be consent.
 */
const RISK_LANGUAGE_ALLOWED = [
  "src/components/WaConnect.tsx",
  "src/components/WaTermsModal.tsx",
  "src/components/landing/TrustPanel.tsx",
  "src/components/landing/LandingFaq.tsx",
];

describe("no surface claims an outcome WhatsApp decides", () => {
  const files = [
    "src/components/landing/TrustPanel.tsx",
    "src/components/WaConnect.tsx",
    "src/components/landing/LandingFaq.tsx",
    "src/app/pricing/page.tsx",
    "src/components/WaSafetyBadge.tsx",
  ];

  it.each(files)("%s makes no absolute safety guarantee", (f) => {
    const code = stripComments(read(f));
    expect(code).not.toMatch(/never put at risk/i);
    expect(code).not.toMatch(/100% safe|completely safe|fully protected/i);
    expect(code).not.toMatch(/guarantee(s|d)? (your|the) (number|account|safety)/i);
  });

  it("REGRESSION: the eight specific false claims are gone", () => {
    const trust = stripComments(read("src/components/landing/TrustPanel.tsx"));
    const connect = stripComments(read("src/components/WaConnect.tsx"));
    const faq = stripComments(read("src/components/landing/LandingFaq.tsx"));
    const pricing = stripComments(read("src/app/pricing/page.tsx"));
    const badge = stripComments(read("src/components/WaSafetyBadge.tsx"));

    // 1. warm-up that effectiveNewContactCap deliberately does not do
    expect(trust).not.toMatch(/warmed up gently/i);
    // 2. "never at 3am" while FAST_DISPATCH defaults ON
    expect(trust).not.toMatch(/never at 3am/i);
    // 3. a detector that could not fire
    expect(trust).not.toMatch(/at the first sign of risk/i);
    expect(faq).not.toMatch(/automatic break at the first sign/i);
    // 4. a blue tick used to unlock a follow-up
    expect(trust).not.toMatch(/One conversation per shop per day/i);
    // 5. the socket stays open with keepalives running
    expect(connect).not.toMatch(/goes back to sleep - no activity/i);
    // 6. whatsapp_messages rows survive a disconnect
    expect(connect).not.toMatch(/every trace of the link is erased/i);
    // 7. an absolute guarantee on the page where money changes hands
    expect(pricing).not.toMatch(/never put at risk/i);
    // 8. raising the idea in order to deny it
    expect(badge).not.toMatch(/never spammy/i);
  });

  it("the replacements state the limit rather than omitting it", () => {
    const trust = read("src/components/landing/TrustPanel.tsx");
    expect(trust).toMatch(/What we cannot promise/);
    expect(trust).toMatch(/Safeguards, not a guarantee/);
    expect(read("src/app/pricing/page.tsx")).toMatch(/Safeguards, not a guarantee/);
  });
});

describe("the consent screen names the risk plainly - constraint 5's positive half", () => {
  const connect = read("src/components/WaConnect.tsx");

  it("REPRODUCTION: the short version no longer omits the only material term", () => {
    expect(connect).not.toMatch(/The short version: your number, your control/);
  });

  it("it says unofficial, and it says restrict or ban", () => {
    expect(connect).toMatch(/unofficial connection/i);
    expect(connect).toMatch(/restrict or ban a number/i);
  });

  it("it tells the user which number to link", () => {
    expect(connect).toMatch(/could manage without/i);
  });

  it("TERMS_VERSION was bumped so existing linked users re-accept", () => {
    // The thing they previously agreed to was not what the document said.
    expect(read("src/lib/legal.ts")).toMatch(/TERMS_VERSION = "2026-08-08"/);
  });
});

describe("ban language stays off every other surface", () => {
  // Constraint 5: operational pacing is framed as quality control and vendor
  // batching everywhere except linking/consent. This is the mechanical version
  // of that rule, so new wave/queue copy cannot quietly undo it.
  const components = walk(join(REPO, "src/components")).filter(
    (f) => !f.endsWith(".test.tsx")
  );

  it("finds the components (guards against a silent empty sweep)", () => {
    expect(components.length).toBeGreaterThan(20);
  });

  it.each(components.map((f) => [f.slice(REPO.length + 1), f] as const))(
    "%s",
    (rel, full) => {
      if (RISK_LANGUAGE_ALLOWED.includes(rel)) return;
      const code = stripComments(readFileSync(full, "utf8"));
      // Only user-visible strings matter, so look inside t("...") calls and
      // plain quoted copy - not identifiers like `blocked` or `isBanned`.
      const banWords = /\b(ban|banned|anti-ban|blacklist)\b/i;
      const strings = code.match(/t\(\s*"([^"]{12,})"/g) ?? [];
      for (const s of strings) {
        expect(s, `${rel} ships ban language to a traveller: ${s}`).not.toMatch(banWords);
      }
    }
  );
});
