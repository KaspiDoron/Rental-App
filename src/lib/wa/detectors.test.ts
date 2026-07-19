import { describe, it, expect } from "vitest";
import { shopAskedLocation } from "./detectors";

describe("shopAskedLocation - the delivery-loop trigger", () => {
  it("matches the exact production asks (even without a '?')", () => {
    expect(shopAskedLocation("Where did you stay sir?")).toBe(true);
    expect(shopAskedLocation("Where is you hotel?")).toBe(true);
    expect(shopAskedLocation("where are you staying")).toBe(true);
    expect(shopAskedLocation("send me your hotel location")).toBe(true);
    expect(shopAskedLocation("what is your address for delivery")).toBe(true);
    expect(shopAskedLocation("please share your location")).toBe(true);
    expect(shopAskedLocation("your hotel?")).toBe(true);
  });

  it("does NOT match small talk 'where are you from'", () => {
    expect(shopAskedLocation("where are you from?")).toBe(false);
    expect(shopAskedLocation("where r you from")).toBe(false);
  });

  it("does NOT fire on ordinary negotiation lines", () => {
    expect(shopAskedLocation("It's 350 a day the Honda beat 125")).toBe(false);
    expect(shopAskedLocation("can you do 300 per day?")).toBe(false);
    expect(shopAskedLocation("what dates do you need it")).toBe(false);
    expect(shopAskedLocation("")).toBe(false);
  });

  it("does NOT fire on DECLARATIVE messages that merely mention a hotel/address", () => {
    expect(shopAskedLocation("Delivery to the hotel is 50k extra")).toBe(false);
    expect(shopAskedLocation("Yes we deliver to your hotel")).toBe(false);
    expect(shopAskedLocation("The address is Jl Sunset Road 88")).toBe(false);
    expect(shopAskedLocation("we can bring it to your hotel no problem")).toBe(false);
  });
});
