import { describe, it, expect, vi, beforeEach } from "vitest";

// THE FACT EVERY PUSH WAS MISSING: is the hunt still on?
//
// The owner's phone buzzed hours after the search session ended, each time a
// shop got around to replying. Every emit site judged the EVENT and none
// judged the HUNT - and a TTL-expired hunt left no server-side evidence at
// all, because expiry was enforced by the CLIENT dropping sessionStorage.

vi.mock("server-only", () => ({}));

const db = {
  hunts: null as null | Array<{ source: string | null; created_at: string }>,
  marker: [] as Array<{ received_at: string }>,
  markerThrows: false,
};

vi.mock("../runtime-config", () => ({
  sbSelectStrict: vi.fn(async (_t: string, _q: string) => {
    if (db.hunts === null) return { error: "unavailable" as const };
    return { rows: db.hunts };
  }),
  sbSelect: vi.fn(async () => {
    if (db.markerThrows) throw new Error("store down");
    return db.marker;
  }),
}));

vi.mock("../session-life-config", () => ({
  searchSessionTtlMs: vi.fn(async () => 3 * 3600_000),
}));

import { huntState, huntIsLive } from "./liveness";

const NOW = Date.parse("2026-08-12T12:00:00Z");
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();

beforeEach(() => {
  db.hunts = [];
  db.marker = [];
  db.markerThrows = false;
});

describe("a hunt is live while it is fresh and uncleared", () => {
  it("a fresh hunt is live", async () => {
    db.hunts = [{ source: "search", created_at: iso(30) }];
    expect(await huntState("t@x.com", NOW)).toEqual({
      live: true,
      startedIso: iso(30),
    });
  });

  it("a hunt past the TTL is over, with the reason named", async () => {
    // THE GAP: expiry used to exist only in the client's sessionStorage, so
    // the server pushed and negotiated forever.
    db.hunts = [{ source: "search", created_at: iso(200) }];
    expect(await huntState("t@x.com", NOW)).toEqual({
      live: false,
      startedIso: iso(200),
      reason: "ttl-expired",
    });
  });

  it("a clear AFTER the hunt started ends it, whatever the TTL says", async () => {
    db.hunts = [{ source: "search", created_at: iso(30) }];
    db.marker = [{ received_at: iso(10) }];
    expect((await huntState("t@x.com", NOW)).reason).toBe("cleared");
  });

  it("a clear BEFORE the newest hunt does not kill the new hunt", async () => {
    // Search, clear, search again: the newest hunt postdates the marker and
    // is genuinely live.
    db.hunts = [{ source: "search", created_at: iso(20) }];
    db.marker = [{ received_at: iso(60) }];
    expect(await huntIsLive("t@x.com", NOW)).toBe(true);
  });
});

describe("the pre-hunt analytics rows cannot impersonate a hunt", () => {
  it("request-build rows are skipped, the newest REAL hunt decides", async () => {
    // /api/profile writes a `searches` row per RFQ build. Newest row being a
    // build must not make a 5-hour-old hunt look 5 minutes old.
    db.hunts = [
      { source: "panel", created_at: iso(5) },
      { source: "profiler", created_at: iso(6) },
      { source: "search", created_at: iso(300) },
    ];
    expect((await huntState("t@x.com", NOW)).reason).toBe("ttl-expired");
  });

  it("no real hunt at all means no live hunt", async () => {
    db.hunts = [{ source: "panel", created_at: iso(5) }];
    expect(await huntState("t@x.com", NOW)).toEqual({ live: false, reason: "no-hunt" });
  });

  it("an unparseable timestamp is filed as no-hunt, never promoted to live", async () => {
    db.hunts = [{ source: "search", created_at: "not a date" }];
    expect((await huntState("t@x.com", NOW)).live).toBe(false);
  });
});

describe("the fail directions", () => {
  it("an unreadable hunts table answers UNKNOWN, not dead", async () => {
    // The gate leans toward pushing on null: a missed suppression is one
    // unwanted buzz; a suppression on a store blip is a real price the
    // traveller never hears about.
    db.hunts = null;
    expect(await huntIsLive("t@x.com", NOW)).toBe(null);
  });

  it("an unreadable MARKER leans open - the TTL still bounds the damage", async () => {
    db.hunts = [{ source: "search", created_at: iso(30) }];
    db.markerThrows = true;
    expect(await huntIsLive("t@x.com", NOW)).toBe(true);
  });

  it("no email means no hunt, not unknown", async () => {
    expect((await huntState("", NOW)).live).toBe(false);
  });
});
