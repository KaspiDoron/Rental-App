import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

// "CONFIRMED" WITH NOTHING WRITTEN DOWN.
//
// /api/bookings walks three insert tiers, richest first, so a booking survives a
// pending migration. The THIRD tier's result was discarded and the route
// returned `{ok:true}` unconditionally. With Supabase configured and
// unreachable, all three failed: the money record vanished, the traveller was
// told the booking was confirmed, and the closing message went to the shop about
// a rental that did not exist. Nothing was logged - and the commitment lock at
// the top of the same route reads the same table, so the double-booking guard
// opened at the same instant.
//
// access.ts:341 already documents this exact class for setPlan ("the traveller
// paid ... and the account stayed on free with nothing anywhere recording that
// it had not worked"). The booking path never got the same treatment; nor did
// /api/feedback, which promises the reporter a thread under "Your reports" that
// only exists if the row landed.
//
// Demo mode - no Supabase at all - is a supported configuration and must still
// answer ok. That is why the refusal is gated on supabaseConfigured(): "no
// database" and "a database that refused the write" are different facts.

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const bookingRequest = (extra: Record<string, unknown> = {}) =>
  new Request("http://localhost/api/bookings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      vendorId: "v1",
      vendorName: "Sun House Rentals",
      pricePerDay: 250,
      durationDays: 4,
      currency: "THB",
      ...extra,
    }),
  });

/** Load the bookings route with every write failing (or not). */
async function loadBookings(opts: { insertOk: boolean; configured: boolean }) {
  vi.resetModules();
  const inserted: Array<{ table: string; rows: Record<string, unknown>[] }> = [];

  vi.doMock("@/lib/session", () => ({
    getSession: async () => ({ email: "t@example.com", plan: "ultra" }),
  }));
  vi.doMock("@/lib/runtime-config", () => ({
    sbSelect: async () => [],
    sbDelete: async () => true,
    supabaseConfigured: () => opts.configured,
    sbInsert: async (table: string, rows: Record<string, unknown>[]) => {
      inserted.push({ table, rows });
      // agent_events is the failure TRACE - it must still be attempted, and its
      // own success is not what the route reports on.
      return table === "agent_events" ? true : opts.insertOk;
    },
  }));

  const mod = await import("../app/api/bookings/route");
  return { POST: mod.POST, inserted };
}

describe("a booking that was not stored is not 'confirmed'", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("REPRODUCTION: all three insert tiers fail -> 503, not ok:true", async () => {
    const { POST, inserted } = await loadBookings({ insertOk: false, configured: true });
    const res = await POST(bookingRequest());

    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBeUndefined();
    expect(body.stored).toBe(false);
    // No money moves in this route - saying otherwise would send someone
    // hunting a refund that does not exist.
    expect(String(body.error)).toMatch(/[Nn]othing was charged/);
    // ...and all three tiers really were attempted before giving up.
    expect(inserted.filter((i) => i.table === "bookings")).toHaveLength(3);
  });

  it("the failure leaves a trace, because nobody is watching this", async () => {
    const { POST, inserted } = await loadBookings({ insertOk: false, configured: true });
    await POST(bookingRequest());
    const trace = inserted.find((i) => i.table === "agent_events");
    expect(trace, "a lost booking with no record is unfindable").toBeTruthy();
    expect(trace!.rows[0].kind).toBe("booking-write-failed");
    expect(trace!.rows[0].user_email).toBe("t@example.com");
  });

  it("demo mode (no Supabase) still answers ok - that IS the supported shape", async () => {
    // Every integration in this app has a no-key fallback and the app must
    // build and run with zero external services. A refusal here would break
    // that contract for the sake of a database that was never asked for.
    const { POST } = await loadBookings({ insertOk: false, configured: false });
    const res = await POST(bookingRequest());
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("a write that DID land still answers ok, on the first tier", async () => {
    const { POST, inserted } = await loadBookings({ insertOk: true, configured: true });
    const res = await POST(bookingRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    // 250 * 4, recomputed server-side.
    expect(body.totalPrice).toBe(1000);
    expect(inserted.filter((i) => i.table === "bookings")).toHaveLength(1);
  });

  it("the client already refuses ANY non-ok, so the 503 surfaces", () => {
    // BookingSheet handles 409 specially and then bails on `!bRes.ok` for
    // everything else. Worth pinning: a 503 that the client swallowed would put
    // the traveller on the confirmed screen anyway.
    const sheet = readCode("src/components/BookingSheet.tsx");
    expect(sheet).toMatch(/if \(!bRes\.ok\) \{/);
    expect(sheet).toMatch(/setStep\("confirmed"\);/);
    expect(sheet.indexOf("if (!bRes.ok) {")).toBeLessThan(sheet.indexOf('setStep("confirmed")'));
  });
});

describe("the savings baseline is not the client's to decide", () => {
  it("REGRESSION: firstQuote is coerced and bounded before it reaches numeric", () => {
    const route = readCode("src/app/api/extract-offer/route.ts");
    // It went in verbatim: `list_price_per_day: body.firstQuote ?? result.pricePerDay`.
    expect(route).not.toMatch(/list_price_per_day: body\.firstQuote/);
    expect(route).toMatch(/const askedRaw = Number\(body\.firstQuote\);/);
    expect(route).toMatch(/Number\.isFinite\(askedRaw\)/);
    // A "before" cannot be cheaper than the "after"...
    expect(route).toMatch(/askedRaw >= result\.pricePerDay/);
    // ...and beyond 10x it is not a list price, it is a 90%+ discount headline.
    expect(route).toMatch(/askedRaw <= result\.pricePerDay \* 10/);
    expect(route).toMatch(/list_price_per_day: listPerDay/);
  });

  it("the column it feeds really is the global, cross-user KPI", () => {
    // Which is why one caller mattered: this is not a per-user cosmetic.
    const kpis = readCode("src/lib/kpis.ts");
    expect(kpis).toMatch(/select=price_per_day,list_price_per_day/);
  });

  it("and the fallback insert can no longer re-send the same bad value", () => {
    // The old shape 400'd the row, then retried with the SAME field, so the
    // offer was dropped entirely while the route answered 200.
    const route = readCode("src/app/api/extract-offer/route.ts");
    const rowIdx = route.indexOf("const row = {");
    expect(route.indexOf("const askedRaw")).toBeLessThan(rowIdx);
    expect(route).toMatch(/if \(!ok\) await sbInsert\("offers", \[row\]\);/);
  });
});

describe("a lost report does not read as a received one", () => {
  it("the response says whether the thread the copy promises exists", () => {
    const route = readCode("src/app/api/feedback/route.ts");
    expect(route).toMatch(
      /const storedRow = feedbackId !== null \|\| !supabaseConfigured\(\);/
    );
    // Both replies - the triaged-out one and the escalated one - carry it.
    expect(route.match(/stored: storedRow/g)?.length).toBe(2);
  });

  it("...and the copy changes with it, rather than promising Your reports anyway", () => {
    const route = readFileSync(join(process.cwd(), "src/app/api/feedback/route.ts"), "utf8");
    expect(route).toMatch(/will not appear under Your reports/);
    // The escalation email is a separate path and still goes out - this is not
    // a hard failure, it is a different promise.
    expect(route).toMatch(/emailed: emailResult\.sent/);
  });
});
