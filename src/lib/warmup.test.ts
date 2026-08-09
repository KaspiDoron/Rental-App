import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { warmupProgressLine, WARMUP_DEFAULTS, type WarmupStatus, type WarmupTerm } from "./warmup";

vi.mock("server-only", () => ({}));

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const warmup = readCode("src/lib/warmup.ts");
const checkout = readCode("src/app/api/billing/checkout/route.ts");
const sheet = readCode("src/components/UpgradeSheet.tsx");

const term = (o: Partial<WarmupTerm> & Pick<WarmupTerm, "id">): WarmupTerm => ({
  label: o.id,
  have: 0,
  need: 1,
  done: false,
  ...o,
});
const status = (terms: WarmupTerm[]): WarmupStatus => ({
  warmed: terms.every((t) => t.done),
  terms,
  remaining: terms.filter((t) => !t.done).length,
  unreadable: false,
  exempt: false,
});

// THE UNIT IS USAGE DEPTH, NOT CALENDAR DAYS, AND THAT IS THE WHOLE FEATURE.
//
// The first draft of this gate required seven days since linking. For this
// product that is not a strict rule, it is a closed door: our users are
// travellers, a large share search for a bike on the day they land and are done
// inside 72 hours. A seven-day clock hides the paywall behind a window longer
// than the trip, so the modal buyer never sees a purchasable Premium - and the
// symptom is "conversion is low", not "the door is shut".

describe("the predicate is reachable in an afternoon", () => {
  it("no term is denominated in elapsed time", () => {
    // The regression that matters. A `days`/`age`/`elapsed` term creeping back
    // in would reintroduce the closed door silently.
    expect(Object.keys(WARMUP_DEFAULTS)).toEqual([
      "WARMUP_MIN_SEARCHES",
      "WARMUP_MIN_ENGAGED",
      "WARMUP_MIN_REPLIES",
    ]);
    expect(warmup).not.toMatch(/days_since|daysSince|first_linked_at|WARMUP_MIN_DAYS/);
  });

  it("the defaults are small enough to clear in one sitting", () => {
    expect(WARMUP_DEFAULTS.WARMUP_MIN_SEARCHES).toBeLessThanOrEqual(2);
    expect(WARMUP_DEFAULTS.WARMUP_MIN_ENGAGED).toBeLessThanOrEqual(5);
    expect(WARMUP_DEFAULTS.WARMUP_MIN_REPLIES).toBeLessThanOrEqual(2);
  });

  it("every threshold is owner-tunable, so the gate can be loosened on data", () => {
    expect(warmup).toMatch(/getConfig\(name\)/);
    expect(warmup).toMatch(/WARMUP_GATE/);
  });

  it("the kill switch treats an ABSENT config as ON", () => {
    // Same family as the kill switch that turned itself off during a brownout:
    // a missing row must not silently disengage a deliberate product decision.
    expect(warmup).toMatch(/v !== "off" && v !== "0" && v !== "false"/);
  });
});

describe("engagement is counted from the recipient ledger, not from sends", () => {
  it("reads wa_recipient_state and requires a real introduction", () => {
    expect(warmup).toMatch(/"wa_recipient_state"/);
    expect(warmup).toMatch(/first_intro_at=not\.is\.null/);
  });

  it("a send count would reward spraying, so it is not used", () => {
    expect(warmup).not.toMatch(/whatsapp_messages/);
  });

  it("response_times is not consulted - its clock is anchored wrong", () => {
    // It measures from the global first-ever outbound, so a shop contacted three
    // weeks ago that answers in two minutes records a three-week sample and
    // never corrects.
    expect(warmup).not.toMatch(/response_times/);
  });

  it("shops are de-duplicated on the phone tail, including legacy rows", () => {
    // Rows written before `to_tail` existed carry only the raw number. Counting
    // both spellings would let one shop satisfy two slots and open the gate
    // early.
    expect(warmup).toMatch(/nationalTail\(r\.to_number\)/);
  });
});

