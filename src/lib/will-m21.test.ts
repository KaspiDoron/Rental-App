import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

import { isActingCommand, willActionsEnabled, guidanceFor } from "./will-actions-gate";
import { composeWhy } from "./will-answers";
import type { WillContext, WillVendorSnapshot } from "./will-commands";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// WILL WAS FLUENT ABOUT WHAT HE HAD AND SILENT ABOUT WHAT HE DID NOT.
//
// The context snapshot carried a name, a stage and a price. So he answered
// confidently about the cheapest number on the board without ever knowing what
// it was FOR - and could not answer the question a traveller actually asks,
// which is "has anyone come down?".

const ctx = (vendors: WillVendorSnapshot[]): WillContext => ({
  phase: "running",
  radiusKm: 5,
  vendors,
  offersIn: vendors.length,
  waConnected: true,
  plan: "free",
  paused: false,
  notes: [],
});

describe("REPRODUCTION: the snapshot carried none of the facts that matter", () => {
  it("a price for the WRONG VEHICLE never leads an answer", async () => {
    const answer = await composeWhy("a@b.c", ctx([
      { id: "1", name: "Cheap Shop", pricePerDay: 150, currency: "THB", vehicleStatus: "wrong-vehicle" },
      { id: "2", name: "Right Shop", pricePerDay: 250, currency: "THB", vehicleStatus: "confirmed" },
    ]));
    expect(answer).toContain("Right Shop");
    expect(answer).toMatch(/NOT counting Cheap Shop/);
  });

  it("...and the traveller is TOLD why the obvious cheapest is not winning", async () => {
    const answer = await composeWhy("a@b.c", ctx([
      { id: "1", name: "Cheap Shop", pricePerDay: 150, currency: "THB", vehicleStatus: "wrong-vehicle" },
      { id: "2", name: "Right Shop", pricePerDay: 250, currency: "THB" },
    ]));
    expect(answer).toMatch(/different vehicle than you asked for/);
  });

  it("a shop with NOTHING IN STOCK cannot lead", async () => {
    const answer = await composeWhy("a@b.c", ctx([
      { id: "1", name: "Empty Shop", pricePerDay: 150, currency: "THB", outOfStock: true },
      { id: "2", name: "Real Shop", pricePerDay: 250, currency: "THB" },
    ]));
    expect(answer).toContain("Real Shop");
    expect(answer).not.toMatch(/Empty Shop leads/);
  });

  it("WHAT THE HAGGLING ACHIEVED is finally said out loud", async () => {
    const answer = await composeWhy("a@b.c", ctx([
      {
        id: "1",
        name: "Sun House",
        pricePerDay: 200,
        openingPricePerDay: 300,
        currency: "THB",
      },
    ]));
    expect(answer).toMatch(/opened at 300 THB\/day/);
    expect(answer).toMatch(/taken 100 THB off/);
  });

  it("no movement means no claim of movement", async () => {
    const answer = await composeWhy("a@b.c", ctx([
      { id: "1", name: "Sun House", pricePerDay: 200, openingPricePerDay: 200, currency: "THB" },
    ]));
    expect(answer).not.toMatch(/opened at/);
  });

  it("the client actually sends the new facts", () => {
    const page = readCode("src/app/page.tsx");
    expect(page).toMatch(/vehicleStatus: v\.offer\?\.vehicleStatus,/);
    expect(page).toMatch(/alternativeOffered: Boolean\(v\.offer\?\.alternativeOffer\),/);
    expect(page).toMatch(/outOfStock: v\.stage === "out-of-stock",/);
    expect(page).toMatch(/openingPricePerDay: v\.offer\?\.listPricePerDay,/);
  });

  it("...and the LLM sees them too, not only the deterministic composer", () => {
    const route = readCode("src/app/api/will/route.ts");
    expect(route).toMatch(/vehicleStatus: v\.vehicleStatus,/);
    expect(route).toMatch(/alternativeOffered: v\.alternativeOffered \|\| undefined,/);
    expect(route).toMatch(/openingPricePerDay: v\.openingPricePerDay,/);
  });

  it("the status line surfaces a decision that is waiting on the traveller", () => {
    const answers = readCode("src/lib/will-answers.ts");
    expect(answers).toMatch(/const waitingOnYou = ctx\.vendors\.filter\(\(v\) => v\.alternativeOffered\);/);
    expect(answers).toMatch(/paused that thread until you say yes or no/);
  });
});

describe("Will's acting half is behind an owner switch", () => {
  it("acting commands are exactly the ones that CHANGE something", () => {
    for (const a of [
      "set_radius",
      "set_filter",
      "set_budget",
      "start_search",
      "clear_search",
      "pause_session",
      "resume_session",
      "mass_bargain",
      "remember",
    ]) {
      expect(isActingCommand(a), a).toBe(true);
    }
  });

  it("ANSWERING IS NEVER GATED - status, why, compare, help, navigation", () => {
    // Turning execution off must not turn Will into a wall. The whole point is
    // that he keeps telling the truth about the hunt.
    for (const a of [
      "answer",
      "clarify",
      "compare",
      "help",
      "open_vendor",
      "open_deals",
      "open_pricing",
      "open_feedback",
    ]) {
      expect(isActingCommand(a), a).toBe(false);
    }
  });

  it("the default is ON - an unset or unreadable key does not disable Will", () => {
    expect(willActionsEnabled(undefined)).toBe(true);
    expect(willActionsEnabled("")).toBe(true);
    expect(willActionsEnabled("banana")).toBe(true);
    expect(willActionsEnabled("on")).toBe(true);
    expect(willActionsEnabled("off")).toBe(false);
    expect(willActionsEnabled("false")).toBe(false);
  });

  it("the guidance NAMES THE CONTROL - it is directions, not an apology", () => {
    expect(guidanceFor({ action: "set_radius", km: 12 })).toMatch(/radius slider/);
    expect(guidanceFor({ action: "set_radius", km: 12 })).toMatch(/12 km/);
    expect(guidanceFor({ action: "mass_bargain" })).toMatch(/Bargain with all/);
    expect(guidanceFor({ action: "pause_session" })).toMatch(/Pause in the live status panel/);
    expect(guidanceFor({ action: "set_budget", maxPricePerDay: 400 })).toMatch(/400 in Filters/);
    expect(guidanceFor({ action: "set_budget", maxPricePerDay: null })).toMatch(/leave the max price empty/);
  });

  it("a blocked command comes back as an ANSWER, so nothing can execute it", () => {
    const route = readCode("src/app/api/will/route.ts");
    expect(route).toMatch(/if \(isActingCommand\(command\.action\)\) \{/);
    expect(route).toMatch(/command: \{ action: "answer", text \},/);
    expect(route).toMatch(/underDevelopment: true,/);
  });

  it("the switch is a Key Vault key, so turning it back on is a paste", () => {
    const config = readCode("src/lib/config.ts");
    expect(config).toMatch(/name: "WILL_ACTIONS"/);
  });

  it("the bubble says it is temporary rather than reading as a refusal", () => {
    const msg = readCode("src/components/will/WillMessage.tsx");
    expect(msg).toMatch(/msg\.underDevelopment &&/);
    expect(msg).toMatch(/Under development/);
    const hook = readCode("src/lib/useWill.ts");
    expect(hook).toMatch(/underDevelopment: Boolean\(d\?\.underDevelopment\),/);
    // No success receipt on something that did not happen.
    expect(hook).toMatch(/receipt: d\?\.underDevelopment\s*\?\s*undefined/);
  });
});
