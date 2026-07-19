import { describe, it, expect } from "vitest";
import { resolveShareableLocation, sanitizeStayInput } from "./location";
import { shopAskedPresence, shopAskedLocation } from "./wa/detectors";

// Module-5 privacy pins: the production leak was a raw maps.google.com/?q= pin
// built from client-posted coordinates. These tests are the contract that can
// never regress: no consent -> NO coordinates, NO pin, address text only.

describe("resolveShareableLocation - the one disclosure gate", () => {
  const STAY = { label: "Sun Villas Moalboal", lat: 9.9394, lng: 123.3697 };

  it("NO consent -> address text only, never coords, never a ?q= pin", () => {
    const out = resolveShareableLocation({ ...STAY, shareConsent: false });
    expect(out.addressText).toBe("Sun Villas Moalboal");
    expect(out.coords).toBeUndefined();
    expect(out.mapsLink).toBeUndefined();
  });

  it("consent + valid coords -> text AND the pin", () => {
    const out = resolveShareableLocation({ ...STAY, shareConsent: true });
    expect(out.addressText).toBe("Sun Villas Moalboal");
    expect(out.coords).toEqual({ lat: 9.9394, lng: 123.3697 });
    expect(out.mapsLink).toBe("https://maps.google.com/?q=9.939400,123.369700");
  });

  it("consent but junk/missing/out-of-range coords -> text only (never a bad pin)", () => {
    expect(resolveShareableLocation({ label: "X", shareConsent: true }).mapsLink).toBeUndefined();
    expect(
      resolveShareableLocation({ label: "X", shareConsent: true, lat: 999, lng: 10 }).mapsLink
    ).toBeUndefined();
    expect(
      resolveShareableLocation({ label: "X", shareConsent: true, lat: 0, lng: 0 }).mapsLink
    ).toBeUndefined();
  });

  it("no stay at all -> nothing shareable", () => {
    expect(resolveShareableLocation(null)).toEqual({ addressText: null });
    expect(resolveShareableLocation({ label: "  " })).toEqual({ addressText: null });
  });
});

describe("sanitizeStayInput - the storage hard gate", () => {
  it("STRIPS coordinates whenever shareConsent !== true (tampered client)", () => {
    const out = sanitizeStayInput({ label: "Hotel A", shareConsent: false, lat: 9.9, lng: 123.3 });
    expect(out).toEqual({ label: "Hotel A", shareConsent: false });
  });
  it("keeps valid coords only WITH consent", () => {
    const out = sanitizeStayInput({ label: "Hotel A", shareConsent: true, lat: 9.9, lng: 123.3 });
    expect(out).toEqual({ label: "Hotel A", shareConsent: true, lat: 9.9, lng: 123.3 });
  });
  it("rejects out-of-range coords even with consent", () => {
    const out = sanitizeStayInput({ label: "Hotel A", shareConsent: true, lat: 91, lng: 123.3 });
    expect(out).toEqual({ label: "Hotel A", shareConsent: true });
  });
  it("no label -> nothing to store", () => {
    expect(sanitizeStayInput({ shareConsent: true, lat: 9.9, lng: 123.3 })).toBeNull();
    expect(sanitizeStayInput({})).toBeNull();
  });
  it("consent must be LITERALLY true (no truthy coercion)", () => {
    const out = sanitizeStayInput({ label: "H", shareConsent: "yes", lat: 9.9, lng: 123.3 });
    expect(out).toEqual({ label: "H", shareConsent: false });
  });
});

describe("shopAskedPresence - region questions answered from the string token only", () => {
  it("matches the exact production ask ('Are you there in moalboal, cebu,v')", () => {
    expect(shopAskedPresence("Are you there in moalboal, cebu,v")).toBe(true);
    expect(shopAskedPresence("are you here in Boracay?")).toBe(true);
    expect(shopAskedPresence("you in panglao?")).toBe(true);
    expect(shopAskedPresence("are you around?")).toBe(true);
  });
  it("delivery-address asks stay with shopAskedLocation, not presence", () => {
    const ask = "Where is your hotel?";
    expect(shopAskedLocation(ask)).toBe(true);
    expect(shopAskedPresence(ask)).toBe(false);
  });
  it("ignores small talk and ordinary lines", () => {
    expect(shopAskedPresence("where are you from?")).toBe(false);
    expect(shopAskedPresence("350 a day for the scooter")).toBe(false);
    expect(shopAskedPresence("")).toBe(false);
  });
});
