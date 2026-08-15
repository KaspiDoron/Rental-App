import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  reopenEpoch,
  isSessionFresh,
  huntWindow,
  huntWindowFilter,
  SEARCH_SESSION_TTL_MS,
} from "./session-life";

// TRIPS, PROVED BY RUNNING IT (owner report 5 #17 and the audit that followed).
//
// Four defects, all of them invisible to a grep and all of them reproduced
// here by executing the actual route handlers against a fake PostgREST:
//
//   1. "Re-open this hunt" dead-ended for every hunt the feature exists for.
//      The server served the hunt correctly and stamped the payload with the
//      ORIGINAL hunt's start; the Find-deals screen then refuses any blob whose
//      epoch is past SEARCH_SESSION_TTL_MS and lands on a blank search screen.
//      Every hunt in the "Earlier hunts" drawer is past that cliff BY
//      CONSTRUCTION - partitionHunts archives on the same TTL - so re-open
//      worked only for hunts younger than three hours.
//   2. No card showed a date or a duration. `booking.durationDays` was shipped
//      and read only by partitionHunts; a hunt with no booking carried no
//      duration at all, though /api/deals/recheck reads the very same
//      `searches.rfq.durationDays` from the very same rows.
//   3. The card's re-ask count and the re-ask route's own count came from
//      different windows: the card bounded to the hunt, the route read the
//      newest 200 rows of all time. Past a few hunts the route saw none of
//      them and answered "No shops were messaged in that hunt." about shops
//      the card had just listed by name.
//   4. An unreadable database rendered as "No hunts yet - and I'm ready".
//
// The unit tests below pin the shared arithmetic; the route tests are the ones
// that fail if any of the four is reverted.

// ---------------------------------------------------------------------------
// A FAKE POSTGREST. Enough of it that a query's date bound and its `limit`
// interact exactly the way they do in production - which IS defect 3.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function fakeSupabase(tables: Record<string, Row[]>) {
  const queries: { table: string; query: string }[] = [];
  function select(table: string, query: string): Row[] {
    queries.push({ table, query });
    const p = new URLSearchParams(query);
    let rows = [...(tables[table] ?? [])];
    for (const [key, raw] of p.entries()) {
      if (["select", "order", "limit", "offset", "or"].includes(key)) continue;
      const m = /^(gte|gt|lte|lt|eq)\.(.*)$/s.exec(raw);
      if (!m) continue;
      const [, op, val] = m;
      // Columns the fixtures do not model (`raw->>sender`, `simulated`, ...)
      // are ignored - every fixture is already scoped to one user.
      if (!rows.length || !(key in rows[0])) continue;
      rows = rows.filter((r) => {
        const cell = r[key];
        if (op === "eq") return String(cell) === val;
        const a = Date.parse(String(cell));
        const b = Date.parse(val);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
        if (op === "gte") return a >= b;
        if (op === "gt") return a > b;
        if (op === "lte") return a <= b;
        return a < b;
      });
    }
    const order = p.get("order");
    if (order) {
      const [col, dir] = order.split(".");
      rows.sort((x, y) => {
        const ax = Date.parse(String(x[col]));
        const ay = Date.parse(String(y[col]));
        const a = Number.isFinite(ax) ? ax : Number(x[col]);
        const b = Number.isFinite(ay) ? ay : Number(y[col]);
        return dir === "asc" ? a - b : b - a;
      });
    }
    const limit = Number(p.get("limit"));
    if (Number.isFinite(limit) && limit > 0) rows = rows.slice(0, limit);
    return rows;
  }
  return { select, queries };
}

const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => vi.resetModules());
afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// 1. THE ARITHMETIC
// ---------------------------------------------------------------------------

