import { describe, it, expect } from "vitest";
import { wakeupRetryDecision, WAKEUP_MAX_RETRIES } from "./wakeup-retry";

describe("wakeupRetryDecision (a thrown wakeup must not silently stall a negotiation)", () => {
  it("reschedules the first failure with a 5 min backoff", () => {
    const d = wakeupRetryDecision(0);
    expect(d.reschedule).toBe(true);
    if (d.reschedule) {
      expect(d.attempts).toBe(1);
      expect(d.delayMs).toBe(5 * 60_000);
    }
  });

  it("backs off linearly up to the retry budget (max 25 min at attempt 5); the 30 min ceiling guards a raised cap", () => {
    const d5 = wakeupRetryDecision(4); // attempt 5 -> min(25,30) = 25 min
    expect(d5.reschedule).toBe(true);
    if (d5.reschedule) expect(d5.delayMs).toBe(25 * 60_000);
  });

  it("keeps rescheduling up to the retry cap", () => {
    const d = wakeupRetryDecision(WAKEUP_MAX_RETRIES - 1);
    expect(d.reschedule).toBe(true); // attempt 5 still retries
  });

  it("STOPS rescheduling past the cap (a persistently-failing turn cannot loop)", () => {
    const d = wakeupRetryDecision(WAKEUP_MAX_RETRIES);
    expect(d.reschedule).toBe(false); // attempt 6 -> give up
  });
});
