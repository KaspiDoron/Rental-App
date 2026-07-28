import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  citedDurationDays,
  promiseOf,
  reconcileRfq,
  rfqDrifted,
  isUsablePromise,
} from "./rental-params";
import type { StructuredRFQ } from "../types";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const rfq = (over: Partial<StructuredRFQ> = {}): StructuredRFQ =>
  ({
    vehicleClass: "scooter",
    transmission: "automatic",
    durationDays: 8,
    accessories: [],
    fulfillment: "any",
    ...over,
  }) as StructuredRFQ;

// A traveller asked eight shops for an 8-DAY scooter. Mid-thread the agent
// wrote "what's your best price per day for the 30 days?" - a number no shop
// had ever mentioned, invalidating every quote on the table. Not a
// hallucination: the rental parameters were re-read every turn from whichever
// outbound row most recently carried an `rfq`, and that field is client-posted.

describe("what we promised the shop is the authority", () => {
  it("the opener's terms win over a newer, different anchor", () => {
    const promise = promiseOf(rfq({ durationDays: 8 }), null, null);
    const drifted = rfq({ durationDays: 30 });
    expect(reconcileRfq(drifted, promise)?.durationDays).toBe(8);
  });

  it("...and the vehicle class too, so a car search cannot hijack a scooter thread", () => {
    const promise = promiseOf(rfq({ vehicleClass: "scooter" }), null, null);
    const drifted = rfq({ vehicleClass: "car", durationDays: 30 });
    const out = reconcileRfq(drifted, promise)!;
    expect(out.vehicleClass).toBe("scooter");
    expect(out.durationDays).toBe(8);
  });

  it("everything the traveller since refined is KEPT - only the promise is pinned", () => {
    const promise = promiseOf(rfq({ durationDays: 8 }), null, null);
    const drifted = rfq({ durationDays: 30, notes: "top box please", startDate: "2026-08-01" });
    const out = reconcileRfq(drifted, promise)!;
    expect(out.notes).toBe("top box please");
    expect(out.startDate).toBe("2026-08-01");
  });

  it("a returnDate computed from the wrong duration is dropped, not left contradicting", () => {
    const promise = promiseOf(rfq({ durationDays: 8 }), null, null);
    const out = reconcileRfq(rfq({ durationDays: 30, returnDate: "2026-08-31" }), promise)!;
    expect(out.returnDate).toBeUndefined();
  });

  it("an agreeing anchor is returned untouched", () => {
    const promise = promiseOf(rfq(), null, null);
    const anchor = rfq();
    expect(reconcileRfq(anchor, promise)).toBe(anchor);
    expect(rfqDrifted(anchor, promise)).toBe(false);
  });

  it("with no promise to compare against, the anchor stands", () => {
    const anchor = rfq({ durationDays: 30 });
    expect(reconcileRfq(anchor, null)).toBe(anchor);
    expect(rfqDrifted(anchor, null)).toBe(false);
  });
});

describe("the opener's own sentence is a fallback source of the promise", () => {
  it("reads a day count out of the message we sent", () => {
    expect(citedDurationDays("Hi ka! What would it cost per day for 8 days straight?")).toBe(8);
    expect(citedDurationDays("looking for a 14-day rental")).toBe(14);
  });

  it("a RATE is not a duration, and neither is an engine size", () => {
    // "250/day" and "125cc" both used to be reachable by a looser pattern, and
    // either one would corrupt the promise.
    expect(citedDurationDays("250 baht per day")).toBeNull();
    expect(citedDurationDays("automatic scooter 125cc")).toBeNull();
  });

  it("is used when the opener lost its structured rfq", () => {
    const p = promiseOf(null, "automatic scooter (125cc) for 8 days straight", rfq({ durationDays: 30 }));
    expect(p).toEqual({ durationDays: 8, vehicleClass: "scooter" });
  });

  it("an unusable rfq is not a promise", () => {
    expect(isUsablePromise(null)).toBe(false);
    expect(isUsablePromise(rfq({ durationDays: 0 }))).toBe(false);
  });
});

describe("the resolver and the recovery both honour the promise", () => {
  it("the thread resolver reconciles instead of trusting the newest rfq", () => {
    const t = readCode("src/lib/wa/thread-context.ts");
    expect(t).toMatch(/reconcileRfq\(anchorRfq, promise\)/);
    expect(t).toMatch(/rfq: resolvedRfq/);
    // The old shape: the newest rfq-bearing row WAS the answer.
    expect(t).not.toMatch(/rfq: \(anchor\?\.raw\?\.rfq as StructuredRFQ \| undefined\) \?\? null,/);
  });

  it("a drift is recorded rather than silently overruled", () => {
    expect(readCode("src/lib/wa/thread-context.ts")).toMatch(/kind: "rfq-drift-blocked"/);
  });

  it("the opener is actually fetched, oldest-first", () => {
    expect(readCode("src/lib/wa/thread-context.ts")).toMatch(/order=received_at\.asc&limit=1/);
  });

  it("anchor recovery matches the thread before it prefers recency", () => {
    // The 14-day-newest-search rule let a 30-day CAR search re-anchor - and
    // PERSIST onto - a live 8-day scooter thread.
    const a = readCode("src/lib/wa/anchor-recovery.ts");
    expect(a).toMatch(/want\?\.vehicleClass/);
    expect(a).toMatch(/u\.rfq\.durationDays === want\.durationDays/);
    expect(readCode("src/lib/wa/thread-context.ts")).toMatch(/recoverRfqForSender\(senderEmail, Date\.now\(\), want\)/);
  });
});
