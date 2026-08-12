import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { partitionHunts, huntIsActive, UNKNOWN_RENTAL_MS, type HuntStamp } from "./trips";
import { SEARCH_SESSION_TTL_MS } from "./session-life";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// TRIPS RENDERED ONE CARD SHAPE FOR EVERYTHING (W-2b).
//
// A hunt with shops answering right now and a hunt that died three weeks ago
// got the same 480-line dashboard, the same expand chevron, the same "what
// happens next" panel. The screen therefore grew linearly with use, and the one
// thing a traveller opens Trips for - what is happening with my rental - sank
// further down the page every week.
//
// The split asks exactly one question per hunt: CAN ANYTHING STILL CHANGE HERE?

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const now = 1_700_000_000_000;

const hunt = (over: Partial<HuntStamp> = {}): HuntStamp => ({
  startedAt: new Date(now - HOUR).toISOString(),
  status: "waiting",
  ...over,
});

const isActive = (h: HuntStamp) => huntIsActive(h, now, SEARCH_SESSION_TTL_MS);

describe("a hunt is active while something can still change", () => {
  it("a fresh hunt still waiting on shops is live work", () => {
    expect(isActive(hunt({ status: "waiting" }))).toBe(true);
    expect(isActive(hunt({ status: "live" }))).toBe(true);
  });

  it("...but only inside the session window", () => {
    // Past the TTL the agents have stopped. This is the same boundary
    // session-life.ts draws, and drawing a different one here is how a week-old
    // board came back as the live workspace in the first place.
    const old = hunt({ startedAt: new Date(now - SEARCH_SESSION_TTL_MS - 1).toISOString() });
    expect(isActive(old)).toBe(false);
  });

  it("a wrapped hunt is history the moment it wraps", () => {
    expect(isActive(hunt({ status: "wrapped" }))).toBe(false);
  });

  it("an unparseable timestamp is filed as history, never promoted to live", () => {
    // The fail direction matters: a broken stamp claiming the agents are still
    // working is the fail-green read this repo keeps paying for, in the UI.
    expect(isActive(hunt({ startedAt: "not a date" }))).toBe(false);
    expect(isActive(hunt({ startedAt: "" }))).toBe(false);
  });
});

describe("a booked rental is current until it is actually over", () => {
  it("an upcoming pick-up outranks the hunt's age completely", () => {
    // The search finished a week ago BECAUSE it succeeded. Filing tomorrow's
    // rental under 'earlier hunts' hides the single most useful card on the
    // screen behind a collapsed disclosure.
    const booked = hunt({
      status: "booked",
      startedAt: new Date(now - 7 * DAY).toISOString(),
      scheduledAt: new Date(now + DAY).toISOString(),
    });
    expect(isActive(booked)).toBe(true);
  });

  it("a rental being ridden right now is still active", () => {
    const riding = hunt({
      status: "booked",
      startedAt: new Date(now - 10 * DAY).toISOString(),
      scheduledAt: new Date(now - 2 * DAY).toISOString(),
      durationDays: 5,
    });
    expect(isActive(riding)).toBe(true);
  });

  it("...and drops to history once the rental has run its length", () => {
    const finished = hunt({
      status: "booked",
      startedAt: new Date(now - 20 * DAY).toISOString(),
      scheduledAt: new Date(now - 6 * DAY).toISOString(),
      durationDays: 5,
    });
    expect(isActive(finished)).toBe(false);
  });

  it("an unknown length gets ONE day, not an open-ended pass", () => {
    // Claiming a rental is still running when it may have ended yesterday is
    // the same class of lie as showing a week-old hunt as live, just quieter.
    const justInside = hunt({
      status: "booked",
      startedAt: new Date(now - 9 * DAY).toISOString(),
      scheduledAt: new Date(now - UNKNOWN_RENTAL_MS + HOUR).toISOString(),
    });
    const justOutside = hunt({
      status: "booked",
      startedAt: new Date(now - 9 * DAY).toISOString(),
      scheduledAt: new Date(now - UNKNOWN_RENTAL_MS - HOUR).toISOString(),
    });
    expect(isActive(justInside)).toBe(true);
    expect(isActive(justOutside)).toBe(false);
  });

  it("a deal just locked with no agreed pick-up is still current", () => {
    // "Pick-up time agreed in chat" is a real and common state. Archiving a
    // booking made twenty minutes ago because we do not know the hour would
    // hide the exact card the traveller opened the screen to see.
    const fresh = hunt({
      status: "booked",
      startedAt: new Date(now - 20 * 60_000).toISOString(),
      scheduledAt: null,
    });
    expect(isActive(fresh)).toBe(true);
  });

  it("a booking with NO agreed pick-up does not sit at the top forever", () => {
    // "Pick-up time agreed in chat" is a real and common state. With no time to
    // check against, the hunt ages out like any other rather than pinning
    // itself to the live section permanently.
    const noPickup = hunt({
      status: "booked",
      startedAt: new Date(now - 9 * DAY).toISOString(),
      scheduledAt: null,
    });
    expect(isActive(noPickup)).toBe(false);
  });
});