describe("reopenEpoch - a deliberate re-open is honoured, the protection is kept", () => {
  const now = 1_800_000_000_000;

  it("an archived hunt gets a FRESH epoch, so the client cannot delete it", () => {
    const weekOld = now - 7 * 24 * 3600_000;
    const stamped = reopenEpoch(weekOld, now, SEARCH_SESSION_TTL_MS);
    expect(stamped).toBe(now);
    // ...which is the exact predicate src/app/page.tsx runs on the stored blob.
    // With the old `searchEpoch: start` this is false, the blob is removed and
    // the traveller lands on an empty search screen.
    expect(isSessionFresh(stamped, now, SEARCH_SESSION_TTL_MS)).toBe(true);
    expect(isSessionFresh(weekOld, now, SEARCH_SESSION_TTL_MS)).toBe(false);
  });

  it("every hunt in the archive drawer is past the cliff, which is the point", () => {
    // partitionHunts archives on the same TTL, so "an archived hunt" and "a
    // hunt the old restore could not re-open" were the same set.
    const justArchived = now - SEARCH_SESSION_TTL_MS - 1;
    expect(isSessionFresh(justArchived, now, SEARCH_SESSION_TTL_MS)).toBe(false);
    expect(isSessionFresh(reopenEpoch(justArchived, now, SEARCH_SESSION_TTL_MS), now)).toBe(true);
  });

  it("a still-live hunt keeps its real start - nothing is gained by moving it", () => {
    const anHourAgo = now - 3600_000;
    expect(reopenEpoch(anHourAgo, now, SEARCH_SESSION_TTL_MS)).toBe(anHourAgo);
  });

  it("the fresh epoch is the STRICT direction for the thing the TTL protects", () => {
    // The danger was never the hunt's age - it was an ancient epoch becoming
    // the `since=` of every live poll. Moving the epoch forward can only
    // NARROW that window, never widen it.
    const weekOld = now - 7 * 24 * 3600_000;
    expect(reopenEpoch(weekOld, now, SEARCH_SESSION_TTL_MS)).toBeGreaterThan(weekOld);
  });
});

