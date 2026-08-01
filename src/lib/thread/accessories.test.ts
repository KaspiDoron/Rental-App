import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

import {
  mergeAccessoryVerdicts,
  unansweredAccessories,
  accessorySummary,
  MIN_CONFIDENCE,
} from "./accessories";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// THE REQUEST LEFT THE APP AND NEVER CAME BACK.
//
// Helmets, a phone mount, a GoPro bracket, delivery to the hotel: all of it
// went out in the opening message and then vanished from the app's model of the
// world. The card showed a price; the booking sheet showed the REQUEST with
// green ticks beside it. Nothing anywhere recorded that the shop had said
// "helmet yes, no GoPro mount" - so a traveller could lock a deal believing a
// mount was coming.

const REQUESTED = ["2 helmets", "GoPro mount"];
const at = 1_700_000_000_000;

describe("the merge keeps what the shop actually decided", () => {
  it("an unanswered extra is present and honestly unknown, not absent", () => {
    // Absent renders as "we never asked", which is false.
    const out = mergeAccessoryVerdicts(undefined, [], { requested: REQUESTED, at });
    expect(out.map((o) => o.item)).toEqual(REQUESTED);
    expect(out.every((o) => o.state === "unknown")).toBe(true);
  });

  it("a confirmation sticks, with the number and the shop's own words", () => {
    const out = mergeAccessoryVerdicts(
      undefined,
      [{ item: "2 helmets", verdict: "confirmed", extraCost: 50, quote: "helmet 50 baht", confidence: 0.9 }],
      { requested: REQUESTED, at }
    );
    const helmets = out.find((o) => o.item === "2 helmets")!;
    expect(helmets.state).toBe("confirmed");
    expect(helmets.extraCost).toBe(50);
    expect(helmets.quote).toBe("helmet 50 baht");
    expect(helmets.at).toBe(at);
  });

  it("REPRODUCTION: 'unmentioned' does NOT un-confirm an earlier yes", () => {
    // The naive last-write-wins merge would wipe the helmet verdict on every
    // subsequent turn - and most turns are about something else.
    const first = mergeAccessoryVerdicts(
      undefined,
      [{ item: "2 helmets", verdict: "confirmed", confidence: 0.9 }],
      { requested: REQUESTED, at }
    );
    const second = mergeAccessoryVerdicts(
      first,
      [
        { item: "2 helmets", verdict: "unmentioned", confidence: 0.9 },
        { item: "GoPro mount", verdict: "unmentioned", confidence: 0.9 },
      ],
      { requested: REQUESTED, at: at + 60_000 }
    );
    expect(second.find((o) => o.item === "2 helmets")!.state).toBe("confirmed");
  });

  it("...but a real change of mind DOES land - shops find a second helmet", () => {
    const first = mergeAccessoryVerdicts(
      undefined,
      [{ item: "2 helmets", verdict: "refused", confidence: 0.9 }],
      { requested: REQUESTED, at }
    );
    const second = mergeAccessoryVerdicts(
      first,
      [{ item: "2 helmets", verdict: "confirmed", confidence: 0.9 }],
      { requested: REQUESTED, at: at + 60_000 }
    );
    expect(second.find((o) => o.item === "2 helmets")!.state).toBe("confirmed");
    expect(second.find((o) => o.item === "2 helmets")!.at).toBe(at + 60_000);
  });

  it("a low-confidence verdict is discarded, not stored as a weak signal", () => {
    // Every surface renders this as a fact and none of them carries the
    // confidence through.
    const out = mergeAccessoryVerdicts(
      undefined,
      [{ item: "2 helmets", verdict: "confirmed", confidence: MIN_CONFIDENCE - 0.01 }],
      { requested: REQUESTED, at }
    );
    expect(out.find((o) => o.item === "2 helmets")!.state).toBe("unknown");
  });

  it("REPRODUCTION: an item the traveller never asked for is dropped", () => {
    // An invented "confirmed GPS" on a booking screen is the failure mode this
    // whole file exists to prevent.
    const out = mergeAccessoryVerdicts(
      undefined,
      [{ item: "GPS", verdict: "confirmed", confidence: 1 }],
      { requested: REQUESTED, at }
    );
    expect(out.some((o) => o.item === "GPS")).toBe(false);
    expect(out.length).toBe(REQUESTED.length);
  });

  it("matching ignores case and stray spacing, and echoes the traveller's wording", () => {
    const out = mergeAccessoryVerdicts(
      undefined,
      [{ item: "  gopro MOUNT ", verdict: "refused", confidence: 0.8 }],
      { requested: REQUESTED, at }
    );
    const m = out.find((o) => o.state === "refused")!;
    expect(m.item).toBe("GoPro mount");
  });
});

