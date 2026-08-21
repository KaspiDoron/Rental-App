import { describe, it, expect } from "vitest";
import { extractQuotedPrices, parseCcTierList } from "./price-extract";
import { waMessageText, waMediaKind, waProductCard, waProductLine, waQuotedText } from "./message-text";
import { ccMatches } from "../offer-options";

// THE KRABI HUNT, VERBATIM (owner report 6, 2026-08-20).
//
// One real search produced four shops whose prices all vanished: a catalog
// card rendered as an empty bubble, three text shapes no reader knew, and a
// wrong-displacement quote read as on-spec. Every string below is exactly what
// arrived on the wire. These are executed against the real modules - reverting
// any A-wave fix turns at least one red.

const KRABI = { vehicleClass: "scooter" as const, durationDays: 4, localCurrency: "THB", engineSizeCc: 125 };

describe("Buddy Motorbike's cc-keyed boards", () => {
  it("the base board: '110cc 250฿ 125cc 300฿ 155cc 400฿ 160cc 500฿'", () => {
    const q = extractQuotedPrices("110cc 250฿ 125cc 300฿ 155cc 400฿ 160cc 500฿", KRABI);
    expect(q.allOffers).toHaveLength(4);
    expect(q.offer?.pricePerDay, "the 125cc row is the offer").toBe(300);
    expect(q.offer?.currency).toBe("THB");
  });

  it("the 4-day tier: '4/Days 110cc 220฿ 125cc 270฿ 155cc 350฿ 160cc 450฿'", () => {
    const q = extractQuotedPrices("4/Days 110cc 220฿ 125cc 270฿ 155cc 350฿ 160cc 450฿", KRABI);
    expect(q.offer?.pricePerDay).toBe(270);
    expect(q.offer?.minDays, "the tier carries its basis").toBe(4);
    // THE PHANTOM: scanRates matches '4/Days' as a 4-currency daily rate. It
    // must never surface - not as an offer, not in the menu.
    expect(q.allOffers.every((h) => h.pricePerDay >= 200)).toBe(true);
  });

  it("the SELF-DROP the agent never saw: 125cc falls 270 -> 250", () => {
    const q = extractQuotedPrices("4/Days 110cc 200฿ 125cc 250฿ 155cc 350฿ 160cc 450฿", KRABI);
    expect(q.offer?.pricePerDay).toBe(250);
  });

  it("a 3-day traveller is NOT given the 4-day tier", () => {
    const q = extractQuotedPrices("4/Days 110cc 220฿ 125cc 270฿", { ...KRABI, durationDays: 3 });
    expect(q.offer).toBeNull(); // no covering tier - honest, not invented
    expect(q.allOffers.length).toBe(2); // but the menu still shows the board
  });

  it("both boards in one coalesced message: the covering tier wins", () => {
    const both =
      "110cc 250฿ 125cc 300฿ 155cc 400฿ 160cc 500฿\n4/Days 110cc 220฿ 125cc 270฿ 155cc 350฿ 160cc 450฿";
    const q = extractQuotedPrices(both, KRABI);
    expect(q.offer?.pricePerDay, "4-day tier beats the base rate for a 4-day stay").toBe(270);
    const three = extractQuotedPrices(both, { ...KRABI, durationDays: 3 });
    expect(three.offer?.pricePerDay, "3-day stay gets the base 300, never the 4-day 270").toBe(300);
  });
});

describe("Bina Motobike's two invisible quotes", () => {
  it("'Special price 900 bath for 4 day' - the misspelling is not a veto", () => {
    const q = extractQuotedPrices("Special price 900 bath for 4 day", KRABI);
    expect(q.offer?.pricePerDay).toBe(225);
    expect(q.offer?.derivedFromDays, "a divided total says so").toBe(4);
  });

  it("'We can discount you 250per day' - glued tokens still read", () => {
    const q = extractQuotedPrices("We can discount you 250per day", KRABI);
    expect(q.offer?.pricePerDay).toBe(250);
  });
});

