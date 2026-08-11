import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// A BOOKED TRIP MUST OUTLIVE THE SEARCH THAT FOUND IT.
//
// The shop's WhatsApp number, its coordinates, and what the traveller saved all
// lived in the live search session - which expires. So someone standing outside
// the shop on day three, wanting to ask about the return time, could find that
// the app had forgotten how to reach it. The booking row knew the shop's NAME
// and nothing else useful.

describe("the booking row carries the trip, not just the price", () => {
  const route = readCode("src/app/api/bookings/route.ts");

  it("REPRODUCTION: contact, place and savings are snapshotted at close time", () => {
    expect(route).toMatch(/meta: \{/);
    expect(route).toMatch(/whatsapp: typeof b\.whatsapp === "string"/);
    expect(route).toMatch(/lat: Number\.isFinite\(Number\(b\.lat\)\)/);
    expect(route).toMatch(/lng: Number\.isFinite\(Number\(b\.lng\)\)/);
    expect(route).toMatch(/savedPerDay: Number\.isFinite\(Number\(b\.savedPerDay\)\)/);
  });

  it("every field is bounded and type-checked - this is client input", () => {
    // A booking row is written from whatever the client posts; an unbounded
    // string here is a storage bill and a rendering hazard.
    expect(route).toMatch(/\.slice\(0, 32\)/); // whatsapp
    expect(route).toMatch(/\.slice\(0, 200\)/); // address
    expect(route).toMatch(/: null/); // absent stays absent, never ""
  });

  it("and it reads back, including the vendor id the trip needs", () => {
    expect(route).toMatch(/select=id,vendor_id,vendor_name/);
    expect(route).toMatch(/created_at,meta&/);
  });

  it("the insert still degrades through the pre-migration column ladder", () => {
    // A booking must NEVER be lost to a migration that has not been run - the
    // richest insert first, then progressively smaller ones. The ladder is
    // unchanged; what changed is that the LAST rung's result is no longer
    // discarded (see write-truth.test.ts - all three failing used to answer
    // `{ok:true}`), so the pins follow `stored` rather than the old `ok`/`okCur`.
    expect(route).toMatch(/let stored = await sbInsert\("bookings", \[\{ \.\.\.bookingBase, \.\.\.extra \}\]\);/);
    expect(route).toMatch(/stored = await sbInsert\("bookings", \[\{ \.\.\.bookingBase, currency: extra\.currency \}\]\);/);
    expect(route).toMatch(/if \(!stored\) stored = await sbInsert\("bookings", \[bookingBase\]\);/);
  });
});

describe("the schema addition follows the additive pattern", () => {
  const schema = readFileSync(join(process.cwd(), "supabase/schema.sql"), "utf8");

  it("it is an `add column if not exists`, like every other later field", () => {
    expect(schema).toMatch(/alter table public\.bookings add column if not exists meta jsonb;/);
  });

  it("nothing was dropped or retyped", () => {
    expect(schema).not.toMatch(/drop column .*bookings/i);
    expect(schema).not.toMatch(/alter table public\.bookings alter column/i);
  });
});

describe("the sheet sends what the trip will need", () => {
  const sheet = readCode("src/components/BookingSheet.tsx");

  it("contact and location travel with the booking", () => {
    expect(sheet).toMatch(/whatsapp: vendor\.whatsapp,/);
    expect(sheet).toMatch(/lat: vendor\.lat,/);
    expect(sheet).toMatch(/lng: vendor\.lng,/);
    expect(sheet).toMatch(/address: vendor\.address,/);
  });

  it("the saving is computed HERE, while the comparison still exists", () => {
    // Recomputing it later would need the other shops' quotes, which is exactly
    // the data that expires with the session.
    expect(sheet).toMatch(/savedPerDay:/);
    expect(sheet).toMatch(/Math\.max\(0, vendor\.basePricePerDay - vendor\.offer\.pricePerDay\)/);
  });
});
