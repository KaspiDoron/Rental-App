import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { queueReasonWhy, queueReasonLabel } from "./queue-reason";

vi.mock("server-only", () => ({}));

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// COLD INTRODUCTIONS WAIT FOR THE SHOP TO OPEN - the owner's speed-vs-safety
// decision, and the explanation that has to come with it.
//
// `FAST_DISPATCH` shipped ON, lifting the business-hours clamp so the whole
// introduction batch fired at any hour. Unsolicited first contact at 03:00
// local is the pattern WhatsApp meters for restrictions, and it buys the
// traveller nothing: a message to a closed shop is read at opening either way.
//
// The half that is easy to get wrong is the UI. A traveller who sees a shop
// sitting untouched until tomorrow morning, with no reason given, concludes the
// app is broken - and the fix would be to turn the risk back on. So the wait has
// to explain itself, and has to say plainly that shops ALREADY talking to them
// are answered immediately.

describe("the default is off, and fails safe", () => {
  const guard = readCode("src/lib/wa-guard.ts");

  it("cold intros respect business hours out of the box", () => {
    expect(guard).toMatch(/fast_dispatch: false,/);
  });

  it("an unreadable config keeps the safe default, never the fast one", () => {
    // `parseFlag(raw, true)` would have handed cold outreach a 24/7 licence on
    // any config read failure - the fail-open shape this repo keeps paying for.
    expect(guard).toMatch(/parseFlag\(fastRaw, DEFAULTS\.fast_dispatch\)/);
    expect(guard).not.toMatch(/parseFlag\(fastRaw, true\)/);
  });

  it("the owner can still turn it back on", () => {
    expect(guard).toMatch(/FAST_DISPATCH/);
  });
});

describe("the traveller is told WHY, not just that they are waiting", () => {
  it("a closed shop explains the reason and the trade", () => {
    const why = queueReasonWhy("shop is closed now");
    expect(why).toBeTruthy();
    expect(why).toMatch(/closed/i);
    // The reassurance that stops this reading as brokenness.
    expect(why).toMatch(/already talking to you are answered immediately/i);
  });

  it("...and the short label still says what happens next", () => {
    expect(queueReasonLabel("shop is closed now")).toMatch(/shop to open/i);
  });

  it("the daily-batch and breaker waits explain themselves too", () => {
    for (const raw of [
      "daily introductions used",
      "introductions full - refreshes soon",
      "cold outreach frozen",
    ]) {
      expect(queueReasonWhy(raw), raw).toBeTruthy();
    }
  });

  it("a routine pacing gap gets NO essay - only the real waits explain", () => {
    // A 20-second gap does not need a paragraph. Explaining everything is how
    // the explanations stop being read.
    expect(queueReasonWhy("min gap pacing")).toBeNull();
    expect(queueReasonWhy(undefined)).toBeNull();
  });

  it("every explanation says the open conversations keep running", () => {
    // This is the load-bearing claim. Agent REPLIES skip the business-hours
    // clamp entirely, so the traveller loses no speed where it counts - and if
    // the copy does not say so, the wait looks like the whole app stopping.
    for (const raw of [
      "shop is closed now",
      "daily introductions used",
      "introductions full - refreshes soon",
      "cold outreach frozen",
    ]) {
      expect(queueReasonWhy(raw), raw).toMatch(
        /already talking to you|already open|already replying|wrote to you/i
      );
    }
  });
});

describe("the explanation actually reaches the screen", () => {
  it("the shop card renders it under the queued badge", () => {
    const card = readCode("src/components/VendorCard.tsx");
    expect(card).toMatch(/queueReasonWhy\(vendor\.queuedReason\)/);
  });

  it("and it is translatable - computed copy needs the extras list", () => {
    // `t(queueReasonWhy(...))` has no literal for the catalogue generator to
    // find, so without the extras entry it renders in English for everyone.
    const catalog = read("src/lib/i18n-catalog.ts");
    expect(catalog).toContain("This shop is closed right now.");
  });
});
