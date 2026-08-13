import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

// THE MANAGEMENT WORKSPACE AUDIT (owner report 3, 3.5).
//
// The fail-dark contract, the count-vs-slice discipline and the
// explain-every-KPI rule were each retrofitted onto ONE surface and never
// propagated - and the Command tab could go permanently skeletal on a single
// failed fetch (the owner's screenshot). These tests run the KPI route for
// real under a mocked outage, and pin the workspace shape that the audit
// established.

/** Load /api/admin/command with its collaborators stubbed. */
async function loadCommandRoute(opts: { dark: boolean }) {
  vi.resetModules();
  vi.doMock("@/lib/session", () => ({
    requireManagement: async () => ({ email: "owner@example.com", role: "owner" }),
  }));
  vi.doMock("@/lib/runtime-config", () => ({
    sbSelectDark: async () => (opts.dark ? null : []),
    sbCountDark: async () => (opts.dark ? null : 7),
  }));
  const mod = await import("./admin/command/route");
  return mod.GET;
}

describe("GET /api/admin/command - executed under an outage, not pinned", () => {
  it("a total outage answers null stats + a named degraded list + a critical alert", async () => {
    const GET = await loadCommandRoute({ dark: true });
    const res = await GET();
    const j = await res.json();
    // Every tile is UNKNOWN, not zero.
    for (const k of ["waSessions", "repliesToday", "offersToday", "queuedMessages", "openIssues"]) {
      expect(j.stats[k]).toBeNull();
    }
    expect(j.degraded.length).toBeGreaterThan(0);
    expect(j.alerts[0].level).toBe("critical");
    expect(j.alerts[0].title).toContain("unreadable");
  });

  it("a healthy read answers EXACT counts (sbCountDark), not slice lengths", async () => {
    const GET = await loadCommandRoute({ dark: false });
    const res = await GET();
    const j = await res.json();
    // The mock count is 7 while every row slice is [] - if any stat were still
    // derived from a slice's .length it would read 0 here.
    for (const k of ["waSessions", "repliesToday", "offersToday", "queuedMessages", "openIssues"]) {
      expect(j.stats[k]).toBe(7);
    }
    expect(j.degraded).toEqual([]);
  });
});

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("KPI discipline - counts are exact and fail dark (source pins)", () => {
  it("the costs route KPIs come from sbCountDark and name their dark sources", () => {
    const costs = readCode("src/app/api/admin/costs/route.ts");
    expect(costs).toMatch(/sbCountDark\("searches", since\)/);
    expect(costs).toMatch(/sbCountDark\("offers", since\)/);
    expect(costs).toMatch(/sbCountDark\("app_users", ""\)/);
    // No KPI is a slice length anymore.
    expect(costs).not.toMatch(/searches\.length|offers\.length|outbound\.length|users\.length/);
    expect(costs).toMatch(/degraded/);
  });

  it("the analytics route hydrates the durable tactic table BEFORE reporting", () => {
    const route = readCode("src/app/api/admin/analytics/route.ts");
    expect(route).toMatch(/await hydrateTactics\(\);/);
  });
});

describe("seeded priors are never presented as measurements", () => {
  it("analytics() labels tactics still at their shipped baseline", async () => {
    vi.resetModules();
    const { analytics } = await import("../../lib/memory");
    const a = analytics();
    // A fresh process serves the starter playbook - every tactic is seeded and
    // the aggregate says so, which is what the panel's banner keys on.
    expect(a.allSeeded).toBe(true);
    expect(a.tactics.every((t: { seeded?: boolean }) => t.seeded)).toBe(true);
  });

  it("a measured tactic loses the seeded label", async () => {
    vi.resetModules();
    const mem = await import("../../lib/memory");
    const t = { id: "anchor-low", label: "x", script: "y", uses: 13, wins: 7, avgDiscountPct: 11 };
    expect(mem.isSeededTactic(t)).toBe(false);
    expect(mem.isSeededTactic({ ...t, uses: 12 })).toBe(true);
  });
});

describe("the workspace shape (source pins)", () => {
  const page = readCode("src/app/admin/page.tsx");

  it("the graph-era agents tab is DELETED, not hidden", () => {
    expect(page).not.toMatch(/tab === "agents"/);
    expect(page).not.toMatch(/OrchestratorPanel|PipelineStudio/);
  });

  it("the ops tab is reachable again, owner-only (owner decision 5)", () => {
    expect(page).toMatch(/\.\.\.\(isOwner \? \(\["ops"\] as const\) : \[\]\)/);
    expect(page).toMatch(/tab === "ops" && isOwner && <OpsCenterPanel \/>/);
  });

  it("a settings tab hosts the theme + language controls", () => {
    expect(page).toMatch(/tab === "settings"/);
    const settings = page.slice(page.indexOf('tab === "settings"'));
    expect(settings.slice(0, 1200)).toMatch(/<ThemeToggle \/>/);
    expect(settings.slice(0, 1200)).toMatch(/<LanguageButton \/>/);
  });

  it("loadCommand lands each leg independently - one failed fetch cannot blank the tab", () => {
    expect(page).toMatch(/Promise\.allSettled\(\[\s*fetch\("\/api\/admin\/command"\)/);
    expect(page).toMatch(/setCommandErrs\(errs\)/);
  });

  it("Command KPIs are StatTiles bound to the COMMAND_HELP catalogue", () => {
    expect(page).toMatch(/<StatTile help=\{COMMAND_HELP\} helpId="waSessions"/);
    expect(page).toMatch(/<StatTile help=\{COMMAND_HELP\} helpId="openIssues"/);
    expect(page).toMatch(/satisfies Record<string, StatHelp>/);
  });

  it("the shared fail-dark primitives are adopted, not re-invented per tab", () => {
    expect(page).toMatch(/import \{ StatTile, DegradedBanner, type StatHelp \} from "@\/components\/admin\/primitives"/);
    const lifecycle = readCode("src/components/admin/LifecyclePanel.tsx");
    expect(lifecycle).toMatch(/import \{ Num, DegradedBanner \} from "\.\/primitives"/);
    expect(lifecycle).not.toMatch(/function Num\(/);
  });
});
