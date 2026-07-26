import { describe, it, expect } from "vitest";
import { friendlySendError } from "./send-error";

// The live failure: a shop card displayed `instance requires property "text"`
// in an amber box under a green "Ask for price" button. That is Evolution's
// schema validator complaining about a request body OUR code built.

describe("a traveller never reads an upstream error", () => {
  it("translates the exact string that shipped to a real user", () => {
    const r = friendlySendError('instance requires property "text"');
    expect(r.text).not.toMatch(/instance|property|text"/);
    expect(r.text).toMatch(/our side/i);
    // It is our bug, so do not send them into a retry loop over it.
    expect(r.retryable).toBe(false);
  });

  it("never returns the raw string for ANY schema-shaped complaint", () => {
    for (const raw of [
      'instance requires property "text"',
      "should have required property 'number'",
      "body/text must be a string",
      "Invalid body: validation failed",
    ]) {
      expect(friendlySendError(raw).text).not.toContain(raw);
    }
  });

  it("keeps the genuinely actionable cases actionable", () => {
    expect(friendlySendError("instance not connected").retryable).toBe(true);
    expect(friendlySendError("reconnecting").retryable).toBe(true);
    expect(friendlySendError("request timed out").retryable).toBe(true);
  });

  it("says plainly when a shop simply cannot be reached", () => {
    const r = friendlySendError("number is not on whatsapp");
    expect(r.text).toMatch(/not on WhatsApp/i);
    expect(r.retryable).toBe(false);
  });

  it("explains pacing as a safety feature, not a fault", () => {
    expect(friendlySendError("too many requests").text).toMatch(/pacing|safe/i);
  });

  it("falls back honestly on anything unrecognised - never a blank or a leak", () => {
    for (const raw of ["", null, undefined, "kaboom 12345"]) {
      const r = friendlySendError(raw as string);
      expect(r.text.length).toBeGreaterThan(20);
      if (raw) expect(r.text).not.toContain(String(raw));
    }
  });
});
