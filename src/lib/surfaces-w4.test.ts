import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// OWNER REPORT 4, WAVE 4 - closing the loops Waves 1-3 opened. Three of these
// were half-built by me: a KPI route with no card, a durable contact fact with
// no surface, and an ops document that described a system that no longer
// existed. A fact nobody can see is not shipped.

describe("W4.1 - the launch KPI card exists and is mounted", () => {
  const card = readCode("src/components/ops/LaunchKpiCard.tsx");

  it("reads the route and renders through the fail-dark primitives", () => {
    expect(card).toMatch(/fetch\("\/api\/admin\/ops\/launch-kpis"/);
    // Dash-not-zero, and the degraded strip ABOVE the figures.
    expect(card).toMatch(/DegradedBanner/);
    expect(card).toMatch(/StatTile/);
    // An unreadable read must not read as a green light.
    expect(card).toMatch(/not a green light/);
  });

  it("is mounted in the Ops center, on the dashboard view only", () => {
    const ops = readCode("src/components/ops/OpsCenter.tsx");
    expect(ops).toMatch(/import \{ LaunchKpiCard \}/);
    expect(ops).toMatch(/<LaunchKpiCard \/>/);
    // Placed in the else-branch (the dashboard), not above the conversation
    // reader - reading one thread is a different job from fleet readiness.
    const conv = ops.indexOf("<ConversationPanel");
    const kpi = ops.indexOf("<LaunchKpiCard />");
    expect(conv).toBeGreaterThan(0);
    expect(kpi).toBeGreaterThan(conv);
  });

  it("the cluster warning is the one alarm state the card raises", () => {
    expect(card).toMatch(/clusterWarning/);
    expect(card).toMatch(/cluster-ban risk/);
  });

  it("counts come from the COUNT header, not a 100k-row fetch", () => {
    // Selecting 100k rows to take .length is correct and absurd on tables that
    // grow by design; sbCountDark keeps the fail-dark contract AND one row.
    const kpis = readCode("src/lib/ops/launch-kpis.ts");
    expect(kpis).toMatch(/sbCountDark/);
    expect(kpis).not.toMatch(/limit=100000/);
  });
});

describe("W4.2 - a shared contact is visible, and only a suggestion", () => {
  const route = readCode("src/app/api/activity/route.ts");
  const feed = readCode("src/components/activity/ActivityFeed.tsx");

  it("the activity feed reads the durable contact-suggested fact", () => {
    expect(route).toMatch(/"contact-suggested"/);
    expect(route).toMatch(/kind: "contact"/);
  });

  it("a card with no number is nothing to act on and is skipped", () => {
    expect(route).toMatch(/if \(!shared\.digits\) continue/);
  });

  it("the feed item offers a COPY, never an auto-thread", () => {
    expect(feed).toMatch(/t\("Copy number"\)/);
    expect(feed).toMatch(/clipboard/);
    // The one thing it must never do: message a shop the traveller never chose.
    expect(route).toMatch(/nothing was sent to them/);
    expect(feed).not.toMatch(/contact[\s\S]{0,400}sendFromUser/);
  });

  it("both ends of the wire agree on the kind union", () => {
    // The route's ActivityItem and the component's FeedItem are one contract.
    expect(route).toMatch(/\| "contact"/);
    expect(feed).toMatch(/\| "contact"/);
    // Exhaustive Record: a kind without an icon is a compile error, so this
    // pin only guards the pairing being deliberate.
    expect(feed).toMatch(/contact: "chat"/);
  });
});

describe("W4.3 - the plan card no longer speaks English on a translated page", () => {
  const sheet = readCode("src/components/UpgradeSheet.tsx");

  it("PlanCard translates its chrome", () => {
    for (const s of ["Popular", "Free", "every 3 months", "Unlocks as you use the app"]) {
      expect(sheet).toContain(`t("${s}")`);
    }
  });

  it("the strings reached the generated catalogue (or t() is a no-op)", () => {
    const catalog = read("src/lib/i18n-catalog.ts");
    // t() refuses anything outside the catalogue, so an unwrapped-but-
    // ungenerated string would render English forever and look "done".
    for (const s of ["Popular", "every 3 months", "Copy number"]) {
      expect(catalog).toContain(`"${s}"`);
    }
  });
});

describe("W4.4 - the ops document tells the truth about the live system", () => {
  const doc = read("PRODUCTION-READINESS.md");

  it("names what owner report 4 changed, since CLAUDE.md sends readers here first", () => {
    expect(doc).toMatch(/What owner report 4 changed/);
    expect(doc).toMatch(/READ THIS FIRST IF YOU ARE ABOUT TO CHANGE/);
  });

  it("the drain-trigger list includes the armer and the reply dispatcher", () => {
    expect(doc).toMatch(/drain-armer/);
    expect(doc).toMatch(/reply-tick/);
    expect(doc).toMatch(/Cloud Scheduler/);
  });

  it("the shipped P2 items are marked shipped, with the Redis caveat intact", () => {
    expect(doc).toMatch(/SHIPPED as `supabase\/retention\.sql`/);
    expect(doc).toMatch(/BOUNDED, not offloaded/);
    // The caveat must NOT be quietly deleted - setting the secret is the fix.
    expect(doc).toMatch(/with no `REDIS_URL` this is a no-op/);
  });

  it("the sync-retry hold is described lane-proportionally, as shipped", () => {
    expect(doc).toMatch(/LANE-PROPORTIONAL/);
    expect(doc).not.toMatch(/`sync-retry`, 5-10\s*\n?\s*min/);
  });

  it("carries the live-verification checklist and the deliberate scope notes", () => {
    expect(doc).toMatch(/Live verification after a deploy/);
    expect(doc).toMatch(/Deliberate scope notes/);
    expect(doc).toMatch(/The public marketing surface stays English/);
  });
});
