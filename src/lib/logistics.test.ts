import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { resolveShareableLocation, placeMapsLink } from "./location";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// THREE WAYS a vehicle and its renter meet. The chooser offered two and folded
// the third into the first, so a shop that had OFFERED to collect the traveller
// - the standard answer in beach towns - had nowhere to be recorded, and the
// booking said "walk in" for a ride that had been arranged.
describe("the handover has three modes", () => {
  const sheet = readCode("src/components/BookingSheet.tsx");

  it("all three are offered, and they map onto the engine's vocabulary", () => {
    expect(sheet).toMatch(/type Handover = "in-store" \| "shuttle" \| "hotel-delivery"/);
    expect(sheet).toMatch(/"hotel-delivery": "delivery"/);
    expect(sheet).toMatch(/shuttle: "pickup"/);
    expect(sheet).toMatch(/"in-store": "on-shop"/);
    expect(sheet).toMatch(/🚐/);
  });

  it("pre-selects what the SHOP offered, not a default", () => {
    expect(sheet).toMatch(/const offered = vendor\.offer\?\.fulfillment/);
    expect(sheet).toMatch(/if \(offered === "pickup"\) return "shuttle"/);
  });

  it("the traveller's choice is what the shop is told", () => {
    // This used to fall back to the shop's own offer for any non-delivery
    // choice, so picking "I'll walk in" still told the shop a shuttle was on.
    expect(sheet).toMatch(/fulfillment: HANDOVER_TO_FULFILLMENT\[fulfillment\]/);
    expect(sheet).not.toMatch(/: vendor\.offer\?\.fulfillment \?\? "on-shop"/);
  });

  it("BOTH off-shop modes require a place before the deal can lock", () => {
    expect(sheet).toMatch(/const deliveryReady = fulfillment === "in-store"/);
    expect(sheet).toMatch(/Add a pick-up point/);
  });
});

describe("the card shows a handover the engine learned mid-conversation", () => {
  it("a thread-state delivery renders a chip even without includesDelivery", () => {
    // A shop that agreed to deliver during the fulfillment-probe set only the
    // thread state; those cards showed NO handover chip at all - the one fact
    // a traveller most needs before booking.
    const card = readCode("src/components/VendorCard.tsx");
    expect(card).toMatch(/offer\.fulfillment === "delivery" && !offer\.includesDelivery/);
  });
});

describe("a refused location never strands the flow", () => {
  it("the field says WHY, and tells the traveller what to do instead", () => {
    const auto = readCode("src/components/PlaceAutocomplete.tsx");
    // The old handler was a bare setLocating(false): silent, and it looked
    // exactly like a broken control.
    expect(auto).toMatch(/err\?\.code === 1/);
    expect(auto).toMatch(/type your hotel or area below instead/);
    expect(auto).toMatch(/onDenied\?\.\(\)/);
  });

  it("the share sheet falls back to the pre-resolved search origin", () => {
    const share = readCode("src/components/LocationShareSheet.tsx");
    expect(share).toMatch(/"stay" \| "origin" \| "other"/);
    expect(share).toMatch(/Where I'm searching/);
    expect(share).toMatch(/onDenied=\{\(\) => \{\s*if \(searchOrigin\) setMode\("origin"\)/);
  });

  it("the one-tap pickup button routes THROUGH the sheet", () => {
    const card = readCode("src/components/VendorCard.tsx");
    expect(card).toMatch(/if \(onLocationRequest\) onLocationRequest\(vendor\)/);
    // ...and the failure copy no longer blames a permission nothing used.
    expect(card).not.toMatch(/allow location access and retry/);
  });

  it("a stay-less traveller can still make a ONE-OFF share", () => {
    // The guard used to run first and unconditionally, so the one-off path
    // below it was unreachable for exactly the people who needed it.
    const consent = readCode("src/app/api/negotiate/consent/route.ts");
    expect(consent).toMatch(/const oneOff = Boolean\(body\.sharePlaceId \|\| body\.shareQuery\)/);
    expect(consent).toMatch(/if \(!stay\?\.label && !oneOff\)/);
  });
});

describe("a shared place carries a maps link - without exposing a position", () => {
  it("builds a search-by-NAME url, never a coordinate pin", () => {
    const link = placeMapsLink("Ao Nang Beach Resort, Krabi");
    expect(link).toMatch(/^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/);
    expect(link).not.toMatch(/\d+\.\d{4,}/); // no lat/lng anywhere in it
  });

  it("refuses junk and never re-wraps a url handed to it", () => {
    expect(placeMapsLink("")).toBeUndefined();
    expect(placeMapsLink("X")).toBeUndefined();
    expect(placeMapsLink("https://evil.example/x")).toBeUndefined();
  });

  it("THE PRIVACY CONTRACT IS UNCHANGED: no consent -> no link at all", () => {
    const out = resolveShareableLocation({
      label: "Sun Villas Moalboal",
      lat: 9.9394,
      lng: 123.3697,
      shareConsent: false,
    });
    expect(out.mapsLink).toBeUndefined();
    expect(out.coords).toBeUndefined();
  });

  it("consent + real coords still yields the PIN, not the name link", () => {
    const out = resolveShareableLocation({
      label: "Sun Villas Moalboal",
      lat: 9.9394,
      lng: 123.3697,
      shareConsent: true,
    });
    expect(out.mapsLink).toBe("https://maps.google.com/?q=9.939400,123.369700");
  });

  it("consent + NO coords (the one-off share) yields the name link", () => {
    const out = resolveShareableLocation({ label: "Ao Nang Beach Resort", shareConsent: true });
    expect(out.coords).toBeUndefined();
    expect(out.mapsLink).toMatch(/maps\/search\/\?api=1&query=Ao%20Nang/);
  });

  it("a one-off share is consented BY the act of choosing the place", () => {
    expect(readCode("src/lib/graph/engine.ts")).toMatch(
      /label: args\.stayLabelOverride, shareConsent: true/
    );
  });
});
