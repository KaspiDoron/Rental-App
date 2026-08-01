import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

import { resolveThreadLanguage } from "./thread-language";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// A THREAD IS OPENED IN ONE LANGUAGE AND STAYS IN IT.
//
// The local-language toggle is a GLOBAL switch on the search screen. Flip it
// after the batch has gone out - out of curiosity, or by accident, or to
// "improve" the open conversations - and every subsequent message in every
// already-open thread changed language mid-conversation. From the shop's side,
// the person they have been messaging in Thai for ten minutes suddenly writes
// English, then Thai again. That is not a bilingual customer; that is a bot,
// which is the one thing the whole anti-fingerprinting effort exists to avoid.

describe("the opener decides, not the switch", () => {
  it("REPRODUCTION: turning it ON mid-hunt does not flip an English thread", () => {
    // The direction people actually hit.
    expect(resolveThreadLanguage({ requested: true, established: false })).toEqual({
      localLang: false,
      overridden: true,
    });
  });

  it("...and turning it OFF does not flip a Thai one", () => {
    expect(resolveThreadLanguage({ requested: false, established: true })).toEqual({
      localLang: true,
      overridden: true,
    });
  });

  it("a thread that has not started yet honours the toggle", () => {
    expect(resolveThreadLanguage({ requested: true, established: null })).toEqual({
      localLang: true,
      overridden: false,
    });
    expect(resolveThreadLanguage({ requested: false, established: null })).toEqual({
      localLang: false,
      overridden: false,
    });
  });

  it("agreeing with the thread is not an override", () => {
    expect(resolveThreadLanguage({ requested: true, established: true }).overridden).toBe(false);
  });
});

describe("the send path asks the thread, not just the request body", () => {
  const route = readCode("src/app/api/outreach/route.ts");

  it("the established language is read and applied", () => {
    expect(route).toMatch(/const established = await threadLanguageMode\(session\.email, digits\);/);
    expect(route).toMatch(/const langChoice = resolveThreadLanguage\(\{ requested: requestedLocal, established \}\);/);
    expect(route).toMatch(/const wantsLocal = langChoice\.localLang;/);
  });

  it("and the stored row records what was ACTUALLY used", () => {
    // It used to re-derive the flag from the request body at write time, so a
    // thread's history could disagree with the message that was sent.
    expect(route).not.toMatch(/localLang: Boolean\(body\.localLang\) && session\.plan === "ultra"/);
    expect((route.match(/localLang: wantsLocal/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("the OLDEST outbound row is the authority", () => {
    const lib = readCode("src/lib/wa/thread-language.ts");
    expect(lib).toMatch(/order=received_at\.asc&limit=1/);
    // An unreadable database must degrade to the caller's preference, never
    // silently flip a live thread.
    expect(lib).toMatch(/return null;/);
  });
});

describe("and the switch says so instead of ignoring the tap", () => {
  const page = readCode("src/app/page.tsx");

  it("it locks once anything has been sent, queued or answered", () => {
    expect(page).toMatch(/const languageLocked = vendors\.some\(/);
    expect(page).toMatch(/Boolean\(v\.sentText\)/);
    expect(page).toMatch(/Boolean\(v\.queuedUntil\)/);
    expect(page).toMatch(/\["rfq-sent", "awaiting-response", "negotiating"\]\.includes\(v\.stage \?\? ""\)/);
  });

  it("...and the button is honestly disabled, with the reason", () => {
    expect(page).toMatch(/disabled=\{languageLocked\}/);
    expect(page).toMatch(/if \(languageLocked\) return;/);
    expect(page).toMatch(/The language is set for this hunt - start a new search to change it\./);
  });
});
