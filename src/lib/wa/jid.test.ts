import { describe, it, expect } from "vitest";
import { jidMatches } from "./jid";

// The privacy keystone: a message record may only be ingested into a chat if
// its remoteJid belongs to that chat. This is what stops the whole-inbox leak
// (personal chats shown as shop replies).
describe("jidMatches - per-message origin filter", () => {
  const shop = "84912435006@s.whatsapp.net";

  it("matches the exact same JID", () => {
    expect(jidMatches(shop, shop)).toBe(true);
  });

  it("matches phone JIDs by their numeric user part (format tolerant)", () => {
    expect(jidMatches("84912435006@c.us", shop)).toBe(true);
    expect(jidMatches("+84 91 243 5006@s.whatsapp.net", shop)).toBe(true);
  });

  it("REJECTS a different contact - a personal chat can never match a shop", () => {
    // The exact leak: a Hebrew personal contact must not match the Viet shop.
    expect(jidMatches("972501234567@s.whatsapp.net", shop)).toBe(false);
    expect(jidMatches("491701234567@s.whatsapp.net", shop)).toBe(false);
  });

  it("never matches a privacy @lid JID by digits (its number is not a phone)", () => {
    // @lid JIDs must only match by EXACT equality, never by numeric part.
    expect(jidMatches("84912435006@lid", shop)).toBe(false);
    expect(jidMatches("12345@lid", "12345@lid")).toBe(true); // exact still ok
    expect(jidMatches("12345@lid", "99999@lid")).toBe(false);
  });

  it("rejects empty / malformed input (fail closed)", () => {
    expect(jidMatches("", shop)).toBe(false);
    expect(jidMatches(shop, "")).toBe(false);
    expect(jidMatches("", "")).toBe(false);
  });
});
