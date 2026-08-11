import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const readRaw = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const route = stripComments(readRaw("src/app/api/admin/ops/analytics/route.ts"));
const panel = stripComments(readRaw("src/components/ops/AnalyticsPanel.tsx"));

// M21: REAL METRICS ONLY.
//
// The module's rule is "anything without a writer gets a writer or gets
// removed". The writers were checked and are real - agent_traces from
// orchestrator.ts, agent_scores from graph/judge.ts, agent_reviews from
// ops/detect.ts - so the defect was on the READ side, and it is the fail-green
// shape this repo has now shipped three times: the Command Center's nine
// `.catch(() => [])`, the banner reading "Messaging: All good" over a dead
// webhook, and classifySafety answering from positive evidence only.
//
// An unreachable Supabase rendered a COMPLETE analytics page: zero branch uses,
// zero owner reviews, zero judge scores, no regression detected. Every one of
// those is indistinguishable from a quiet week, and "no regression detected" is
// exactly the tile an owner acts on.

describe("a failed read is dark, never zero", () => {
  it("no read catches into an empty array any more", () => {
    expect(route).not.toMatch(/\.catch\(\(\) => \[\]\)/);
  });

  it("all three reads use the reader that can actually answer 'unknown'", () => {
    // THIS ASSERTION USED TO COUNT `.catch(() => null)` AND IT PASSED WHILE THE
    // FIX DID NOTHING. `sbSelect` has no rejection path, so those catches were
    // unreachable, `null` never happened, `degraded` was permanently empty, and
    // the panel went on rendering a confident zero over a dead database.
    //
    // Counting a catch proves a line exists. It cannot prove the line runs. The
    // reader is now `sbSelectDark`, whose `T[] | null` return type makes the
    // unknown case reachable by construction - and fail-dark.test.ts executes it
    // against a stubbed outage rather than reading the source.
    expect((route.match(/sbSelectDark</g) ?? []).length).toBe(3);
    expect(route).not.toMatch(/\.catch\(\(\) => null\)/);
  });

  it("the aggregation still runs on an empty array, so nothing below changed", () => {
    // The fix must not fork the aggregation code - that is how one branch
    // starts answering differently from the other.
    expect(route).toMatch(/const traces = tracesRead \?\? \[\]/);
    expect(route).toMatch(/const scores = scoresRead \?\? \[\]/);
    expect(route).toMatch(/const reviews = reviewsRead \?\? \[\]/);
  });

  it("the totals carry null for unread, not 0", () => {
    expect(route).toMatch(/decisionsTraced: tracesRead === null \? null : traces\.length/);
    expect(route).toMatch(/judgeScores: scoresRead === null \? null : scores\.length/);
    expect(route).toMatch(/ownerReviews: reviewsRead === null \? null : reviews\.length/);
  });

  it("the response names WHICH inputs were unreadable", () => {
    // A single "degraded: true" would tell the owner something is wrong and
    // not which figures to distrust.
    expect(route).toMatch(/tracesRead === null \? "decision traces" : null/);
    expect(route).toMatch(/scoresRead === null \? "judge scores" : null/);
    expect(route).toMatch(/reviewsRead === null \? "owner reviews" : null/);
    expect(route).toMatch(/\n    degraded,\n/);
  });
});

describe("the panel says so before it shows a number", () => {
  it("the dark strip renders ahead of the regression banner and the tiles", () => {
    const strip = panel.indexOf("degraded.length > 0");
    const regression = panel.indexOf("{data.regression && (");
    const tiles = panel.indexOf('["Decisions"');
    expect(strip).toBeGreaterThan(-1);
    expect(strip).toBeLessThan(regression);
    expect(strip).toBeLessThan(tiles);
  });

  it("it lists the unreadable inputs rather than a bare warning", () => {
    expect(panel).toMatch(/\{degraded\.join\(", "\)\}/);
  });

  it("it says missing, NOT zero", () => {
    expect(panel).toMatch(/missing, not zero/);
  });

  it("a null total renders as a dash", () => {
    expect(panel).toMatch(/v === null \? <span className="text-faint"/);
  });

  it("the totals type admits null, so the compiler enforces the dash", () => {
    expect(panel).toMatch(/decisionsTraced: number \| null;/);
    expect(panel).toMatch(/judgeScores: number \| null;/);
    expect(panel).toMatch(/ownerReviews: number \| null;/);
  });

  it("degraded is optional, so an older cached response does not crash the panel", () => {
    expect(panel).toMatch(/degraded\?: string\[\];/);
    expect(panel).toMatch(/const degraded = data\.degraded \?\? \[\]/);
  });
});

describe("every KPI on this page has a real writer", () => {
  // M21's actual mandate. Checked once here so a future metric added to the
  // route without a writer fails the suite rather than rendering a confident
  // zero forever.
  const orchestrator = stripComments(readRaw("src/lib/orchestrator.ts"));
  const judge = stripComments(readRaw("src/lib/graph/judge.ts"));
  const detect = stripComments(readRaw("src/lib/ops/detect.ts"));

  it("agent_traces is written by the orchestrator", () => {
    expect(orchestrator).toMatch(/sbInsert\("agent_traces"/);
  });

  it("agent_scores is written by the judge", () => {
    expect(judge).toMatch(/sbInsert\("agent_scores"/);
  });

  it("agent_reviews is written by the ops detector", () => {
    expect(detect).toMatch(/sbInsert\("agent_reviews"/);
  });

  it("the route reads exactly those three tables and no fourth", () => {
    const tables = Array.from(route.matchAll(/sbSelectDark<\w+>\(\s*"(\w+)"/g)).map((m) => m[1]);
    expect(new Set(tables)).toEqual(new Set(["agent_traces", "agent_scores", "agent_reviews"]));
  });
});
