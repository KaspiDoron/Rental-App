import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { parseInboundCoords, distanceNote, describeShopLocation } from "./inbound-location";

describe("parseInboundCoords - extract coords from inbound text", () => {
  it("parses a Google Maps ?q= link", () => {
    expect(parseInboundCoords("here we are https://maps.google.com/?q=7.8804,98.3923")).toEqual({
      lat: 7.8804,
      lng: 98.3923,
    });
  });
  it("parses an @lat,lng maps URL", () => {
    expect(parseInboundCoords("https://www.google.com/maps/@13.7563,100.5018,15z")).toEqual({
      lat: 13.7563,
      lng: 100.5018,
    });
  });
  it("parses a bare 'lat, lng' pair", () => {
    expect(parseInboundCoords("we're at -8.6705, 115.2126 come by")).toEqual({
      lat: -8.6705,
      lng: 115.2126,
    });
  });
  it("returns null for text with no coordinates", () => {
    expect(parseInboundCoords("best price is per day, come to the shop")).toBeNull();
  });
  it("rejects out-of-range values", () => {
    expect(parseInboundCoords("?q=999.1234,500.5678")).toBeNull();
  });
});

describe("distanceNote - rough distance to stay (privacy-safe)", () => {
  it("is empty when the stay coords are unknown (no consent)", () => {
    expect(distanceNote({ lat: 7.88, lng: 98.39 }, null)).toBe("");
    expect(distanceNote({ lat: 7.88, lng: 98.39 }, { lat: undefined, lng: undefined })).toBe("");
  });
  it("reports a close distance as delivery-realistic", () => {
    // ~0.5 km apart in Phuket.
    const note = distanceNote({ lat: 7.8804, lng: 98.3923 }, { lat: 7.8849, lng: 98.3923 });
    expect(note).toMatch(/km|m/);
    expect(note).toMatch(/delivery is realistic/);
  });
  it("flags a far distance as delivery-uncertain", () => {
    const note = distanceNote({ lat: 7.8804, lng: 98.3923 }, { lat: 13.7563, lng: 100.5018 });
    expect(note).toMatch(/far/);
  });
});

describe("describeShopLocation - enriched synthetic text", () => {
  it("always includes the maps link + name, and the distance when known", () => {
    const out = describeShopLocation(
      { lat: 7.8804, lng: 98.3923, name: "Joe Bikes" },
      { lat: 7.8849, lng: 98.3923 }
    );
    expect(out).toContain("Joe Bikes");
    expect(out).toContain("https://maps.google.com/?q=7.8804,98.3923");
    expect(out).toMatch(/from the traveller's stay/);
  });
});
