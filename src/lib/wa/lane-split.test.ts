import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { LIMIT_DEFAULTS } from "../usage";
import { PLAN_CAPACITY } from "./capacity";
import { MASS_BARGAIN_MAX, massBargainCap } from "../mass-bargain";

vi.mock("server-only", () => ({}));

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// THE BATCH STARVED ITS OWN NEGOTIATION.
//
// There is exactly one send path, and it called checkRateLimit with no notion
// of what KIND of message was going out. The query behind it filtered
// `direction=eq.outbound` and nothing else, so cold introductions and
// negotiation replies drew from a single 15-per-hour pool.
//
// A 24-shop batch therefore consumed the entire hourly allowance at shop 15,
// and every agent reply to a shop that answered inside that hour was refused
// with "Hourly safety cap reached". That is self-defeating in the precise
// sense: a reply is the one thing that clears the unanswered-thread counter
// WhatsApp meters, so starving replies deepens the exact condition being
// punished.
//
// Task #105 - "Decouple reply velocity from the cold-intro hourly cap" - is
// recorded complete in this repo's history. It was not present in the code.

describe("the two lanes have separate budgets", () => {
  it("intro and reply limits both exist and are distinct", () => {
    expect(LIMIT_DEFAULTS.LIMIT_WA_INTRO_PER_HOUR).toBeGreaterThan(0);
    expect(LIMIT_DEFAULTS.LIMIT_WA_REPLY_PER_HOUR).toBeGreaterThan(0);
    expect(LIMIT_DEFAULTS.LIMIT_WA_INTRO_PER_DAY).toBeGreaterThan(0);
    expect(LIMIT_DEFAULTS.LIMIT_WA_REPLY_PER_DAY).toBeGreaterThan(0);
  });

  it("the reply lane is roomier - it must never be the binding constraint", () => {
    expect(LIMIT_DEFAULTS.LIMIT_WA_REPLY_PER_HOUR).toBeGreaterThan(
      LIMIT_DEFAULTS.LIMIT_WA_INTRO_PER_HOUR
    );
    expect(LIMIT_DEFAULTS.LIMIT_WA_REPLY_PER_DAY).toBeGreaterThan(
      LIMIT_DEFAULTS.LIMIT_WA_INTRO_PER_DAY
    );
  });

  it("a FULL day-one batch cannot exhaust the reply lane", () => {
    // The failure mode in one assertion: if the biggest batch we allow could
    // consume the reply allowance, the batch would again silence its own
    // answers. Every shop in a max batch may reply and be answered.
    const biggestBatch = MASS_BARGAIN_MAX;
    expect(LIMIT_DEFAULTS.LIMIT_WA_REPLY_PER_HOUR).toBeGreaterThanOrEqual(biggestBatch);
  });

  it("the daily intro ceiling stays sane - 220/day was rejected", () => {
    // ~6,600 a month against the only monthly ceiling anyone has reported
    // (~1,000) is not a ceiling, it is the absence of one.
    expect(LIMIT_DEFAULTS.LIMIT_WA_INTRO_PER_DAY).toBeLessThanOrEqual(90);
    expect(LIMIT_DEFAULTS.LIMIT_WA_INTRO_PER_DAY).toBeGreaterThanOrEqual(60);
  });
});

describe("the three capacity numbers finally agree", () => {
  it("no plan promises more introductions than the intro lane carries per hour", () => {
    // PLAN_CAPACITY said 30/40, usage.ts enforced 15, and the docstring said
    // 15. The app advertised a budget the wire refused, and a traveller watched
    // the batch stall with no surface able to explain it.
    for (const tier of ["free", "pro", "ultra"] as const) {
      expect(PLAN_CAPACITY[tier].newContacts).toBeLessThanOrEqual(
        LIMIT_DEFAULTS.LIMIT_WA_INTRO_PER_HOUR
      );
    }
  });

  it("a mass run can request the agreed day-one ceiling", () => {
    // MASS_BARGAIN_MAX = 15 meant 24 shops could not be ASKED for: the
    // constraint on day-one breadth was ours, not WhatsApp's.
    expect(MASS_BARGAIN_MAX).toBe(24);
    expect(massBargainCap("ultra")).toBe(24);
  });

  it("the cap is always the lower of the run ceiling and the plan budget", () => {
    for (const tier of ["free", "pro", "ultra"] as const) {
      expect(massBargainCap(tier)).toBe(
        Math.min(MASS_BARGAIN_MAX, PLAN_CAPACITY[tier].newContacts)
      );
    }
  });
});

