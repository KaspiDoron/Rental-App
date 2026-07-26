import { describe, it, expect } from "vitest";
import {
  MISREAD_KINDS,
  compileMisreadLesson,
  isMisreadKind,
  kindFromNote,
  lessonNote,
  misreadTag,
  situationKinds,
} from "./misread";

describe("misread vocabulary - closed on purpose", () => {
  it("accepts only the labels the engine actually models", () => {
    for (const k of MISREAD_KINDS) expect(isMisreadKind(k)).toBe(true);
    // Free prose would compile into a lesson nothing can ever retrieve.
    expect(isMisreadKind("the shop was being weird")).toBe(false);
    expect(isMisreadKind("")).toBe(false);
    expect(isMisreadKind(undefined)).toBe(false);
  });

  it("round-trips through the storage note", () => {
    for (const k of MISREAD_KINDS) expect(kindFromNote(lessonNote(k))).toBe(k);
    expect(kindFromNote("lesson:nonsense")).toBeNull();
    expect(kindFromNote(null)).toBeNull();
    expect(kindFromNote("ops-exemplar")).toBeNull();
  });

  it("tags the review row so corrections stay queryable", () => {
    expect(misreadTag("option-menu")).toBe("misread:option-menu");
  });
});

describe("compiled lesson", () => {
  const marlin = {
    shopMessage: "Hi! Normal scooters? Some models 200 and some new 250/day",
    actualMeaning: "option-menu" as const,
    shouldHaveMoved: "option-probe" as const,
  };

  it("quotes the shop and states what it really was", () => {
    const t = compileMisreadLesson(marlin, { vendorName: "Marlin Krabi", day: "2026-07-26" });
    expect(t).toContain("Marlin Krabi");
    expect(t).toContain("Some models 200 and some new 250/day");
    expect(t).toContain("option-menu");
    expect(t).toContain("option-probe");
    // The teachable part - not just a label.
    expect(t.toLowerCase()).toContain("before haggling");
  });

  it("stays inside the prompt budget even on a long message", () => {
    const t = compileMisreadLesson(
      { ...marlin, shopMessage: "x".repeat(5000) },
      { why: "y".repeat(5000) }
    );
    expect(t.length).toBeLessThanOrEqual(900);
  });

  it("normalises whitespace so a pasted multi-line quote stays one line", () => {
    const t = compileMisreadLesson({
      shopMessage: "200\n\n  or   250\tper day",
      actualMeaning: "option-menu",
    });
    expect(t).toContain("200 or 250 per day");
    expect(t).not.toContain("\n");
  });
});

describe("situational retrieval - the right lesson on the right turn", () => {
  it("a menu on screen surfaces the menu lesson and nothing else", () => {
    expect(situationKinds({ optionCount: 2 })).toEqual(["option-menu"]);
    // Variance alone counts: "it depends what you choose" IS a menu.
    expect(situationKinds({ variance: true })).toEqual(["option-menu"]);
  });

  it("a photo turn surfaces the price-board lesson", () => {
    expect(situationKinds({ hadImage: true })).toContain("photo-price-board");
    expect(situationKinds({ imageKind: "price_sheet" })).toContain("photo-price-board");
  });

  it("an ordinary quote surfaces nothing - no lesson is better than a wrong one", () => {
    expect(situationKinds({ optionCount: 1 })).toEqual([]);
    expect(situationKinds({})).toEqual([]);
  });

  it("several signals at once retrieve several lessons", () => {
    const k = situationKinds({ optionCount: 3, hadImage: true, askedLocation: true });
    expect(k).toContain("option-menu");
    expect(k).toContain("photo-price-board");
    expect(k).toContain("location-request");
  });

  it("every returned kind is a real vocabulary member (retrieval can never miss)", () => {
    const k = situationKinds({
      optionCount: 2,
      hadImage: true,
      askedLocation: true,
      askedQuestion: true,
      declined: true,
      firm: true,
      listPriceSeen: true,
    });
    for (const x of k) expect(MISREAD_KINDS).toContain(x);
    expect(new Set(k).size).toBe(k.length);
  });
});