describe("KF's smaller bike is never an on-spec offer", () => {
  it("'150 baht per day, but it's a Scoopy 110cc' reads off-spec", () => {
    const q = extractQuotedPrices(
      "We have a motorbike for rent at 150 baht per day, but it's a Scoopy 110cc, which is smaller and only usable in Ao Nang and Krabi town.",
      KRABI
    );
    const hit = q.offer ?? q.allOffers[0];
    expect(hit?.pricePerDay).toBe(150);
    expect(hit?.classMatch, "110cc against a 125cc request is NOT the asked-for vehicle").toBe(false);
  });
});

describe("White Orchid's catalog cards", () => {
  const FAZZIO = {
    key: { id: "CARD1" },
    message: {
      productMessage: {
        product: {
          title: "Yamaha Fazzio Hybrid 125cc",
          description: "Automatic scooter",
          currencyCode: "THB",
          priceAmount1000: 350_000,
          retailerId: "fz-125",
        },
      },
    },
  };

  it("the card decodes structurally and transcribes with its price", () => {
    const card = waProductCard(FAZZIO);
    expect(card).toEqual({
      title: "Yamaha Fazzio Hybrid 125cc",
      description: "Automatic scooter",
      currency: "THB",
      price: 350,
      retailerId: "fz-125",
    });
    expect(waMessageText(FAZZIO)).toBe(
      "[product card] Yamaha Fazzio Hybrid 125cc - THB 350 (Automatic scooter)"
    );
    expect(waMediaKind(FAZZIO), "a product frame is never 'empty-media'").toBe("product");
  });

  it("the transcription flows into the price pipeline as a menu row", () => {
    const q = extractQuotedPrices(waMessageText(FAZZIO), KRABI);
    expect(q.offer?.pricePerDay).toBe(350);
    expect(q.allOffers).toHaveLength(1);
  });

  it("'^ This one is 125 cc' recovers its referent - but never as a rail price", () => {
    const reply = {
      message: {
        extendedTextMessage: {
          text: "This one is 125 cc",
          contextInfo: { quotedMessage: FAZZIO.message },
        },
      },
    };
    expect(waQuotedText(reply)).toContain("Yamaha Fazzio Hybrid 125cc");
    // Ingest appends the marker; the deterministic rails must skip it -
    // quoting a number is not stating it.
    const body = `${waMessageText(reply)}\n(quoting: ${waQuotedText(reply)})`;
    expect(extractQuotedPrices(body, KRABI).offer).toBeNull();
  });

  it("an interactive/list frame is a kind, not silence", () => {
    expect(waMediaKind({ message: { listMessage: { title: "Our fleet" } } })).toBe("interactive");
    expect(waMessageText({ message: { listMessage: { title: "Our fleet" } } })).toBe("Our fleet");
    expect(waMediaKind({ message: { orderMessage: { itemCount: 1 } } })).toBe("order");
  });
});

describe("the local ccClose stays in lockstep with offer-options.ccMatches", () => {
  it("both accept badge rounding and reject a different bike", () => {
    // parseCcTierList picks rows with its local rule; the canonical rule lives
    // in offer-options. If they drift, a row could pass one gate and fail the
    // other - assert agreement on the boundary cases.
    for (const [want, got] of [
      [125, 125],
      [125, 124],
      [125, 130],
      [125, 110],
      [125, 150],
      [150, 155],
    ] as const) {
      const rows = parseCcTierList(`${got}cc 300฿ 999cc 900฿`, "THB");
      const viaList = rows.some((r) => {
        const cc = parseInt(r.line, 10);
        return Math.abs(want - cc) <= Math.max(5, want * 0.06);
      });
      expect(viaList, `${want} vs ${got}`).toBe(ccMatches(want, got));
    }
  });

  it("prose with a single cc pair stays with the general reader", () => {
    expect(parseCcTierList("the Click 125cc is 300 baht today my friend", "THB")).toEqual([]);
  });
});