describe("what the rest of the app asks it", () => {
  it("unanswered items drive the ask-once probe", () => {
    const out = mergeAccessoryVerdicts(
      undefined,
      [{ item: "2 helmets", verdict: "confirmed", confidence: 0.9 }],
      { requested: REQUESTED, at }
    );
    expect(unansweredAccessories(out)).toEqual(["GoPro mount"]);
  });

  it("the summary says nothing when nothing has been decided", () => {
    const out = mergeAccessoryVerdicts(undefined, [], { requested: REQUESTED, at });
    expect(accessorySummary(out)).toBeNull();
    expect(accessorySummary(undefined)).toBeNull();
  });

  it("...and counts both directions once they have", () => {
    const out = mergeAccessoryVerdicts(
      undefined,
      [
        { item: "2 helmets", verdict: "confirmed", confidence: 0.9 },
        { item: "GoPro mount", verdict: "refused", confidence: 0.9 },
      ],
      { requested: REQUESTED, at }
    );
    expect(accessorySummary(out)).toBe("1 confirmed, 1 not available");
  });
});

describe("it is read off the reply path, and it degrades honestly", () => {
  const pass = readCode("src/lib/thread/accessory-pass.ts");
  const loop = readCode("src/lib/agent-loop.ts");

  it("no requested extras means no model call at all", () => {
    expect(pass).toMatch(/if \(!requested\.length \|\| !args\.inboundText\.trim\(\)/);
    expect(loop).toMatch(/if \(rfq\?\.accessories\?\.length && ctx\.sender && ctx\.vendorId\)/);
  });

  it("it runs AFTER the reply, awaited so Cloud Run cannot freeze it mid-write", () => {
    const i = loop.indexOf("runThreadTurn(turnInput, io, \"inbound\")");
    const j = loop.indexOf('finishBeforeResponse("accessory-verdicts"');
    expect(j).toBeGreaterThan(i);
  });

  it("REPRODUCTION: no provider means no verdict, never a keyword guess", () => {
    // Falling back to a keyword scan is how a feature quietly starts producing
    // confident wrong answers the moment the model chain is down.
    expect(pass).toMatch(/if \(!outcome \|\| !outcome\.value\) \{/);
    expect(pass).toMatch(/return \{ verdicts: null, degraded: Boolean\(outcome\?\.degraded\) \};/);
  });

  it("the merge happens against a FRESH read, not a pre-turn copy", () => {
    expect(pass).toMatch(/mergeAccessoryVerdicts\(row\.fields\?\.accessories, args\.verdicts/);
  });

  it("a failed write never breaks the turn - the next message re-reads anyway", () => {
    expect(pass).toMatch(/return null;\s*\n\s*\}\s*\n\}/);
  });
});

describe("and the booking screen finally tells the truth", () => {
  const sheet = readCode("src/components/BookingSheet.tsx");

  it("a confirmed extra ticks, a refused one is struck through, unknown stays neutral", () => {
    expect(sheet).toMatch(/v\?\.state === "confirmed" \? "✓" : v\?\.state === "refused" \? "✕" : "·"/);
    expect(sheet).toMatch(/line-through opacity-70/);
  });

  it("...and an extra cost the shop named is shown next to it", () => {
    expect(sheet).toMatch(/typeof v\?\.extraCost === "number" && v\.extraCost > 0/);
  });

  it("the verdicts reach the client at all", () => {
    const route = readCode("src/app/api/replies/route.ts");
    expect(route).toMatch(/accessories: st\?\.accessories \?\? null,/);
  });
});
