import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  SEARCH_SESSION_TTL_MS,
  CLAMP_GRACE_MS,
  clampSince,
  isSessionFresh,
  isRealHunt,
  parseSessionTtl,
  sessionFloorIso,
} from "./session-life";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// THE HUNT FROM LAST WEEK THAT WOULD NOT GO AWAY.
//
// The owner opened the app and was handed the search they had run SEVEN DAYS
// earlier as their live workspace - shops, offers, funnel and all - under the
// line "Picked your hunt back up - the agents never stopped." They had stopped
// days before. Clearing it did not help either: "Clear search" wiped the client
// and the queue, and the very next reload put the same hunt straight back.
//
// It was four independent gaps, and every one of them was individually
// sufficient, which is why one fix in one file would not have held:
//
//   1. /api/deals/restore selected `searches` with NO created_at floor and
//      pinned `ts=latest` to group 0 - the newest row in the table at any age.
//   2. The route never read the `session-closed` marker, so a cleared hunt was
//      as restorable as a live one.
//   3. sessionStorage's `wd_search` was read back with no age test, even though
//      the blob already carried `searchEpoch`.
//   4. The restored (ancient) epoch was then sent as `since=` to /api/activity
//      and /api/replies, overriding their own defaults and dragging a week of
//      traces, replies and offers onto the board.
//
// A fifth, quieter one fed the same symptom: /api/profile writes a `searches`
// row for every RFQ BUILD, so merely opening the request panel created the
// newest "session" - one with no snapshot, which sent the restore down its
// contacted-shops fallback, which had no window filter of its own.
//
// These tests pin the PREDICATE by executing it, and pin the four call sites by
// source, because the failure mode was never one bad function - it was four
// surfaces that each answered "is this session still live?" differently.

describe("REPRODUCTION: the freshness predicate itself", () => {
  const NOW = Date.parse("2026-08-11T12:00:00Z");

  it("a hunt from a week ago is not live - the exact case the owner hit", () => {
    const weekAgo = NOW - 7 * 24 * 3600_000;
    expect(isSessionFresh(weekAgo, NOW)).toBe(false);
  });

  it("a hunt from ten minutes ago is live", () => {
    expect(isSessionFresh(NOW - 10 * 60_000, NOW)).toBe(true);
  });

  it("the boundary is the TTL, not a round number someone remembered", () => {
    expect(isSessionFresh(NOW - SEARCH_SESSION_TTL_MS + 1_000, NOW)).toBe(true);
    expect(isSessionFresh(NOW - SEARCH_SESSION_TTL_MS - 1_000, NOW)).toBe(false);
  });

  it("FAILS CLOSED: an unknown age reads stale, never fresh", () => {
    // The whole defect is old state presented as current, so the direction of
    // the doubt is the design. A missing epoch must not open the door.
    for (const bad of [undefined, null, 0, -1, NaN, Infinity]) {
      expect(isSessionFresh(bad as number, NOW), `${String(bad)} must not be fresh`).toBe(false);
    }
  });

  it("a start in the future is clock skew, not staleness", () => {
    // The epoch is stamped from the PHONE's clock. A phone running two minutes
    // fast must not wipe the hunt it just started.
    expect(isSessionFresh(NOW + 2 * 60_000, NOW)).toBe(true);
  });
});