describe("the lane reaches the rate limiter", () => {
  const evo = readCode("src/lib/evolution.ts");
  const guard = readCode("src/lib/wa-guard.ts");

  it("checkRateLimit takes a lane and filters the count by it", () => {
    expect(evo).toMatch(/checkRateLimit\(\s*email: string,\s*lane: SendLane/);
    expect(evo).toMatch(/LANE_FILTER\[lane\]/);
  });

  it("the two lanes select disjoint rows", () => {
    // intro = raw.kind is rfq; reply = everything that is not an intro or a
    // user-typed message. A row cannot be counted in both.
    expect(evo).toMatch(/intro: "&raw->>kind=eq\.rfq"/);
    expect(evo).toMatch(/reply: "&raw->>kind=not\.in\.\(rfq,custom,human-manual\)"/);
  });

  it("an unspecified lane defaults to INTRO - the tighter budget", () => {
    // A caller that forgets must be metered conservatively, never handed the
    // roomier reply allowance by accident.
    expect(evo).toMatch(/opts\?\.lane \?\? "intro"/);
  });

  it("the drain passes the lane it already knew", () => {
    expect(guard).toMatch(/isCold\(row\) \? "intro" : "reply"/);
  });

  it("REGRESSION: no drain call site drops the lane on the floor", () => {
    for (const route of [
      "src/app/api/wa/tick/route.ts",
      "src/app/api/wa/ping/route.ts",
      "src/app/api/wa/reply-tick/route.ts",
      "src/app/api/wa/status/route.ts",
      "src/app/api/activity/route.ts",
      "src/app/api/replies/route.ts",
    ]) {
      const code = readCode(route);
      if (!code.includes("drainOutbox(")) continue;
      expect(code, `${route} drops the lane`).toMatch(/lane\b/);
    }
  });

  it("a cap refusal is marked rateLimited so the drain cannot call it a host fault", () => {
    // Misclassified, a cap refusal was re-parked by the transient-failure
    // backoff and surfaced to the owner as Evolution being unreachable - a
    // falsehood they would chase for a day.
    expect(evo).toMatch(/rateLimited: true,\s*lane,/);
  });
});

describe("the in-memory gap is gone, and nothing loosened", () => {
  const evo = readCode("src/lib/evolution.ts");

  it("REGRESSION: MIN_GAP_MS no longer exists", () => {
    expect(evo).not.toMatch(/const MIN_GAP_MS/);
  });

  it("the in-memory counts are applied to the INTRO lane only", () => {
    // They are timestamps with no lane, so adding them to the reply lane would
    // let an intro burst eat reply headroom through the back door - the exact
    // starvation this split exists to end.
    expect(evo).toMatch(/lane === "intro" \? recent\.filter/);
  });

  it("the durable cross-instance gaps are still the authority", () => {
    expect(readCode("src/lib/wa/pacing.ts")).toMatch(/HARD_MIN_GAP_SEC = 8/);
    expect(readCode("src/lib/wa-guard.ts")).toMatch(/claimSendSlots|wa_send_claims/);
  });
});

describe("a cap refusal is not an outage", () => {
  const guard = readCode("src/lib/wa-guard.ts");
  const evo = readCode("src/lib/evolution.ts");

  it("REPRODUCTION: the old classifier had no third state", () => {
    // `transient = !recipientFail` is still there and still correct for what it
    // covers - but it used to be reached by EVERY non-recipient failure,
    // including a budget refusal. The row was then re-parked by the 45-120s
    // transient bounce with the reason "reconnecting - resumes automatically",
    // telling the owner Evolution was unreachable when it was perfectly fine.
    expect(guard).toMatch(/const transient = !recipientFail/);
    // ...and the cap is now tested BEFORE it.
    const capIdx = guard.indexOf("if (r.rateLimited)");
    const transientIdx = guard.indexOf("if (transient)");
    expect(capIdx).toBeGreaterThan(-1);
    expect(capIdx).toBeLessThan(transientIdx);
  });

  it("re-parks by the limiter's own wait, not an invented backoff", () => {
    expect(evo).toMatch(/retryAfterSeconds: rate\.waitSeconds/);
    expect(guard).toMatch(/r\.retryAfterSeconds \?\? 900/);
  });

  it("the wait is clamped to something a human would accept", () => {
    expect(guard).toMatch(/Math\.max\(60, Math\.min\(6 \* 3600/);
  });

  it("a cap refusal never burns the unreachable-host give-up budget", () => {
    // 24h at cap is normal. Counting it as transientAttempts would eventually
    // DROP the message as if the host had been dead for a day.
    const start = guard.indexOf("if (r.rateLimited)");
    // Scope to the block itself - its own `continue;` - rather than a fixed
    // character window, which overran into the transient branch below.
    const branch = guard.slice(start, guard.indexOf("continue;", start));
    expect(branch).not.toMatch(/transientAttempts/);
    expect(branch).not.toMatch(/attempts:/);
  });

  it("the reason says what actually happened", () => {
    expect(guard).toMatch(/daily message allowance reached/);
    expect(guard).not.toMatch(/rateLimited[\s\S]{0,400}reconnecting/);
  });
});

describe("the introduction budget fails CLOSED, the breaker fails OPEN", () => {
  const guard = readCode("src/lib/wa-guard.ts");

  // These two consume the same read and must fail in OPPOSITE directions,
  // which is easy to "simplify" into a single wrong behaviour later.
  //
  //   budget  - grants permission to send. Silence must DENY, or a Supabase
  //             wobble reads as "zero introductions used" and opens the whole
  //             cold budget on a personal number at the worst possible moment.
  //   breaker - halts a batch that is going unanswered. Silence must STAND
  //             DOWN, or the same wobble freezes cold outreach on no evidence.

  it("REPRODUCTION: the count no longer comes from the permissive helper", () => {
    // sbSelect collapses a 500, a timeout and a DNS blip all to [], and the
    // count was `.length` over that array.
    const fn = guard.slice(
      guard.indexOf("export async function introductionsInWindow"),
      guard.indexOf("export interface IntroBudget")
    );
    expect(fn).toMatch(/sbSelectStrict/);
    expect(fn).not.toMatch(/await sbSelect</);
  });

  it("an unavailable read spends the budget rather than granting it", () => {
    const fn = guard.slice(
      guard.indexOf("export async function introductionsInWindow"),
      guard.indexOf("export interface IntroBudget")
    );
    expect(fn).toMatch(/read\.error === "unavailable"/);
    expect(fn).toMatch(/count: Number\.POSITIVE_INFINITY/);
    expect(fn).toMatch(/unreadable: true/);
  });

  it("a MISSING table still fails open - a fresh install has genuinely sent nothing", () => {
    const fn = guard.slice(
      guard.indexOf("export async function introductionsInWindow"),
      guard.indexOf("export interface IntroBudget")
    );
    // Only "unavailable" short-circuits; "missing" falls through to rows = [].
    expect(fn).toMatch(/"rows" in read \? read\.rows : \[\]/);
  });

  it("an unreadable budget re-checks in minutes, not an hour", () => {
    // The budget is not spent - we just cannot see it - so parking the batch
    // for a full window would be its own kind of lie.
    expect(guard).toMatch(/if \(unreadable\) \{[\s\S]{0,120}3 \* 60_000/);
  });

  it("the breaker stands DOWN on the same unreadable read", () => {
    const fn = guard.slice(
      guard.indexOf("export async function coldEngagementWindow"),
      guard.indexOf("export async function coldEngagementWindow") + 2000
    );
    expect(fn).toMatch(/if \(win\.unreadable\) return null;/);
  });
});
