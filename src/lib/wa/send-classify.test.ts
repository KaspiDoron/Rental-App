import { describe, it, expect } from "vitest";
import {
  isRecipientSendFailure,
  isTransientSendFailure,
  transientRetryDecision,
  recipientRetryDecision,
  TRANSIENT_MAX_LIFETIME_MS,
  TRANSIENT_MAX_ATTEMPTS,
  RECIPIENT_MAX_ATTEMPTS,
} from "./send-classify";

describe("send failure classification (batch-stall fix)", () => {
  it("treats host/infra errors as TRANSIENT (fast retry, no attempt burn)", () => {
    for (const e of [
      "reconnecting",
      "not-connected",
      "Evolution API 502",
      "Evolution API 503",
      "request timed out",
      "ECONNRESET",
      "EAI_AGAIN",
      "",
      undefined,
      null,
    ]) {
      expect(isTransientSendFailure(e)).toBe(true);
      expect(isRecipientSendFailure(e)).toBe(false);
    }
  });

  it("treats recipient errors as terminal (counts toward the give-up cap)", () => {
    for (const e of [
      "number is not on WhatsApp",
      "invalid number",
      "recipient blocked us",
      "forbidden",
      "no-phone",
    ]) {
      expect(isRecipientSendFailure(e)).toBe(true);
      expect(isTransientSendFailure(e)).toBe(false);
    }
  });
});

describe("transientRetryDecision (bounded transient retries - dead-host loop fix)", () => {
  const T0 = 1_000_000_000_000;

  it("re-queues fast (45-120s) without burning the attempt cap early on", () => {
    const d0 = transientRetryDecision(T0, 0, T0 + 60_000, 0);
    expect(d0.drop).toBe(false);
    if (!d0.drop) {
      expect(d0.attempts).toBe(1);
      expect(d0.delayMs).toBe(45_000); // jitter 0 -> floor 45s
    }
    const dJit = transientRetryDecision(T0, 0, T0 + 60_000, 1);
    expect(dJit.drop).toBe(false);
    if (!dJit.drop) expect(dJit.delayMs).toBe(120_000); // jitter 1 -> 45 + 75 = 120s
  });

  it("DROPS once the host has been unreachable past the 24h lifetime cap", () => {
    const stillTransient = transientRetryDecision(T0, 5, T0 + TRANSIENT_MAX_LIFETIME_MS, 0.5);
    expect(stillTransient.drop).toBe(false); // exactly at the boundary still retries
    const past = transientRetryDecision(T0, 5, T0 + TRANSIENT_MAX_LIFETIME_MS + 1, 0.5);
    expect(past.drop).toBe(true); // 24h + 1ms -> give up (never loops forever)
  });

  it("DROPS once attempts exceed the transient attempt cap", () => {
    const atCap = transientRetryDecision(T0, TRANSIENT_MAX_ATTEMPTS - 1, T0 + 1000, 0.5);
    expect(atCap.drop).toBe(false); // priorAttempts 59 -> attempts 60, still allowed
    const overCap = transientRetryDecision(T0, TRANSIENT_MAX_ATTEMPTS, T0 + 1000, 0.5);
    expect(overCap.drop).toBe(true); // priorAttempts 60 -> attempts 61, dropped
  });

  it("clamps out-of-range jitter into the 45-120s band", () => {
    const lo = transientRetryDecision(T0, 0, T0 + 1000, -5);
    const hi = transientRetryDecision(T0, 0, T0 + 1000, 9);
    if (!lo.drop) expect(lo.delayMs).toBe(45_000);
    if (!hi.drop) expect(hi.delayMs).toBe(120_000);
  });
});

describe("recipientRetryDecision (capped backoff, terminal after N)", () => {
  it("backs off with a capped delay for the first attempts", () => {
    const a1 = recipientRetryDecision(0);
    expect(a1.drop).toBe(false);
    if (!a1.drop) {
      expect(a1.attempts).toBe(1);
      expect(a1.delayMs).toBe(4 * 60_000); // attempt 1 -> 4 min
    }
    const a5 = recipientRetryDecision(4);
    expect(a5.drop).toBe(false);
    if (!a5.drop) expect(a5.delayMs).toBe(20 * 60_000); // capped at 20 min, never creeps past
  });

  it(`DROPS after ${RECIPIENT_MAX_ATTEMPTS} attempts`, () => {
    const last = recipientRetryDecision(RECIPIENT_MAX_ATTEMPTS - 1);
    expect(last.drop).toBe(false); // attempt 5 still retries
    const over = recipientRetryDecision(RECIPIENT_MAX_ATTEMPTS);
    expect(over.drop).toBe(true); // attempt 6 -> dropped
  });
});
