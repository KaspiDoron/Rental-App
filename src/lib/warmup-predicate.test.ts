import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

// THE PAYWALL WAS CLOSED AGAINST EVERY SINGLE USER, AND THE SUITE WAS GREEN.
//
// `searchCount` read `search_sessions`. That table is declared in schema.sql -
// with `status` and `closed_at` columns, as though it were the lifecycle record
// it was designed to be - and has exactly two references in the whole
// repository, this one and `lifecycleReport()`. Both are READS. Nothing has ever
// inserted a row.
//
// Because the table EXISTS, `sbSelectStrict` answered `{rows: []}` rather than
// `{error: "missing"}`. So the read reported a confident `n: 0` with
// `unreadable: false` - the one shape the module's deliberate fail-WARM rule
// cannot rescue, because it is not a failure, it is an answer. The predicate
// `completedSearches >= 1` was therefore permanently false:
//
//   - /api/billing/checkout 403'd every non-tester, forever
//   - UpgradeSheet rendered the locked state permanently
//   - a traveller with ten searches and five replies still saw "Searches run 0/1"
//   - the funnel's whole `searchers` stage reported zero for every cohort
//
// The product could not take money, and the symptom was indistinguishable from
// weak conversion.
//
// WHY THE EXISTING TESTS DID NOT CATCH IT: `warmup.test.ts` exercises
// `warmupProgressLine` (pure, given a status object) and pins source strings. It
// never RUNS the predicate, so the table name underneath it was never a fact any
// test depended on. These tests execute `warmupStatus` against a stubbed
// database - the only shape that can tell a real user from a locked door.

interface Row {
  [k: string]: unknown;
}
/** table -> rows, matched loosely by the table name in the query. */
let db: Record<string, Row[]> = {};
/** Tables to answer as a hard outage rather than as empty. */
let unavailable = new Set<string>();
/** Every table this run actually read - the assertion that catches a dead table. */
let touched: string[] = [];

vi.mock("./runtime-config", () => ({
  getConfig: async () => undefined,
  sbUpdate: async () => true,
  sbSelectStrict: async (table: string) => {
    touched.push(table);
    if (unavailable.has(table)) return { error: "unavailable" as const };
    if (!(table in db)) return { error: "missing" as const };
    return { rows: db[table] };
  },
}));
vi.mock("./allowlist", () => ({ isTestUser: async () => false }));
vi.mock("./cohort", () => ({ inWarmupHoldout: async () => false }));

const EMAIL = "traveller@example.com";

/** A traveller who has genuinely earned Premium. */
function seedEarnedIt() {
  db = {
    app_users: [{ warmed_up_at: null }],
    // One REAL hunt (source `google`), plus a request build that must not count.
    searches: [
      { id: 1, source: "google" },
      { id: 2, source: "panel" },
      { id: 3, source: "profiler" },
    ],
    wa_sessions: [{ status: "open" }],
    wa_recipient_state: [
      { to_tail: "111111111", to_number: "+66111111111", first_reply_at: "2026-08-01T10:00:00Z" },
      { to_tail: "222222222", to_number: "+66222222222", first_reply_at: null },
      { to_tail: "333333333", to_number: "+66333333333", first_reply_at: null },
    ],
  };
}

beforeEach(() => {
  vi.resetModules();
  db = {};
  unavailable = new Set();
  touched = [];
});

describe("REPRODUCTION: a traveller who earned Premium can actually buy it", () => {
  it("one real search, three shops reached, one reply, WhatsApp linked -> WARM", async () => {
    seedEarnedIt();
    const { warmupStatus } = await import("./warmup");
    const s = await warmupStatus(EMAIL);
    expect(
      s.warmed,
      `still locked. terms: ${s.terms.map((t) => `${t.id} ${t.have}/${t.need}`).join(", ")}`
    ).toBe(true);
    expect(s.remaining).toBe(0);
    expect(s.exempt).toBe(false);
    expect(s.holdout).toBe(false);
  });

  it("the searches term counts the hunt and IGNORES the request builds", async () => {
    seedEarnedIt();
    const { warmupStatus } = await import("./warmup");
    const s = await warmupStatus(EMAIL);
    const searches = s.terms.find((t) => t.id === "searches");
    // Three rows, one hunt. Counting all three would let someone unlock Premium
    // by opening the request panel twice without ever running a search.
    expect(searches?.have).toBe(1);
    expect(searches?.done).toBe(true);
  });

  it("REGRESSION: the predicate reads a table that is WRITTEN", async () => {
    // The defect in one assertion. `search_sessions` has no writer anywhere in
    // src/, services/, apps/ or packages/ - reading it can only ever answer
    // zero, and zero here means nobody may pay us.
    seedEarnedIt();
    const { warmupStatus } = await import("./warmup");
    await warmupStatus(EMAIL);
    expect(touched).toContain("searches");
    expect(
      touched,
      "warmupStatus read search_sessions, which nothing in this repo writes"
    ).not.toContain("search_sessions");
  });
});

