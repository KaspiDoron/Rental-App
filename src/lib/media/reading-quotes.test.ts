import { describe, it, expect } from "vitest";
import {
  BURST_WINDOW_MS,
  burstFollowerRows,
  cheapestQuotable,
  classifyReading,
  missingReadingHeadline,
  missingReadingLine,
  pickBoardPrice,
  quotablePrices,
  READING_GRACE_MS,
  readingEmptyLine,
  readingFrom,
  readingHeadline,
  readingIsFailure,
  readingIsPending,
  recoveredModelFailure,
} from "./reading";

// THE APP WAS QUOTING PRICES THAT DO NOT EXIST.
//
// A shop's board lists a Fino at 200 with a red line drawn through it - they
// stopped renting that model. The reader saw the strike, marked the row
// `available: false`, and the proof panel dutifully drew it struck through.
//
// Then `readingFrom` sorted the rows cheapest-first with no availability
// partition, and BOTH of the places that turn a reading into a NUMBER took
// `prices[0]`:
//
//   - graph/engine's `sessionTable` folds a photographed board into the
//     cross-thread rival table, so every OTHER shop in the hunt was told
//     "another shop does 200" about a bike nobody can rent, and negotiated
//     against it.
//   - /api/replies picks the minimum of the same list and labels it "Read from
//     their price-menu photo" on the traveller's own card.
//
// Availability selection out of an already-parsed structure is arithmetic, so
// it lives in code. Everything here EXECUTES it - the audit that found this
// also found source-text pins that stayed green on reverted code.

