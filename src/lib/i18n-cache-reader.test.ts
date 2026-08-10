import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// A CACHE NOBODY COULD READ - I-6a.
//
// /api/translate writes its per-language dictionary to app_config under
// I18N_<lang>. The vault's whole-table read filters `key=not.like.I18N_*` (so
// the big rows do not inflate every cold start), and its comment claimed the
// rows were "still readable by their own reader, which asks for them by exact
// key". That reader was never written - the route read the cache with plain
// getConfig, which goes through the SAME filtered load and returned undefined
// every time. So every cold load in a non-English language re-translated the
// entire catalogue and wrote back a row nothing could read.

describe("getConfigExact reads the I18N row the vault filter hides", () => {
  const ORIG = { ...process.env };
  beforeEach(() => {
    vi.resetModules();
    process.env.SUPABASE_URL = "https://proj.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    process.env.SESSION_SECRET = "a-test-secret-for-aes";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...ORIG };
  });

  it("fetches ONE row by exact key, and does NOT carry the not.like filter", async () => {
    const rc = await import("./runtime-config");
    const encrypted = rc.encryptString(JSON.stringify({ Next: "הבא" }));
    let seenUrl = "";
    vi.stubGlobal("fetch", async (url: string) => {
      seenUrl = String(url);
      return { ok: true, json: async () => [{ value: encrypted }] } as unknown as Response;
    });
    const raw = await rc.getConfigExact("I18N_he");
    // The round-trips through AES: what went in comes back out.
    expect(JSON.parse(raw ?? "{}")).toEqual({ Next: "הבא" });
    // Addressed by exact key...
    expect(seenUrl).toMatch(/key=eq\.I18N_he/);
    // ...and NOT through the vault's exclusion filter that hid it.
    expect(seenUrl).not.toMatch(/not\.like/);
  });

  it("a missing row falls through to process.env, not a crash", async () => {
    const rc = await import("./runtime-config");
    vi.stubGlobal("fetch", async () => ({ ok: true, json: async () => [] }) as unknown as Response);
    expect(await rc.getConfigExact("I18N_xx")).toBeUndefined();
  });

  it("a failed read returns undefined rather than throwing", async () => {
    const rc = await import("./runtime-config");
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    await expect(rc.getConfigExact("I18N_he")).resolves.toBeUndefined();
  });

  it("a legacy PLAINTEXT row (not AES) is returned as-is", async () => {
    // fetchOverrides treats an undecryptable row's raw value the same way for
    // legacy rows; the exact reader mirrors that so a hand-written row still
    // reads.
    const rc = await import("./runtime-config");
    vi.stubGlobal(
      "fetch",
      async () => ({ ok: true, json: async () => [{ value: "{}" }] }) as unknown as Response
    );
    expect(await rc.getConfigExact("I18N_he")).toBe("{}");
  });
});

describe("the translate route uses the exact reader, not the filtered one", () => {
  const route = readCode("src/app/api/translate/route.ts");

  it("both cache reads go through getConfigExact", () => {
    expect(route).toMatch(/import \{ getConfigExact, setConfig \}/);
    const filteredReads = route.match(/getConfig\(cacheKey\)/g) ?? [];
    expect(filteredReads).toHaveLength(0); // the OLD, filtered read is gone
    const exactReads = route.match(/getConfigExact\(cacheKey\)/g) ?? [];
    expect(exactReads).toHaveLength(2); // initial read + pre-write re-read
  });

  it("the vault filter that hid these rows is still in place for the bulk read", () => {
    // The exact reader is the escape hatch; the exclusion itself must remain,
    // or every cold start pays to download the whole translation corpus again.
    const rc = readCode("src/lib/runtime-config.ts");
    expect(rc).toMatch(/const VAULT_SELECT = "select=key,value&key=not\.like\.I18N_\*"/);
  });
});
