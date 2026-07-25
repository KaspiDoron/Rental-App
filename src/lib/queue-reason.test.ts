import { describe, it, expect } from "vitest";
import { classifyQueueReason, queueReasonLabel, queueEta, queueEtaRange } from "./queue-reason";

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
