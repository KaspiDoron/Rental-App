import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const guard = readFileSync(join(process.cwd(), "src/lib/wa-guard.ts"), "utf8");

// A REPLY GOVERNED AS A COLD INTRODUCTION IS A PRODUCT THAT DOES NOT WORK.
//
// The owner's report: "some shops get fast replies, some get no reply at all
// even after hours - and I can SEE the agents composed good replies in the Ops
// panel". Composition was never the problem. `isNewContact` was.
//
// That one boolean is the entire lane switch. It gates the introductions
// budget (whose hold is clamped to business hours - HOURS), the reply-rate
// breaker, the delivery-rate breaker, the hourly cap, and via `isReply` both
// the burst lane and the min-gap keying. Get it wrong in the "new" direction
// and a reply to a shop that just messaged us is paced like cold outreach to a
// stranger who has never heard of us.
//
// It was wrong in two independent ways, and the second is the one that bit
// hardest - it did not need any particular shop, only an unlucky moment.

describe("a reply is never mistaken for a cold introduction", () => {
  it("REPRODUCTION 1: the recipient read no longer matches the number EXACTLY", () => {
    // `wa_recipient_state` is WRITTEN tail-keyed by upsertRecipient, for the
    // reason this file states itself: the shop's reply carries WhatsApp's
    // spelling of the number while our introduction carried discovery's.
    // Reading it back with `to_number=eq.` therefore missed for exactly the
    // shops the tail-keying exists to catch.
    const call = guard.slice(
      guard.indexOf("const priorRecipient = await sbSelectStrict"),
      guard.indexOf("const contactState")
    );
    expect(call).toMatch(/numberFilter\("to_number", opts\.toDigits\)/);
    expect(call, "an exact match is the bug").not.toMatch(/to_number=eq\./);
  });

  it("REPRODUCTION 2: an UNREADABLE recipient table no longer means 'brand new stranger'", () => {
    // The dominant trigger. `sbSelect` collapses every failure to `[]`, and
    // `[] -> length === 0 -> isNewContact = true`. So a brownout silently
    // reclassified every reply in the fleet as a cold introduction - no
    // particular shop required, just a bad few seconds.
    expect(guard).toMatch(/const priorRecipient = await sbSelectStrict/);
    // Three states, not a boolean derived from `.length === 0`.
    expect(guard).toMatch(/contactState: "new" \| "known" \| "unknown"/);
    expect(guard).toMatch(/const isNewContact = contactState === "new";/);
  });

  it("unknown leans WARM, and that direction is deliberate", () => {
    // WhatsApp's ban signals are about unsolicited outreach to people who never
    // replied - not about answering someone who wrote to you first. So an
    // unknown recipient must fall on the reply side: the cost of being wrong is
    // one reciprocal message sent a little fast, versus a product that silently
    // stops answering shops.
    const block = guard.slice(
      guard.indexOf('const contactState: "new" | "known" | "unknown"'),
      guard.indexOf("const isNewContact = contactState === \"new\";") + 60
    );
    // "unknown" must NOT map to new.
    expect(block).toMatch(/: "unknown"/);
    expect(guard).toMatch(/const isNewContact = contactState === "new";/);
  });

  it("...but a table that has NEVER existed is still honestly 'new'", () => {
    // The two error shapes point opposite ways, as everywhere else in this
    // repo. A fresh install with no `wa_recipient_state` table is vacuously
    // empty - failing warm there would let a brand-new deployment fire cold
    // introductions with no pacing at all.
    expect(guard).toMatch(/error === "missing"[\s\S]{0,400}?"new"/);
  });

  it("REGRESSION: the terminal engagement-halt probe uses tolerant matching too", () => {
    // This branch DELETES a composed reply. The `lastInbound` probe directly
    // above it was already fixed to use numberFilter; the `stateRead` four
    // lines later, feeding the same terminal decision, was not.
    const block = guard.slice(
      guard.indexOf("const stateRead = await sbSelectStrict"),
      guard.indexOf("const stateRead = await sbSelectStrict") + 500
    );
    expect(block).toMatch(/numberFilter\("to_number", opts\.toDigits\)/);
    expect(block).not.toMatch(/to_number=eq\./);
  });

  it("REGRESSION: the active-conversation override matches from_number tolerantly", () => {
    // Without this, a shop demonstrably at the phone right now was told to wait
    // for "opening hours" - and it failed for precisely the shops whose
    // WhatsApp spelling differs from discovery's, i.e. the ones the override
    // exists to serve.
    const block = guard.slice(
      guard.indexOf("const recentInbound = await sbSelect"),
      guard.indexOf("const recentInbound = await sbSelect") + 500
    );
    expect(block).toMatch(/numberFilter\("from_number", opts\.toDigits\)/);
    expect(block).not.toMatch(/from_number=eq\./);
  });
});
