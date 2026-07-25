import { describe, it, expect } from "vitest";
import { generateVapidPair, vapidPairMatches } from "./push-keys";

describe("generateVapidPair", () => {
  it("mints base64url keys (no +, /, or padding) of the expected sizes", () => {
    const { publicKey, privateKey } = generateVapidPair();
    expect(publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(privateKey).toMatch(/^[A-Za-z0-9_-]+$/);
    // Uncompressed P-256 point = 65 bytes; private scalar = 32 bytes.
    expect(Buffer.from(publicKey, "base64url")).toHaveLength(65);
    expect(Buffer.from(privateKey, "base64url")).toHaveLength(32);
  });

  it("mints a distinct pair every call", () => {
    expect(generateVapidPair().publicKey).not.toBe(generateVapidPair().publicKey);
  });
});

describe("vapidPairMatches", () => {
  it("accepts a genuine pair", () => {
    const { publicKey, privateKey } = generateVapidPair();
    expect(vapidPairMatches(publicKey, privateKey)).toBe(true);
  });

  it("rejects a cross-matched pair (the lost-race shape)", () => {
    const a = generateVapidPair();
    const b = generateVapidPair();
    expect(vapidPairMatches(a.publicKey, b.privateKey)).toBe(false);
    expect(vapidPairMatches(b.publicKey, a.privateKey)).toBe(false);
  });

  it("rejects malformed input without throwing", () => {
    const { publicKey, privateKey } = generateVapidPair();
    expect(vapidPairMatches("", privateKey)).toBe(false);
    expect(vapidPairMatches(publicKey, "")).toBe(false);
    expect(vapidPairMatches("not-a-key", "also-not-a-key")).toBe(false);
    expect(vapidPairMatches(publicKey, "AAAA")).toBe(false);
  });
});
