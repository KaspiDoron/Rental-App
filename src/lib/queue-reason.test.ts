import { describe, it, expect } from "vitest";
import {
  classifyQueueReason,
  queueReasonLabel,
  queueReasonWhy,
  queueEta,
  queueEtaRange,
} from "./queue-reason";

// The bug this file exists to prevent: the guard held messages for PACING
// while every surface claimed "waiting for the shop to open" - a lie the
// user disproved by looking at the open shop. Every stored guard reason must
// map to an honest label.

describe("classifyQueueReason", () => {
  it("maps every real guard reason to the right category", () => {
    expect(classifyQueueReason("shop is closed now")).toBe("closed");
    expect(classifyQueueReason("outside recipient business hours")).toBe("closed");
    expect(classifyQueueReason("human pacing gap")).toBe("pacing");
    expect(classifyQueueReason("burst cooldown (3 in 120s)")).toBe("pacing");
    expect(classifyQueueReason("hourly cap reached (4/h at trust 0)")).toBe("limit");
    expect(classifyQueueReason("daily new-contact cap reached (8/day)")).toBe("limit");
    expect(classifyQueueReason("number paused (ban-risk recovery)")).toBe("limit");
    expect(classifyQueueReason("paused by you")).toBe("paused");
    expect(classifyQueueReason("introductions full - refreshes soon")).toBe("capacity");
    expect(classifyQueueReason("director hold - choosing the best reply order")).toBe("hold");
    expect(classifyQueueReason("human reply pacing (thinking time)")).toBe("hold");
    expect(classifyQueueReason(undefined)).toBe("unknown");
    expect(classifyQueueReason("")).toBe("unknown");
  });

  it("NEVER claims 'shop closed' for a pacing or cap hold", () => {
    for (const r of [
      "human pacing gap",
      "burst cooldown (5 in 120s)",
      "hourly cap reached (4/h at trust 10)",
      "daily new-contact cap reached (8/day)",
      "send failed - retry 2/5",
    ]) {
      expect(queueReasonLabel(r)).not.toMatch(/shop to open|closed/i);
    }
  });

  it("labels closed-shop holds as waiting for opening", () => {
    expect(queueReasonLabel("shop is closed now")).toMatch(/shop to open/);
    expect(queueReasonLabel("outside recipient business hours")).toMatch(/shop to open/);
  });

  it("explains the rolling-window capacity hold without a 'tomorrow' wall", () => {
    const label = queueReasonLabel("introductions full - refreshes soon");
    expect(label).toMatch(/open up shortly|shortly/i);
    expect(label).not.toMatch(/tomorrow/i);
  });

  it("the circuit breakers are legible - never a blank 'Queued - sends automatically'", () => {
    // The single most consequential hold in the guard used to fall through
    // to "unknown" (the copy the 05:38 incident's queued rows showed).
    const reply =
      "reply-rate circuit breaker (0% < 15%) - cold outreach frozen to protect the number";
    const delivery = "delivery-rate breaker (40% delivered) - number may be soft-restricted";
    expect(classifyQueueReason(reply)).toBe("breaker");
    expect(classifyQueueReason(delivery)).toBe("breaker");
    expect(queueReasonLabel(reply)).toMatch(/Protecting your WhatsApp number/);
    expect(queueReasonLabel(reply)).not.toMatch(/shop to open|closed/i);
  });

  it("transient infrastructure holds all read as self-resuming", () => {
    expect(classifyQueueReason("reconnecting - resumes automatically")).toBe("sync");
    expect(classifyQueueReason("couldn't reach this shop - retry 2/5")).toBe("sync");
  });
});

describe("queueEta", () => {
  it("renders minutes, hours, imminent and empty honestly", () => {
    expect(queueEta(new Date(Date.now() + 5 * 60_000).toISOString())).toMatch(/~5 min/);
    expect(queueEta(new Date(Date.now() + 3 * 3600_000).toISOString())).toMatch(/~3 h/);
    expect(queueEta(new Date(Date.now() + 10_000).toISOString())).toBe("sends any moment now");
    expect(queueEta(undefined)).toBe("");
    expect(queueEta(null)).toBe("");
  });
  it("an overdue row does NOT claim 'any moment' - it says paced-slot honestly", () => {
    expect(queueEta(new Date(Date.now() - 3 * 60_000).toISOString())).toBe(
      "sending at the next safe slot"
    );
  });
});

describe("queueEtaRange", () => {
  const fmt = (iso: string) => iso.slice(11, 16); // HH:MM
  it("shows a range, collapses to one time when equal, empty without a start", () => {
    expect(queueEtaRange("2026-07-25T10:20:00Z", "2026-07-25T10:25:00Z", fmt)).toBe("~10:20-10:25");
    expect(queueEtaRange("2026-07-25T10:20:00Z", "2026-07-25T10:20:40Z", fmt)).toBe("~10:20");
    expect(queueEtaRange("2026-07-25T10:20:00Z", null, fmt)).toBe("~10:20");
    expect(queueEtaRange(null, "2026-07-25T10:25:00Z", fmt)).toBe("");
  });
});

// OWNER REPORT 8.1 F2 - two different waits must never share a sentence.
describe("the holds owner report 8 added say what they actually mean", () => {
  const DEAD_LINK =
    "whatsapp link is disconnected - waiting for a re-pair (not sending, so the number is not struck again)";
  // The guard's cold-lane freeze: a fixed six hours after a WhatsApp error ack.
  const COLD_FREEZE = "waiting on replies before opening more conversations";
  // introHoldReason's Meter-A wording: cleared by a SHOP, not by a clock.
  const METER_A =
    "waiting on replies - a new shop opens as soon as one of the shops already messaged answers";

  it("THE REGRESSION: the cold-lane freeze is not sold as 'a reply frees it'", () => {
    // The first cut of the awaiting-replies branch matched a bare /waiting on
    // replies/, which also caught this six-hour freeze. No reply clears it, so
    // the card promised something false and checkable where it had previously
    // said nothing at all.
    expect(classifyQueueReason(COLD_FREEZE)).not.toBe("awaiting-replies");
    expect(queueReasonLabel(COLD_FREEZE)).not.toMatch(/as soon as one answers/);
    // ...while the hold it WAS written for still classifies.
    expect(classifyQueueReason(METER_A)).toBe("awaiting-replies");
  });

  it("a dead link is its own kind, not the blank default", () => {
    // Wave A parks every automated send for 30-40 minutes on a closed session
    // with a string that matched none of the twelve branches, so the most
    // action-requiring state in the guard read "Queued - sends automatically".
    expect(classifyQueueReason(DEAD_LINK)).toBe("disconnected");
    expect(queueReasonLabel(DEAD_LINK)).toMatch(/reconnect it in Profile/i);
    expect(queueReasonLabel(DEAD_LINK)).not.toBe("Queued - sends automatically");
    expect(queueReasonWhy(DEAD_LINK)).toBeTruthy();
  });

  it("...and it shows NO ETA, because no clock controls a re-pair", () => {
    const soon = new Date(Date.now() + 35 * 60_000).toISOString();
    // The same instant on any other hold still gets its honest estimate.
    expect(queueEta(soon, METER_A)).toMatch(/sends in/);
    expect(queueEta(soon, DEAD_LINK)).toBe("");
    // Omitting the reason keeps the old behaviour for every existing caller.
    expect(queueEta(soon)).toMatch(/sends in/);
  });
});