describe("a crossed-out row is LISTED, and is never the quote", () => {
  const board = {
    options: [
      { pricePerDay: 200, model: "Yamaha Fino", available: false },
      { pricePerDay: 250, model: "Honda Click 125", available: true },
      { pricePerDay: 400, model: "Honda ADV 160" },
    ],
  };

  it("THE REGRESSION: prices[0] used to be the struck-out row", () => {
    const r = readingFrom(board);
    // Still on the board - the owner asked to SEE the rows the shop crossed
    // out - and still marked.
    expect(r.prices.map((p) => p.pricePerDay).sort((a, b) => a - b)).toEqual([200, 250, 400]);
    expect(r.prices.find((p) => p.pricePerDay === 200)?.available).toBe(false);
    // ...but it can no longer be picked up by a consumer that takes the head.
    expect(r.prices[0].pricePerDay).toBe(250);
    expect(r.prices[r.prices.length - 1].pricePerDay).toBe(200);
  });

  it("the selectors both consumers use refuse a struck row outright", () => {
    const r = readingFrom(board);
    expect(quotablePrices(r.prices).map((p) => p.pricePerDay)).toEqual([250, 400]);
    expect(cheapestQuotable(r.prices)?.pricePerDay).toBe(250);
    // ...including on a reading STORED BEFORE the partitioned sort existed,
    // which is why the consumers filter rather than trusting the order.
    const legacyOrder = [...r.prices].sort((a, b) => a.pricePerDay - b.pricePerDay);
    expect(legacyOrder[0].pricePerDay).toBe(200);
    expect(cheapestQuotable(legacyOrder)?.pricePerDay).toBe(250);
  });

  it("a board where EVERY row is struck out yields no quote at all", () => {
    // The engine's row-matching asks this question: a message whose only rows
    // are crossed out must not claim the shop and shadow an older message that
    // really did carry a board.
    const allGone = readingFrom({
      options: [
        { pricePerDay: 200, available: false },
        { pricePerDay: 250, available: false },
      ],
    });
    expect(allGone.prices).toHaveLength(2);
    expect(cheapestQuotable(allGone.prices)).toBeNull();
    expect(quotablePrices(allGone.prices)).toEqual([]);
  });

  it("THE CARD'S OWN PICK refuses it too, and still prefers the declared cc", () => {
    // /api/replies calls exactly this when the reply row carries no price of
    // its own, and tags the result "Read from their price-menu photo". It used
    // to reduce over EVERY row, so the card advertised the cheapest struck-out
    // model on the board.
    const rows = [
      { pricePerDay: 150, vehicle: "Yamaha Fino 115", available: false },
      { pricePerDay: 250, vehicle: "Honda Click 125" },
      { pricePerDay: 200, vehicle: "Honda Beat 110" },
    ];
    expect(pickBoardPrice(rows)?.pricePerDay).toBe(200); // cheapest LIVE row
    expect(pickBoardPrice(rows, 125)?.pricePerDay).toBe(250); // ...on the declared cc
    // A struck row is never rescued by matching the declared cc either.
    const struckOnSpec = [
      { pricePerDay: 150, vehicle: "Honda Click 125", available: false },
      { pricePerDay: 300, vehicle: "Honda PCX 160" },
    ];
    expect(pickBoardPrice(struckOnSpec, 125)?.pricePerDay).toBe(300);
    // Nothing quotable means NO price on the card, not a struck one.
    expect(pickBoardPrice([{ pricePerDay: 150, available: false }], 125)).toBeNull();
    expect(pickBoardPrice(undefined)).toBeNull();
  });

  it("silence about availability is not a strike - most boards cross nothing out", () => {
    const plain = readingFrom({ options: [{ pricePerDay: 300 }, { pricePerDay: 250 }] });
    expect(cheapestQuotable(plain.prices)?.pricePerDay).toBe(250);
    expect(quotablePrices(plain.prices)).toHaveLength(2);
    // Junk from the boundary never becomes a quote either.
    expect(cheapestQuotable([])).toBeNull();
    expect(cheapestQuotable(null)).toBeNull();
    expect(cheapestQuotable([{ pricePerDay: 0 }, { pricePerDay: undefined }])).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("the panel promises only what somebody actually did", () => {
  // Every "we are retrying" sentence described work that had ALREADY happened
  // inside the turn (agents.ts runs one budgeted region re-read and no more).
  // Nothing schedules another look at the photo - no wakeup, no queue, no
  // second pass - so the panel had re-introduced exactly the unobserved promise
  // the follow-up record was built to kill.
  const noPromise = /\b(is being retried|reading it again|reads it again|re-reading|is asking the shop)\b/i;

  it("THE REGRESSION: no branch claims a retry that nothing scheduled", () => {
    const cases = [
      readingFrom({ found: false, imageRead: { seen: true, modelFailure: "parse-failed" } }),
      readingFrom({ found: false, imageRead: { seen: true, modelFailure: "truncated" } }),
      readingFrom({
        imageRead: { seen: true, modelFailure: "sanity-nulled", rejectedPricePerDay: 25_000 },
      }),
      readingFrom({ imageRead: { seen: false, failure: "rate-limit" } }),
    ];
    for (const r of cases) {
      expect(readingEmptyLine(r), r.outcome).not.toMatch(noPromise);
      expect(readingHeadline(r), r.outcome).not.toMatch(noPromise);
    }
  });

  it("...and still names whose fault each one was", () => {
    expect(
      readingEmptyLine(readingFrom({ imageRead: { seen: true, modelFailure: "parse-failed" } }))
    ).toMatch(/our side failing, not your photo/i);
    expect(
      readingEmptyLine(readingFrom({ imageRead: { seen: true, modelFailure: "truncated" } }))
    ).toMatch(/our limit, not your photo/i);
    expect(
      readingEmptyLine(readingFrom({ imageRead: { seen: false, failure: "auth" } }))
    ).toMatch(/rejected our key/i);
    // None of them may borrow the sentence reserved for a blank picture.
    for (const f of ["parse-failed", "truncated", "sanity-nulled"]) {
      expect(
        readingEmptyLine(readingFrom({ imageRead: { seen: true, modelFailure: f } })),
        f
      ).not.toMatch(/could not read anything usable/i);
    }
  });

  it("the ONE forward-looking clause is the follow-up the turn recorded", () => {
    const withMove = readingFrom(
      { imageRead: { seen: true, modelFailure: "parse-failed" } },
      { followUp: { move: "clarify", delivered: "queued", at: "now" } }
    );
    expect(readingEmptyLine(withMove)).toMatch(
      /Your agent is asking the shop to type the price out\.$/
    );
    // Sent = past tense, because it happened.
    const sent = readingFrom(
      { imageRead: { seen: false, failure: "timeout" } },
      { followUp: { move: "clarify", delivered: "sent", at: "now" } }
    );
    expect(readingEmptyLine(sent)).toMatch(/Your agent asked the shop to type the price out\.$/);
    // A move that never left claims nothing at all.
    for (const delivered of ["held", "blocked", "failed"] as const) {
      const stopped = readingFrom(
        { imageRead: { seen: true, modelFailure: "truncated" } },
        { followUp: { move: "clarify", delivered, at: "now" } }
      );
      expect(readingEmptyLine(stopped), delivered).not.toMatch(/Your agent/);
    }
  });

  it("a rejected price still shows the number, and says we did not quote it", () => {
    const r = readingFrom({
      imageRead: {
        seen: true,
        modelFailure: "sanity-nulled",
        rejectedPricePerDay: 25_000,
        rejectedCurrency: "THB",
      },
    });
    expect(readingEmptyLine(r)).toMatch(/we read 25000 THB\/day/i);
    expect(readingEmptyLine(r)).toMatch(/we did not quote it/i);
    expect(readingEmptyLine(r)).not.toMatch(/undefined|NaN/);
  });
});

// ---------------------------------------------------------------------------

describe("a photo whose price the caption rescued is not a failed read", () => {
  // The live shape: the vision JSON was unparseable, so agents.ts falls through
  // to `deterministicPriceHit()` over the caption text and returns THAT hit
  // with the failure marker still attached. The panel then headlined "Your
  // agent is re-reading this one" and suppressed the confidence chip, directly
  // above the rows and a "-> used 250/day for your offer".
  const rescued = {
    found: true,
    pricePerDay: 250,
    currency: "THB",
    confidence: "medium",
    imageRead: { seen: true, modelFailure: "parse-failed" },
  };

  it("THE REGRESSION: prices on the card and 'we could not read it' above them", () => {
    const r = readingFrom(rescued, { usedPricePerDay: 250 });
    expect(r.prices.map((p) => p.pricePerDay)).toEqual([250]);
    // The self-contradiction is gone: no failure outcome, so no failure line
    // and no suppressed confidence.
    expect(r.outcome).toBe("read");
    expect(readingIsFailure(r)).toBe(false);
    expect(readingHeadline(r)).toMatch(/1 price/);
    // ...but the photo is NOT claimed as the source, because it was not read.
    expect(r.recoveredFrom).toBe("parse-failed");
  });

  it("a cut-off generation rescued the same way reads the same way", () => {
    const r = readingFrom({
      found: true,
      pricePerDay: 300,
      imageRead: { seen: false, failure: "truncated" },
    });
    expect(r.outcome).toBe("read");
    expect(r.recoveredFrom).toBe("truncated");
  });

  it("a failure with NOTHING recovered is still a failure", () => {
    const r = readingFrom({ found: false, imageRead: { seen: true, modelFailure: "parse-failed" } });
    expect(r.outcome).toBe("parse-failed");
    expect(r.recoveredFrom).toBeUndefined();
    expect(readingIsFailure(r)).toBe(true);
    expect(recoveredModelFailure({ imageRead: { seen: true, modelFailure: "parse-failed" } })).toBeUndefined();
  });

  it("sanity-nulled is a REFUSAL and is never 'recovered' by its own rows", () => {
    // Here the price we hold is exactly the one we will not quote, so the
    // refusal is still the whole story - the carve-out that keeps #4 honest.
    const r = readingFrom({
      found: false,
      options: [{ pricePerDay: 250, model: "Honda Click 125" }],
      imageRead: { seen: true, modelFailure: "sanity-nulled", rejectedPricePerDay: 25_000 },
    });
    expect(r.outcome).toBe("sanity-nulled");
    expect(r.recoveredFrom).toBeUndefined();
    expect(readingIsFailure(r)).toBe(true);
    expect(r.prices.map((p) => p.pricePerDay)).toEqual([250]);
  });

  it("the classifier answers it directly, with no model in the loop", () => {
    expect(classifyReading({ imageRead: { seen: true, modelFailure: "parse-failed" } }, true)).toBe(
      "parse-failed"
    );
    expect(
      classifyReading(
        { pricePerDay: 250, imageRead: { seen: true, modelFailure: "parse-failed" } },
        false
      )
    ).toBe("read");
    expect(
      classifyReading(
        { options: [{ pricePerDay: 250 }], imageRead: { seen: true, modelFailure: "truncated" } },
        false
      )
    ).toBe("read");
  });
});

// ---------------------------------------------------------------------------

describe("a frame is only stamped with a reading that included it", () => {
  const at = (s: number) => new Date(1_700_000_000_000 + s * 1_000).toISOString();
  const media = { media: { key: "k" } };

  it("THE REGRESSION: a CHAINED stand-down stamped a frame nobody read", () => {
    // Frames at t=0, 5 and 11 chain: 0 stands down to 5 (within the 6s
    // coalescing window), 5 stands down to 11. The leader at t=11 froze its
    // window at t=5, so its reader was handed the t=5 and t=11 frames ONLY -
    // and the 30s stamp window then wrote that reading onto the t=0 frame too,
    // labelled "Read together with the other photos in this batch", under
    // prices read off a different picture.
    const leader = { id: 12, wa_message_id: "m-12", received_at: at(11), raw: media };
    const rows = [
      { id: 10, wa_message_id: "m-10", received_at: at(0), raw: media },
      { id: 11, wa_message_id: "m-11", received_at: at(5), raw: media },
      leader,
    ];
    expect(burstFollowerRows(rows, leader).map((r) => r.id)).toEqual([11]);
  });

  it("the stamp window IS the coalescing window - one number, not two", () => {
    expect(BURST_WINDOW_MS).toBe(6_000);
    const leader = { id: 2, wa_message_id: "m-2", received_at: at(10), raw: media };
    const onEdge = { id: 1, wa_message_id: "m-1", received_at: at(4), raw: media };
    const justOutside = { id: 0, wa_message_id: "m-0", received_at: at(3.9), raw: media };
    expect(burstFollowerRows([onEdge, justOutside, leader], leader).map((r) => r.id)).toEqual([1]);
  });

  it("a frame that landed AFTER the leader is a leader of its own", () => {
    // The leader only proceeds because it saw nothing newer; anything that
    // arrives later gets its own turn and its own reading. Stamping it here
    // would overwrite a real read with a borrowed one.
    const leader = { id: 5, wa_message_id: "m-5", received_at: at(10), raw: media };
    const later = { id: 6, wa_message_id: "m-6", received_at: at(12), raw: media };
    expect(burstFollowerRows([leader, later], leader)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("an image row with no reading still explains itself", () => {
  const now = 1_700_000_000_000;
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("inside the grace it is honestly 'still reading'", () => {
    expect(readingIsPending(ago(5_000), now)).toBe(true);
    expect(missingReadingHeadline(true)).toMatch(/reading this photo/i);
    expect(missingReadingLine(true)).toMatch(/appears here as soon as it lands/i);
  });

  it("past the grace the absence IS the finding, and it is named as ours", () => {
    expect(readingIsPending(ago(READING_GRACE_MS + 1), now)).toBe(false);
    expect(missingReadingHeadline(false)).toMatch(/no reading was recorded/i);
    expect(missingReadingLine(false)).toMatch(/never stored/i);
    expect(missingReadingLine(false)).toMatch(/our side failing, not your photo/i);
    // The one thing it must never do is blame the picture.
    expect(missingReadingLine(false)).not.toMatch(/could not read anything usable/i);
  });

  it("an unusable timestamp never becomes an accusation", () => {
    expect(readingIsPending(undefined, now)).toBe(true);
    expect(readingIsPending("not a date", now)).toBe(true);
  });
});