describe("the fail direction is INVERTED here, on purpose", () => {
  // Everywhere else an unreadable Supabase read denies, because the thing being
  // guarded is someone's phone number. Here it is our own revenue quality, and
  // the costs run the other way: refusing a sale to someone who HAS earned it -
  // possibly on the only afternoon they will ever use the app - is worse than
  // admitting one buyer we were not sure about.
  it("an unreadable predicate admits rather than blocks", () => {
    expect(warmup).toMatch(/if \(unreadable\) \{[\s\S]{0,200}warmed: true/);
  });

  it("but a guess is never written into the permanent record", () => {
    const block = warmup.slice(warmup.indexOf("if (unreadable) {"));
    const untilReturn = block.slice(0, block.indexOf("}") + 1);
    expect(untilReturn).not.toMatch(/stamp\(/);
  });

  it("a MISSING table is zero, not unknown - a fresh install really has none", () => {
    expect(warmup).toMatch(/read\.error === "unavailable"/);
  });
});

describe("the unlock is write-once", () => {
  it("the stamp is filtered on the column still being null", () => {
    // Enforced by the database rather than by the caller remembering. Moving a
    // threshold later must not un-warm somebody, and re-stamping would destroy
    // time-to-warm - the one measure that says whether the thresholds are right.
    expect(warmup).toMatch(/warmed_up_at=is\.null/);
  });

  it("an existing stamp short-circuits the whole predicate", () => {
    expect(warmup).toMatch(/const already = await readStamp\(email\)/);
    expect(warmup).toMatch(/if \(already\) return allWarm\(\{ warmedAt: already \}\)/);
  });

  it("the predicate as it stood is snapshotted alongside the stamp", () => {
    expect(warmup).toMatch(/warmup_snapshot/);
  });
});

describe("who is exempt", () => {
  it("test-mode users and the owner allowlist are never gated", () => {
    // Otherwise beta testers cannot test the paid tiers - the one thing they
    // exist to do.
    expect(warmup).toMatch(/isTestUser/);
  });

  it("the checkout runs the gate AFTER the test-mode sandbox branch", () => {
    const sandbox = checkout.indexOf("isTestUser");
    const gate = checkout.indexOf("warmupStatus");
    expect(sandbox).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(sandbox);
  });
});

describe("the gate is enforced where the money is", () => {
  it("checkout refuses a POST from a cold account", () => {
    // UpgradeSheet renders a locked state and the pricing page links here, but
    // both are client-side. A POST is one fetch away, so the only real gate is
    // the one in front of PayPal.
    expect(checkout).toMatch(/if \(!warm\.warmed\)/);
    expect(checkout).toMatch(/status: 403/);
  });

  it("the refusal is checked BEFORE any PayPal call is made", () => {
    // Match the CALL SITE, not the identifier: the first occurrence of
    // `createPaypalCheckout` is the import at the top of the file, which is
    // always before everything and would make this assertion unfalsifiable.
    const call = checkout.indexOf("createPaypalCheckout(String(planId)");
    expect(call).toBeGreaterThan(-1);
    expect(checkout.indexOf("if (!warm.warmed)")).toBeLessThan(call);
  });

  it("the catalogue response carries the state so the sheet paints it once", () => {
    // Without this the sheet flashes a buy button and then withdraws it, which
    // reads as the price being snatched away.
    expect(checkout).toMatch(/warmup: \{/);
  });
});

describe("the copy is a gate, not a wall", () => {
  it("the exact sentence the owner specified is the primary message", () => {
    expect(sheet).toMatch(
      /We want you to get the most out of Premium, so unlock it by using the app a little more first\./
    );
  });

  it("the distance is always visible", () => {
    // A lock with no progress reads as a bug, and a user who cannot see the
    // finish line has no reason to walk to it.
    expect(sheet).toMatch(/warm\.progress/);
    expect(sheet).toMatch(/x\.need/);
  });

  it("constraint 5: no risk, ban or restriction language on this surface", () => {
    const lock = sheet.slice(sheet.indexOf("function WarmupLock"), sheet.indexOf("export function UpgradeSheet"));
    expect(lock).not.toMatch(/\bban\b|\brisk\b|restrict|flagged|blocked/i);
  });

  it("it never says we are evaluating the user", () => {
    expect(sheet).not.toMatch(/evaluat|assess|qualify you|not eligible/i);
  });

  it("the price stays visible while locked - the tier has to look worth wanting", () => {
    const card = sheet.slice(sheet.indexOf("export function PlanCard"), sheet.indexOf("export function UpgradeSheet"));
    expect(card).toMatch(/locked && plan\.amount > 0/);
    // ...and the price block is not conditional on `locked`.
    expect(card).toMatch(/text-xl font-extrabold text-strong">\{now\}/);
  });

  it("no buy button is rendered while the gate is closed", () => {
    // A button that cannot work is worse than no button: the server refuses the
    // checkout anyway, so the user would meet the wall after committing.
    expect(sheet).toMatch(/warm\?\.warmed !== false &&/);
  });
});

describe("the progress line survives translation and RTL", () => {
  it("returns a template plus a count, never a built sentence", () => {
    const p = warmupProgressLine(status([term({ id: "engaged", have: 1, need: 3 })]));
    expect(p).toEqual({ template: "{n} more shops away.", n: 2 });
  });

  it("singular and plural are separate catalogue entries", () => {
    const one = warmupProgressLine(status([term({ id: "engaged", have: 2, need: 3 })]));
    expect(one).toEqual({ template: "One more shop away.", n: 1 });
  });

  it("linking is named first - it is a prerequisite, not a quantity", () => {
    // Otherwise the user is told to reach shops by an app that cannot message
    // anyone yet.
    const p = warmupProgressLine(
      status([term({ id: "engaged", have: 0, need: 3 }), term({ id: "linked" })])
    );
    expect(p?.template).toBe("Connect WhatsApp to get started.");
  });

  it("a warmed account has no progress line", () => {
    expect(warmupProgressLine(status([term({ id: "searches", done: true })]))).toBeNull();
  });

  it("every template is declared for translation", () => {
    // t() refuses anything outside the catalogue, and these reach it through a
    // variable - so without the extras declaration they ship untranslated.
    const extras = readFileSync(join(process.cwd(), "src/lib/i18n-extras.ts"), "utf8");
    for (const s of [
      "Connect WhatsApp to get started.",
      "One search away.",
      "{n} searches away.",
      "One more shop away.",
      "{n} more shops away.",
      "One shop reply away.",
      "{n} shop replies away.",
      "WhatsApp connected",
      "Searches run",
      "Shops reached",
      "Shops that replied",
    ]) {
      expect(extras, `${s} is not declared`).toContain(`"${s}"`);
    }
  });
});