describe("the gate still gates - it did not simply come off", () => {
  it("no searches -> locked, and the open term names itself", async () => {
    seedEarnedIt();
    db.searches = [{ id: 2, source: "panel" }];
    const { warmupStatus } = await import("./warmup");
    const s = await warmupStatus(EMAIL);
    expect(s.warmed).toBe(false);
    expect(s.terms.find((t) => t.id === "searches")?.done).toBe(false);
  });

  it("shops reached but none replied -> locked", async () => {
    // A number nobody has ever answered is not a warmed-up number; it is a
    // number accumulating exactly the signal that gets accounts restricted.
    seedEarnedIt();
    db.wa_recipient_state = (db.wa_recipient_state as Row[]).map((r) => ({
      ...r,
      first_reply_at: null,
    }));
    const { warmupStatus } = await import("./warmup");
    const s = await warmupStatus(EMAIL);
    expect(s.warmed).toBe(false);
    expect(s.terms.find((t) => t.id === "replies")?.done).toBe(false);
  });

  it("WhatsApp never linked -> locked, with the clock visibly not started", async () => {
    seedEarnedIt();
    db.wa_sessions = [{ status: "close" }];
    const { warmupStatus } = await import("./warmup");
    const s = await warmupStatus(EMAIL);
    expect(s.warmed).toBe(false);
    expect(s.terms.find((t) => t.id === "linked")?.done).toBe(false);
  });

  it("one shop reached is not three - the engaged threshold is real", async () => {
    seedEarnedIt();
    db.wa_recipient_state = [
      { to_tail: "111111111", to_number: "+66111111111", first_reply_at: "2026-08-01T10:00:00Z" },
    ];
    const { warmupStatus } = await import("./warmup");
    const s = await warmupStatus(EMAIL);
    expect(s.warmed).toBe(false);
    expect(s.terms.find((t) => t.id === "engaged")?.have).toBe(1);
  });
});

describe("the deliberate fail direction: unreadable admits, it does not refuse", () => {
  it("an unreadable database WARMS the user and says so", async () => {
    // Everywhere else here an unreadable read DENIES, because what is guarded is
    // someone's phone number. This gate guards our own revenue quality, and the
    // costs run the other way: refusing a sale to someone who earned it - on
    // the single afternoon they will ever use this app - is worse than admitting
    // one buyer we were not certain about.
    seedEarnedIt();
    unavailable = new Set(["searches", "wa_recipient_state", "wa_sessions"]);
    const { warmupStatus } = await import("./warmup");
    const s = await warmupStatus(EMAIL);
    expect(s.warmed).toBe(true);
    expect(s.unreadable).toBe(true);
  });

  it("...but a MISSING table is genuinely zero, not unknown", async () => {
    // A fresh install has no rows. That is an answer, and it must lock - which
    // is exactly why the search_sessions defect was invisible: an existing but
    // never-written table answers "zero" with total confidence.
    db = { app_users: [{ warmed_up_at: null }] };
    const { warmupStatus } = await import("./warmup");
    const s = await warmupStatus(EMAIL);
    expect(s.warmed).toBe(false);
    expect(s.unreadable).toBe(false);
  });
});

describe("the stamp is write-once", () => {
  it("an already-stamped user is warm without re-running the predicate", async () => {
    db = { app_users: [{ warmed_up_at: "2026-08-01T09:00:00Z" }] };
    const { warmupStatus } = await import("./warmup");
    const s = await warmupStatus(EMAIL);
    expect(s.warmed).toBe(true);
    expect(s.warmedAt).toBe(Date.parse("2026-08-01T09:00:00Z"));
    // A later threshold change must not un-warm somebody who already crossed.
    expect(touched).not.toContain("wa_recipient_state");
  });
});
