import { describe, it, expect } from "vitest";
import { coalesceUnreadInbound, type CoalesceMsg } from "./coalesce";

const t = (n: number) => new Date(1_700_000_000_000 + n * 1000).toISOString();

describe("coalesceUnreadInbound - the dropped-price fix (Qui Motorbike 3-frame burst)", () => {
  it("merges the whole unread burst so the price binds to the vehicle", () => {
    const thread: CoalesceMsg[] = [
      { direction: "outbound", body: "Hey! automatic scooter 125cc for 5 days?", received_at: t(0) },
      { direction: "inbound", body: "Good day!", received_at: t(10) },
      { direction: "inbound", body: "We have available Fazzio", received_at: t(20) },
      {
        direction: "inbound",
        body: "Regular rate is 550, we can give you 400 per day/24hrs",
        received_at: t(30),
      },
    ];
    const out = coalesceUnreadInbound(thread, t(0), "Regular rate is 550, we can give you 400 per day/24hrs");
    expect(out).toContain("Fazzio");
    expect(out).toContain("400 per day");
    // Chronological, all three frames, one blob.
    expect(out.split("\n")).toHaveLength(3);
  });

  it("only includes messages AFTER our last outbound (never re-ingests answered ones)", () => {
    const thread: CoalesceMsg[] = [
      { direction: "inbound", body: "old 300/day", received_at: t(0) },
      { direction: "outbound", body: "our reply", received_at: t(10) },
      { direction: "inbound", body: "now 250/day", received_at: t(20) },
    ];
    const out = coalesceUnreadInbound(thread, t(10), "now 250/day");
    expect(out).toBe("now 250/day");
    expect(out).not.toContain("old 300");
  });

  it("includes the just-arrived message even when its row is not yet visible", () => {
    const thread: CoalesceMsg[] = [
      { direction: "outbound", body: "q", received_at: t(0) },
      { direction: "inbound", body: "We have available Fazzio", received_at: t(20) },
    ];
    // The price frame's row hasn't landed in the read yet - passed as currentText.
    const out = coalesceUnreadInbound(thread, t(0), "400 per day ok");
    expect(out).toContain("Fazzio");
    expect(out).toContain("400 per day");
  });

  it("does not duplicate the current message when its row IS already visible", () => {
    const thread: CoalesceMsg[] = [
      { direction: "outbound", body: "q", received_at: t(0) },
      { direction: "inbound", body: "400 per day", received_at: t(20) },
    ];
    const out = coalesceUnreadInbound(thread, t(0), "400 per day");
    expect(out).toBe("400 per day");
  });

  it("caps to the last N frames and a char budget", () => {
    const thread: CoalesceMsg[] = [
      { direction: "outbound", body: "q", received_at: t(0) },
      ...Array.from({ length: 20 }, (_, i) => ({
        direction: "inbound" as const,
        body: `frame ${i}`,
        received_at: t(10 + i),
      })),
    ];
    const out = coalesceUnreadInbound(thread, t(0), undefined, { maxFrames: 8 });
    expect(out.split("\n")).toHaveLength(8);
    expect(out).toContain("frame 19"); // the newest survives
    expect(out).not.toContain("frame 0"); // the oldest is dropped
  });

  it("returns empty when there is no unread inbound (a bare tick)", () => {
    const thread: CoalesceMsg[] = [{ direction: "outbound", body: "q", received_at: t(0) }];
    expect(coalesceUnreadInbound(thread, t(0))).toBe("");
  });
});