describe("huntWindow - one window, so two routes cannot disagree about a hunt", () => {
  const rows = (n: number, at: number) => ({ id: n, source: "google", created_at: iso(at) });
  const t0 = 1_800_000_000_000;
  const groups = [[rows(3, t0)], [rows(2, t0 - 5 * 3600_000)], [rows(1, t0 - 50 * 3600_000)]];

  it("the newest hunt has no upper bound; an older one ends where the next begins", () => {
    expect(huntWindow(groups, 0).end).toBe(Infinity);
    expect(huntWindow(groups, 0).endIso).toBeNull();
    expect(huntWindow(groups, 1).end).toBe(t0);
    expect(huntWindow(groups, 1).endIso).toBe(iso(t0));
  });

  it("membership and the query bound come from the SAME object", () => {
    const w = huntWindow(groups, 1);
    expect(w.contains(iso(t0 - 4 * 3600_000))).toBe(true);
    expect(w.contains(iso(t0 + 60_000))).toBe(false);
    expect(w.contains(iso(t0 - 40 * 3600_000))).toBe(false);
    const f = huntWindowFilter("received_at", w, (v) => v);
    expect(f).toContain(`received_at=gte.${w.startIso}`);
    expect(f).toContain(`received_at=lt.${w.endIso}`);
    // The newest hunt gets a floor and no ceiling - never an unbounded read.
    expect(huntWindowFilter("created_at", huntWindow(groups, 0), (v) => v)).not.toContain("lt.");
  });

  it("a grace on the start, because the search row and the first send race", () => {
    const w = huntWindow(groups, 0);
    expect(w.contains(iso(t0 - 400))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. THE ROUTES
// ---------------------------------------------------------------------------

async function loadRestore(tables: Record<string, Row[]>, strict?: Record<string, unknown>) {
  const db = fakeSupabase(tables);
  vi.doMock("@/lib/session", () => ({
    getSession: async () => ({ email: "t@example.com", plan: "pro", role: "user" }),
  }));
  vi.doMock("@/lib/session-life-config", () => ({
    searchSessionTtlMs: async () => SEARCH_SESSION_TTL_MS,
  }));
  vi.doMock("@/lib/runtime-config", () => ({
    sbSelect: async (table: string, q: string) => db.select(table, q),
    sbSelectStrict: async (table: string, q: string) =>
      strict?.[table] ?? { rows: db.select(table, q) },
    pgTimestamp: (v: string) => v,
  }));
  const mod = await import("@/app/api/deals/restore/route");
  return { GET: mod.GET, db };
}

describe("FIX 1 - /api/deals/restore serves a re-openable payload, not a doomed one", () => {
  const now = Date.now();
  const huntAt = now - 6 * 24 * 3600_000; // six days: deep in "Earlier hunts"

  const searches = [
    {
      id: 41,
      query_text: "scooter in ao nang",
      lat: null,
      lng: null,
      radius_km: 5,
      vehicle_class: "scooter",
      source: "google",
      rfq: { vehicleClass: "scooter", durationDays: 4 },
      snapshot: [{ id: "v1", name: "Ao Nang Bikes", whatsapp: "66811111111" }],
      origin_label: "Ao Nang",
      created_at: iso(huntAt),
    },
  ];

  it("an archived hunt comes back with an epoch the client will ACCEPT", async () => {
    const { GET } = await loadRestore(
      { searches, whatsapp_messages: [], offers: [] },
      { whatsapp_messages: { rows: [] } }
    );
    const res = await GET(new Request(`http://x/api/deals/restore?ts=${iso(huntAt)}&sid=41`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.payload.vendors).toHaveLength(1);
    // THE WHOLE BUG. This used to be `huntAt`, and src/app/page.tsx deletes any
    // stored blob failing exactly this predicate - so the workspace the server
    // had just rebuilt was thrown away on arrival.
    expect(isSessionFresh(body.payload.searchEpoch, Date.now(), SEARCH_SESSION_TTL_MS)).toBe(true);
    expect(body.payload.searchEpoch).not.toBe(huntAt);
    expect(body.reopened).toBe(true);
    // ...and the real start is not lost, it is just no longer a polling floor.
    expect(body.payload.huntStartedAt).toBe(iso(huntAt));
    expect(body.payload.sid).toBe(41);
  });

  it("a hunt that is still live keeps its own start", async () => {
    const liveAt = now - 30 * 60_000;
    const { GET } = await loadRestore(
      { searches: [{ ...searches[0], created_at: iso(liveAt) }], whatsapp_messages: [], offers: [] },
      { whatsapp_messages: { rows: [] } }
    );
    const res = await GET(new Request(`http://x/api/deals/restore?ts=${iso(liveAt)}&sid=41`));
    const body = await res.json();
    expect(body.payload.searchEpoch).toBe(liveAt);
    expect(body.reopened).toBe(false);
  });
});

async function loadDeals(
  tables: Record<string, Row[]>,
  strict?: Record<string, unknown> | "unavailable"
) {
  const db = fakeSupabase(tables);
  vi.doMock("@/lib/session", () => ({
    getSession: async () => ({ email: "t@example.com", plan: "pro", role: "user" }),
  }));
  vi.doMock("@/lib/runtime-config", () => ({
    sbSelect: async (table: string, q: string) => db.select(table, q),
    sbSelectStrict: async (table: string, q: string) => {
      if (strict === "unavailable" && table === "searches") return { error: "unavailable" };
      const hit = typeof strict === "object" ? strict?.[table] : undefined;
      return hit ?? { rows: db.select(table, q) };
    },
    pgTimestamp: (v: string) => v,
  }));
  const mod = await import("@/app/api/deals/route");
  return { GET: mod.GET, db };
}

describe("FIX 2 - the dates and the duration reach the card", () => {
  const startedAt = iso(Date.now() - 2 * 3600_000);

  it("a hunt with NO booking still reports its length and its dates", async () => {
    const { GET } = await loadDeals({
      searches: [
        {
          id: 7,
          query_text: "scooter in ao nang",
          radius_km: 5,
          vehicle_class: "scooter",
          source: "google",
          results: 6,
          rfq: { durationDays: 4, startDate: "2026-09-01" },
          created_at: startedAt,
        },
      ],
    });
    const body = await (await GET()).json();
    expect(body.sessions).toHaveLength(1);
    // Every one of these was absent from the response entirely: no card,
    // collapsed or open, could state a date or a rental length.
    expect(body.sessions[0].rental).toEqual({
      durationDays: 4,
      startDate: "2026-09-01",
      returnDate: "2026-09-05",
      scheduledAt: null,
    });
  });

  it("the return date is DERIVED, as the schema always said it would be", async () => {
    const { GET } = await loadDeals({
      searches: [
        {
          id: 8,
          query_text: "car",
          radius_km: 5,
          vehicle_class: "car",
          source: "google",
          results: 2,
          rfq: { durationDays: 10, startDate: "2026-12-28" },
          created_at: startedAt,
        },
      ],
    });
    const body = await (await GET()).json();
    // Across a month boundary, in UTC, so no traveller's timezone can shift it.
    expect(body.sessions[0].rental.returnDate).toBe("2027-01-07");
  });

  it("a hunt we know nothing datewise about says so with null, not with a guess", async () => {
    const { GET } = await loadDeals({
      searches: [
        {
          id: 9,
          query_text: "bike",
          radius_km: 5,
          vehicle_class: "scooter",
          source: "google",
          results: 1,
          rfq: null,
          created_at: startedAt,
        },
      ],
    });
    const body = await (await GET()).json();
    expect(body.sessions[0].rental).toBeNull();
  });
});

describe("FIX 2 - ...and the COLLAPSED card is where they render", () => {
  const page = readFileSync(join(process.cwd(), "src/app/deals/page.tsx"), "utf8");
  const header = page.slice(page.indexOf("setExpanded((e) =>"), page.indexOf("{open && ("));

  it("the dates and the length are on the header, not behind the chevron", () => {
    // Everything the owner listed for a collapsed card has to render on the
    // part of the card you can see without tapping it.
    expect(header).toContain("rentalLine(s.rental, t)");
    // ...and the hunt's own DATE, not only "3d ago", which is a duration.
    expect(header).toContain("fmtDay(s.startedAt)");
  });

  it("a date-only string is parsed at LOCAL midnight, or it renders a day early", () => {
    // `new Date("2026-03-03")` is UTC midnight - the 2nd for everyone west of
    // UTC, which is most of the audience.
    expect(page).toMatch(/\$\{iso\}T00:00:00/);
  });
});

describe("FIX 4 - Trips fails DARK, never green", () => {
  it("an unreadable database is a 503, not `sessions: []` with a 200", async () => {
    const { GET } = await loadDeals({ searches: [] }, "unavailable");
    const res = await GET();
    // The old read fell from sbSelectStrict into a narrow sbSelect, which also
    // answers [] on failure - so a Pro traveller with ten hunts was told "No
    // hunts yet - and I'm ready" during a Supabase blip. The client only sets
    // loadFailed on !r.ok, so this status IS the honest empty state.
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("unavailable");
    expect(body.sessions).toBeUndefined();
  });

  it("...but a database with no `searches` table at all is a real zero", async () => {
    // Demo mode and a fresh install land here. Painting them dark would be the
    // opposite lie.
    const { GET } = await loadDeals({ searches: [] }, { searches: { error: "missing" } });
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).sessions).toEqual([]);
  });
});

describe("FIX 3 - the re-ask route reads the window the card was counted from", () => {
  const now = Date.now();
  const oldHuntAt = now - 9 * 24 * 3600_000;
  const recentHuntAt = now - 2 * 3600_000;

  /** The busy traveller: one old hunt, then 300 newer outbound messages. */
  function tables() {
    const outbound: Row[] = [];
    for (let i = 0; i < 3; i++) {
      outbound.push({
        to_number: `6681000000${i}`,
        direction: "outbound",
        received_at: iso(oldHuntAt + i * 60_000),
        raw: { vendorId: `old-${i}`, vendorName: `Old shop ${i}`, sender: "t@example.com" },
      });
    }
    for (let i = 0; i < 300; i++) {
      outbound.push({
        to_number: `6682000${String(i).padStart(3, "0")}`,
        direction: "outbound",
        received_at: iso(recentHuntAt + i * 1000),
        raw: { vendorId: `new-${i}`, vendorName: `New shop ${i}`, sender: "t@example.com" },
      });
    }
    return {
      searches: [
        { id: 10, source: "google", created_at: iso(oldHuntAt), rfq: { durationDays: 3 } },
        { id: 20, source: "google", created_at: iso(recentHuntAt), rfq: { durationDays: 2 } },
      ],
      whatsapp_messages: outbound,
      offers: [],
      vendor_replies: [],
      negotiation_threads: [],
    };
  }

  async function loadRecheck(t: Record<string, Row[]>) {
    const db = fakeSupabase(t);
    vi.doMock("@/lib/session", () => ({
      getSession: async () => ({ email: "t@example.com", plan: "pro", role: "user" }),
    }));
    vi.doMock("@/lib/usage", () => ({ killSwitchOn: async () => false }));
    vi.doMock("@/lib/runtime-config", () => ({
      sbSelect: async (table: string, q: string) => db.select(table, q),
      sbSelectStrict: async () => ({ rows: [] }),
      sbInsert: async () => true,
      pgTimestamp: (v: string) => v,
    }));
    const mod = await import("@/app/api/deals/recheck/route");
    return { POST: mod.POST, db };
  }

  it("an older hunt's shops are FOUND, not reported as never messaged", async () => {
    const { POST, db } = await loadRecheck(tables());
    const res = await POST(
      new Request("http://x/api/deals/recheck", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ts: iso(oldHuntAt), sid: 10 }),
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // Unbounded + limit 200 + newest-first, the 200 rows the route received
    // were ALL from the recent hunt, so this was 0 and the answer was "No shops
    // were messaged in that hunt." about three shops the card had just named.
    expect(body.contacted).toBe(3);
    expect(String(body.error ?? "")).not.toMatch(/No shops were messaged/);
    // And the reason it can see them: the query itself carries the hunt window.
    const wa = db.queries.find((q) => q.table === "whatsapp_messages" && q.query.includes("direction=eq.outbound"));
    expect(wa?.query).toMatch(/received_at=gte\./);
    expect(wa?.query).toMatch(/received_at=lt\./);
  });

  it("every read that feeds the count is bounded the same way", async () => {
    const { POST, db } = await loadRecheck(tables());
    await POST(
      new Request("http://x/api/deals/recheck", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ts: iso(oldHuntAt), sid: 10 }),
      })
    );
    for (const table of ["offers", "vendor_replies"]) {
      const q = db.queries.find((x) => x.table === table);
      expect(q, `${table} was not read`).toBeTruthy();
      expect(q?.query, `${table} is read without the hunt window`).toMatch(/created_at=gte\./);
    }
  });
});
