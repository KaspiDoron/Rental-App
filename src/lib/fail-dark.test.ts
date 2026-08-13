import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

// A FIX FOR A FAIL-GREEN DEFECT THAT WAS ITSELF FAIL-GREEN.
//
// `sbSelect` has NO rejection path. A missing connection returns [], a non-2xx
// returns [], a thrown exception returns []. That is deliberate and fine for a
// decorative read. What is not fine is what was built on top of it:
//
//   const rows = await sbSelect(...).catch(() => null);
//   if (rows === null) degraded.push("...");
//
// The catch is unreachable, so `null` is unreachable, so `degraded` is
// permanently empty. Two separate repairs shipped in exactly that shape - the
// Command Center's nine reads (recorded as Tier 0.35, "shipped") and the Ops
// Analytics panel - and both went on rendering a confident green over a dead
// database while their fix sat in the file looking correct.
//
// Nothing caught it because every test asserted the SOURCE looked right. A
// source pin cannot tell a reachable branch from an unreachable one. These tests
// execute the failure path.

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(join(process.cwd(), dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".next" || e.name === "dist") continue;
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("REPRODUCTION: the permissive reader cannot reject, so its catches are dead", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("sbSelect resolves to [] even when fetch throws - the catch never runs", async () => {
    vi.doMock("server-only", () => ({}));
    const rc = await import("./runtime-config");
    const before = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
    process.env.SUPABASE_URL = "https://stub.invalid";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "stub";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("ECONNREFUSED"));
    try {
      let caught = false;
      const rows = await rc.sbSelect("anything", "select=id").catch(() => {
        caught = true;
        return null;
      });
      expect(fetchSpy).toHaveBeenCalled();
      // THE WHOLE DEFECT IN TWO ASSERTIONS.
      expect(caught, "sbSelect rejected - if this ever becomes true the fix can be simpler").toBe(false);
      expect(rows, "a total outage is indistinguishable from an empty table").toEqual([]);
    } finally {
      fetchSpy.mockRestore();
      if (before.url === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = before.url;
      if (before.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = before.key;
    }
  });

  it("sbSelectDark tells an outage from an empty table from a missing one", async () => {
    vi.doMock("server-only", () => ({}));
    const rc = await import("./runtime-config");
    const before = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
    process.env.SUPABASE_URL = "https://stub.invalid";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "stub";
    const spy = vi.spyOn(globalThis, "fetch");
    try {
      // A real outage is UNKNOWN, never zero.
      spy.mockRejectedValue(new Error("ECONNREFUSED"));
      expect(await rc.sbSelectDark("t", "select=id")).toBeNull();

      // A table that has not been migrated is vacuously empty - a fresh install
      // must not paint its whole dashboard dark.
      spy.mockResolvedValue(new Response("", { status: 404 }));
      expect(await rc.sbSelectDark("t", "select=id")).toEqual([]);

      // And a genuine empty result is still a trustworthy zero.
      spy.mockResolvedValue(
        new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
      );
      expect(await rc.sbSelectDark("t", "select=id")).toEqual([]);
    } finally {
      spy.mockRestore();
      if (before.url === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = before.url;
      if (before.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = before.key;
    }
  });
});

/** Load a route with runtime-config stubbed to a total Supabase outage. */
async function loadWithOutage(path: string) {
  vi.resetModules();
  vi.doMock("server-only", () => ({}));
  vi.doMock("@/lib/session", () => ({
    requireManagement: async () => ({ email: "owner@example.com", isAdmin: true }),
    requireOwner: async () => ({ email: "owner@example.com", isAdmin: true }),
    getSession: async () => ({ email: "owner@example.com", isAdmin: true }),
  }));
  vi.doMock("@/lib/runtime-config", () => ({
    // Every read is a hard outage. `sbSelectDark`/`sbCountDark` answer null;
    // anything still using `sbSelect` answers [] - which is exactly the
    // difference under test.
    sbSelectDark: async () => null,
    sbCountDark: async () => null,
    sbSelect: async () => [],
    sbSelectStrict: async () => ({ error: "unavailable" as const }),
    sbCount: async () => 0,
    sbInsert: async () => false,
    sbUpdate: async () => false,
    sbDelete: async () => false,
    getConfig: async () => undefined,
    getConfigMany: async () => ({}),
  }));
  // vitest resolves no "@/" alias, so any collaborator the route imports through
  // it must be stubbed or the module fails to load. That is a harness fact, not
  // a hint about the code.
  vi.doMock("@/lib/ops/rev", () => ({ getActiveRev: async () => 1 }));
  return import(path);
}

describe("the Command Center cannot report 'nothing is broken' while it cannot read", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("a total outage produces a degraded list and a critical alert, not a green panel", async () => {
    const mod = await loadWithOutage("../app/api/admin/command/route");
    const res = await mod.GET();
    const body = (await res.json()) as { degraded?: string[]; alerts?: Array<{ level: string }> };

    expect(
      body.degraded?.length,
      "degraded was empty during a total outage - the fix is inert again"
    ).toBeGreaterThan(0);
    // The one surface whose entire job is to say "something is broken" must not
    // answer "nothing is broken" as its failure mode.
    expect(body.alerts?.some((a) => a.level === "critical")).toBe(true);
  });
});

describe("Ops Analytics renders dark, not a quiet week", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("an outage names every unread input instead of reporting zeros", async () => {
    const mod = await loadWithOutage("../app/api/admin/ops/analytics/route");
    const res = await mod.GET(new Request("http://localhost/api/admin/ops/analytics?days=30"));
    const body = (await res.json()) as { degraded?: string[] };
    expect(
      body.degraded ?? [],
      "the panel reported a complete analytics page over a dead database"
    ).toEqual(expect.arrayContaining(["decision traces", "judge scores", "owner reviews"]));
  });
});

describe("THE LINT: a catch on a permissive reader that changes the value is a lie", () => {
  it("no .catch on sbSelect/sbCount returns anything other than the reader's own fallback", () => {
    // SCOPED DELIBERATELY, because the blunt version is not worth having.
    //
    // A repo-wide sweep finds 208 `.catch` handlers chained to `sbSelect`. Every
    // one is unreachable. But ~200 of them are `.catch(() => [] as Row[])` - a
    // TYPE CAST that returns exactly what sbSelect already returns. Dead, noisy,
    // and completely harmless. Deleting 200 of those is churn with no behaviour
    // change, and a lint that demands it would be ignored or disabled.
    //
    // The handlers that MATTER are the ones returning something else - `null`,
    // `0`, a sentinel - because the author meant "on failure, do the other
    // thing", and the other thing has never happened. That is where the bugs
    // live: two shipped fail-dark fixes, and the pre-migration column degrade in
    // /api/deals/restore that has never once executed.
    //
    // A read that genuinely needs to distinguish an outage from an empty table
    // must use sbSelectDark (truth surfaces) or sbSelectStrict (safety gates).
    // Both say so in the type, so the branch cannot be unreachable.
    const files = [
      ...walk("src"),
      ...walk("services"),
      ...walk("apps"),
      ...walk("packages"),
    ].filter((f) => !/\.test\./.test(f));

    const offenders: string[] = [];
    for (const f of files) {
      const code = readCode(f);
      const CALL = /\bsb(?:Select|Count)\s*(?:<[^>]*>)?\s*\(/g;
      for (let m = CALL.exec(code); m; m = CALL.exec(code)) {
        // Only the permissive readers. sbSelectStrict and sbSelectDark are
        // different identifiers and are deliberately excluded by the boundary.
        const name = code.slice(m.index).match(/^\bsb(?:Select|Count)\b/)?.[0];
        if (!name) continue;
        // Walk to the matching close paren, then look at what follows.
        let depth = 0;
        let i = m.index + m[0].length - 1;
        for (; i < code.length; i++) {
          if (code[i] === "(") depth++;
          else if (code[i] === ")") {
            depth--;
            if (depth === 0) break;
          }
        }
        const after = code.slice(i + 1, i + 60).replace(/\s+/g, "");
        const handler = /^\.catch\(\(\)=>([^)]*)\)/.exec(after)?.[1];
        if (handler === undefined) continue;
        // `[]` and `[] as Row[]` are the reader's own fallback wearing a cast.
        if (handler === "[]" || /^\[\]as/.test(handler)) continue;
        const line = code.slice(0, m.index).split("\n").length;
        offenders.push(`${f}:${line} -> catch(() => ${handler})`);
      }
    }
    expect(
      offenders,
      `these .catch handlers can never run:\n${offenders.join("\n")}`
    ).toEqual([]);
  });
});