describe("the partition keeps every hunt, in the order it was given", () => {
  it("nothing is dropped and nothing is duplicated", () => {
    const rows = [
      { ...hunt({ status: "live" }), id: "a" },
      { ...hunt({ status: "wrapped" }), id: "b" },
      { ...hunt({ status: "waiting" }), id: "c" },
      { ...hunt({ startedAt: new Date(now - 30 * DAY).toISOString() }), id: "d" },
    ];
    const { active, archive } = partitionHunts(rows, now, SEARCH_SESSION_TTL_MS);
    expect([...active, ...archive].map((r) => r.id).sort()).toEqual(["a", "b", "c", "d"]);
    expect(active.map((r) => r.id)).toEqual(["a", "c"]);
    expect(archive.map((r) => r.id)).toEqual(["b", "d"]);
  });

  it("the caller's order survives inside each half", () => {
    // The split RE-GROUPS, it never re-sorts. The server already ordered these
    // newest-first and a second ordering opinion here would fight it.
    const rows = ["x", "y", "z"].map((id) => ({ ...hunt({ status: "wrapped" }), id }));
    expect(partitionHunts(rows, now, SEARCH_SESSION_TTL_MS).archive.map((r) => r.id)).toEqual([
      "x",
      "y",
      "z",
    ]);
  });

  it("an empty list splits into two empty lists, not into undefined", () => {
    const { active, archive } = partitionHunts([], now, SEARCH_SESSION_TTL_MS);
    expect(active).toEqual([]);
    expect(archive).toEqual([]);
  });
});

describe("Trips actually renders the split", () => {
  const page = readCode("src/app/deals/page.tsx");

  it("the live half is rendered unconditionally, the archive behind a toggle", () => {
    expect(page).toMatch(/\{active\.map\(renderSession\)\}/);
    expect(page).toMatch(/archiveOpen &&[\s\S]{0,120}archive\.map\(renderSession\)/);
  });

  it("history starts COLLAPSED, or the split changes nothing", () => {
    expect(page).toMatch(/\[archiveOpen, setArchiveOpen\] = useState\(false\)/);
    expect(page).toMatch(/setArchiveOpen\(\(o\) => !o\)/);
  });

  it("both halves render the SAME card", () => {
    // Two card components is two places for the truth to drift. One renderer,
    // used twice.
    expect(page.match(/renderSession/g)?.length).toBeGreaterThanOrEqual(3);
    expect(page).toMatch(/const renderSession = \(s: HuntRow\) =>/);
  });

  it("the split uses the shared session TTL, not a local number", () => {
    expect(page).toMatch(/partitionHunts\(rows, Date\.now\(\), SEARCH_SESSION_TTL_MS\)/);
  });

  it("the pick-up and length are lifted out of the booking", () => {
    // huntIsActive reads them at the top level; without this lift every booked
    // rental would be judged on the hunt's age alone.
    expect(page).toMatch(/scheduledAt: s\.booking\?\.scheduledAt \?\? null/);
    expect(page).toMatch(/durationDays: s\.booking\?\.durationDays \?\? null/);
  });
});

describe("the savings figure can finally be totalled", () => {
  const route = readCode("src/app/api/deals/route.ts");

  it("a duration reaches toTrip, or every saving stays null", () => {
    // `savingOf` returns null for the whole-rental saving when it does not know
    // the length - correct, but nothing was passing a length, so the headline
    // was permanently blank after the per-day/total fix.
    expect(route).toMatch(/durationDays: bookedDays/);
  });

  it("it is derived from the two numbers already selected, not a new column", () => {
    // Adding duration_days to the bookings select would 400 for anyone who has
    // not run the migration and take EVERY booking down with it - the read is
    // wrapped in .catch(() => []).
    expect(route).toMatch(/Number\(booking\.total_price\) \/ Number\(booking\.price_per_day\)/);
    expect(route).not.toMatch(/select=id,vendor_name,price_per_day,total_price,currency,fulfillment,scheduled_at,status,duration_days/);
  });

  it("a zero or missing per-day rate cannot produce a division blow-up", () => {
    expect(route).toMatch(/Number\(booking\.price_per_day\) > 0/);
  });
});