describe("the owner's dial, and what it refuses", () => {
  it("blank means the 3-hour default", () => {
    expect(parseSessionTtl(null)).toBe(SEARCH_SESSION_TTL_MS);
    expect(parseSessionTtl("")).toBe(SEARCH_SESSION_TTL_MS);
    expect(parseSessionTtl("   ")).toBe(SEARCH_SESSION_TTL_MS);
  });

  it("a number is hours", () => {
    expect(parseSessionTtl("6")).toBe(6 * 3600_000);
    expect(parseSessionTtl(" 2 ")).toBe(2 * 3600_000);
  });

  it("ZERO does not mean zero - an empty-ish field must not expire everything", () => {
    // A TTL of 0 would expire every session the instant it was created, which is
    // a worse bug than the one this module fixes and exactly what a fat-fingered
    // config field produces.
    expect(parseSessionTtl("0")).toBe(SEARCH_SESSION_TTL_MS);
    expect(parseSessionTtl("-5")).toBe(SEARCH_SESSION_TTL_MS);
    expect(parseSessionTtl("three hours")).toBe(SEARCH_SESSION_TTL_MS);
  });

  it("absurd values are clamped, not obeyed", () => {
    expect(parseSessionTtl("0.01")).toBe(15 * 60_000);
    expect(parseSessionTtl("9999")).toBe(24 * 3600_000);
  });
});

describe("REPRODUCTION: `since` had no floor, so the client set the window", () => {
  const NOW = Date.parse("2026-08-11T12:00:00Z");

  it("a week-old epoch cannot reach back a week", () => {
    const weekAgo = NOW - 7 * 24 * 3600_000;
    const got = clampSince(weekAgo, NOW);
    expect(got).toBeGreaterThan(weekAgo);
    expect(NOW - got).toBeLessThanOrEqual(SEARCH_SESSION_TTL_MS + CLAMP_GRACE_MS);
  });

  it("a NARROWER window is honoured exactly - the clamp only ever raises", () => {
    // A fresh search or a delta poll asks for less, and must get what it asked
    // for. A clamp that widened would resurrect the very rows this removes.
    const recent = NOW - 5 * 60_000;
    expect(clampSince(recent, NOW)).toBe(recent);
  });

  it("the grace is real, so a live session's own start is never shaved", () => {
    // The epoch crosses a device clock and a measured skew correction. A hard
    // floor at exactly now-TTL would trim the first replies of a hunt sitting a
    // hair outside it - a far more expensive symptom than 30 extra minutes.
    const atTtl = NOW - SEARCH_SESSION_TTL_MS;
    expect(clampSince(atTtl, NOW)).toBe(atTtl);
  });

  it("garbage resolves to the floor, never to zero", () => {
    // `Number(null)` is 0, and 0 meant "no lower bound at all" - which is how a
    // caller could ask for the entire table.
    for (const bad of [0, -1, NaN, null, undefined]) {
      expect(clampSince(bad as number, NOW)).toBe(
        NOW - SEARCH_SESSION_TTL_MS - CLAMP_GRACE_MS
      );
    }
  });

  it("sessionFloorIso is a Postgres-comparable string", () => {
    expect(sessionFloorIso(NOW)).toBe(new Date(NOW - SEARCH_SESSION_TTL_MS).toISOString());
  });
});

