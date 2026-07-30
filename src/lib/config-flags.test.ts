import { describe, it, expect } from "vitest";
import { parseFlag, isFlagValue, normalizeFlag } from "./config-flags";

// The incident this guards: the admin panel stored "on", the read side
// required the literal "true", and fast dispatch silently turned OFF - which
// re-armed the business-hours park and deferred a 19:16 batch to 05:38 the
// next morning. One dialect, both directions, no silent inversion.

describe("parseFlag - one dialect for every owner switch", () => {
  it("accepts the whole ON dialect", () => {
    for (const v of ["on", "true", "1", "yes", "enabled", "ON", " True ", "YES"]) {
      expect(parseFlag(v, false)).toBe(true);
    }
  });

  it("accepts the whole OFF dialect", () => {
    for (const v of ["off", "false", "0", "no", "disabled", "OFF", " False ", "No"]) {
      expect(parseFlag(v, true)).toBe(false);
    }
  });

  it("an unreadable spelling keeps the fallback - NEVER silently false", () => {
    expect(parseFlag("banana", true)).toBe(true);
    expect(parseFlag("banana", false)).toBe(false);
    expect(parseFlag("o n", true)).toBe(true);
    expect(parseFlag("truee", true)).toBe(true);
  });

  it("empty / null / undefined keep the fallback", () => {
    expect(parseFlag("", true)).toBe(true);
    expect(parseFlag("   ", true)).toBe(true);
    expect(parseFlag(null, false)).toBe(false);
    expect(parseFlag(undefined, true)).toBe(true);
  });

  it("the exact incident spelling: a fast_dispatch row of 'on' means ON", () => {
    // Old behavior: r.value === "true" -> "on" read as FALSE.
    expect(parseFlag("on", true)).toBe(true);
    expect(parseFlag("on", false)).toBe(true);
  });
});

describe("isFlagValue - the write-side gate", () => {
  it("recognises both dialects and rejects everything else", () => {
    expect(isFlagValue("on")).toBe(true);
    expect(isFlagValue("FALSE")).toBe(true);
    expect(isFlagValue(" 1 ")).toBe(true);
    expect(isFlagValue("banana")).toBe(false);
    expect(isFlagValue("")).toBe(false);
    expect(isFlagValue("2")).toBe(false);
  });
});

describe("normalizeFlag - canonical storage spelling", () => {
  it("stores only 'true'/'false' regardless of input dialect", () => {
    expect(normalizeFlag("on", false)).toBe("true");
    expect(normalizeFlag("YES", false)).toBe("true");
    expect(normalizeFlag("off", true)).toBe("false");
    expect(normalizeFlag("0", true)).toBe("false");
  });
});
