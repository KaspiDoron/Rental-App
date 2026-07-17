import { describe, it, expect } from "vitest";
import { sortTranscript } from "./transcript-sort";

// Pins the Ops-console timeline fix: rows sharing a timestamp used to keep
// their spread order (ALL outbounds before ALL inbounds), rendering an
// agent reply ABOVE the shop message it answered.

describe("sortTranscript", () => {
  it("orders by time first", () => {
    const out = sortTranscript([
      { id: "o2", dir: "out" as const, at: "2026-07-17T10:00:05Z" },
      { id: "i1", dir: "in" as const, at: "2026-07-17T10:00:01Z" },
    ]);
    expect(out.map((m) => m.id)).toEqual(["i1", "o2"]);
  });

  it("same second: inbound renders BEFORE the outbound that answers it", () => {
    const out = sortTranscript([
      { id: "o9", dir: "out" as const, at: "2026-07-17T10:00:05Z" },
      { id: "i4", dir: "in" as const, at: "2026-07-17T10:00:05Z" },
    ]);
    expect(out.map((m) => m.id)).toEqual(["i4", "o9"]);
  });

  it("same second + direction: stable by numeric row id", () => {
    const out = sortTranscript([
      { id: "o11", dir: "out" as const, at: "2026-07-17T10:00:05Z" },
      { id: "o2", dir: "out" as const, at: "2026-07-17T10:00:05Z" },
    ]);
    expect(out.map((m) => m.id)).toEqual(["o2", "o11"]);
  });

  it("is deterministic regardless of input order", () => {
    const rows = [
      { id: "i1", dir: "in" as const, at: "2026-07-17T10:00:05Z" },
      { id: "o3", dir: "out" as const, at: "2026-07-17T10:00:05Z" },
      { id: "i2", dir: "in" as const, at: "2026-07-17T10:00:06Z" },
    ];
    const a = sortTranscript(rows);
    const b = sortTranscript([...rows].reverse());
    expect(a.map((m) => m.id)).toEqual(b.map((m) => m.id));
  });
});