describe("all four surfaces ask the same question", () => {
  it("1. the restore route refuses a stale `ts=latest`", () => {
    const route = readCode("src/app/api/deals/restore/route.ts");
    expect(route).toMatch(/if \(wantLatest\) \{/);
    expect(route).toMatch(/isSessionFresh\(Date\.parse\(groups\[0\]\[0\]\.created_at\)/);
    expect(route).toMatch(/"no-live-hunt"/);
  });

  it("...but an explicit timestamp from Trips still opens any hunt, at any age", () => {
    // This is the whole difference between history and the live board. Gating
    // the explicit path too would have deleted a paid feature to fix a bug.
    const route = readCode("src/app/api/deals/restore/route.ts");
    const freshGate = route.indexOf("if (wantLatest) {");
    expect(freshGate).toBeGreaterThan(0);
    // The gate is inside `if (wantLatest)`, so nothing about it can reach the
    // `ts=<timestamp>` path.
    expect(route).not.toMatch(/isSessionFresh\([^)]*\);\s*\n\s*\}\s*\n\s*const gi/);
  });

  it("2. a cleared hunt is refused at any age", () => {
    const route = readCode("src/app/api/deals/restore/route.ts");
    expect(route).toMatch(/kind=eq\.session-closed/);
    expect(route).toMatch(/"session-closed"/);
  });

  it("...and the marker is bounded by the group, or clearing breaks the next search", () => {
    // Search, clear, search again inside 30 minutes puts BOTH searches in ONE
    // group. Comparing the marker against the group's FIRST row would then
    // refuse the traveller's brand-new hunt.
    const route = readCode("src/app/api/deals/restore/route.ts");
    expect(route).toMatch(/const groupEndIso = group\[group\.length - 1\]\.created_at;/);
    expect(route).toMatch(/received_at=gt\.\$\{encodeURIComponent\(groupEndIso\)\}/);
  });

  it("3. the client rehydrate tests the stored epoch", () => {
    const page = readCode("src/app/page.tsx");
    expect(page).toMatch(/isSessionFresh\(s\?\.searchEpoch, Date\.now\(\), SEARCH_SESSION_TTL_MS\)/);
    expect(page).toMatch(/sessionStorage\.removeItem\("wd_search"\)/);
  });

  it("...and the auto-restore will not apply a stale payload either", () => {
    const page = readCode("src/app/page.tsx");
    expect(page).toMatch(/isSessionFresh\(p\.searchEpoch, Date\.now\(\), SEARCH_SESSION_TTL_MS\)/);
  });

  it("4. both polling routes clamp the caller's window", () => {
    for (const p of ["src/app/api/activity/route.ts", "src/app/api/replies/route.ts"]) {
      const code = readCode(p);
      expect(code, `${p} does not clamp since`).toMatch(/clampSince\(/);
      expect(code, `${p} does not read the TTL`).toMatch(/searchSessionTtlMs\(\)/);
    }
  });
});

describe("a request BUILD is not a hunt", () => {
  it("the discriminator itself knows a hunt from a request build", () => {
    expect(isRealHunt("google")).toBe(true);
    expect(isRealHunt("demo")).toBe(true);
    expect(isRealHunt("panel")).toBe(false);
    expect(isRealHunt("profiler")).toBe(false);
    // A legacy row written before `source` existed is a hunt, not a build - the
    // build paths have always stamped one, so null can only be an old search.
    expect(isRealHunt(null)).toBe(true);
    expect(isRealHunt(undefined)).toBe(true);
  });

  it("and ALL FOUR consumers share it, so it cannot drift apart again", () => {
    // It started as two inline copies in two routes. Then the warm-up gate
    // turned out to need the same answer to decide whether anyone may pay us,
    // and the funnel needed it to report a stage people had actually reached.
    // Four copies of a rule is how a rule stops being one rule.
    for (const p of [
      "src/app/api/deals/restore/route.ts",
      "src/app/api/deals/route.ts",
      "src/lib/warmup.ts",
      "src/lib/lifecycle.ts",
    ]) {
      const code = readCode(p);
      expect(code, `${p} does not use the shared discriminator`).toMatch(/isRealHunt\(/);
      expect(code, `${p} still carries its own copy`).not.toMatch(/new Set\(\["panel", "profiler"\]\)/);
    }
  });

  it("...and those rows really are written on a bare RFQ build", () => {
    // If this ever stops being true the filter above becomes dead weight, so it
    // is pinned rather than assumed.
    const profile = readCode("src/app/api/profile/route.ts");
    expect(profile).toMatch(/source: "panel"/);
    expect(profile).toMatch(/source: "profiler"/);
  });

  it("the contacted-shops fallback is window-bounded too", () => {
    // The second, independent path to the same symptom: with no snapshot the
    // route rebuilt the hunt from the last 120 outbound messages of ALL TIME.
    const route = readCode("src/app/api/deals/restore/route.ts");
    expect(route).toMatch(/if \(!inWindow\(m\.received_at\)\) continue;/);
  });
});
