import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// FIVE NUMBERS DERIVED FROM AN ARBITRARY SLICE.
//
// Each one reads a bounded window and then reports something the window cannot
// answer: a total, a per-shop tally, a personal best, one traveller's own
// thread. They all degrade silently, and all of them get WORSE as the product
// succeeds - which is the property worth naming, because none of them would
// ever show up in testing.

describe("a count is a count, not a thousand rows with .length taken", () => {
  const route = readCode("src/app/api/admin/data/route.ts");

  it("REGRESSION: the table list uses sbCountDark, not select=*&limit=1000", () => {
    expect(route).not.toMatch(/sbSelect<Record<string, unknown>>\(t\.name, "select=\*&limit=1000"\)/);
    expect(route).toMatch(/const n = await sbCountDark\(t\.name, ""\);/);
  });

  it("an unreadable table reads as UNKNOWN, not as empty", () => {
    // sbSelect maps a timeout or non-2xx to [], so a slow table reported ZERO.
    // sbCountDark returns null, and the response says which ones.
    expect(route).toMatch(/unreadable: n === null/);
    expect(route).toMatch(/degraded: tables\.filter\(\(t\) => t\.unreadable\)/);
  });

  it("runtime-config already forbade the old pattern by name", () => {
    // Which is the interesting part: the rule was written down and the route
    // was never brought in line.
    const rc = readFileSync(join(process.cwd(), "src/lib/runtime-config.ts"), "utf8");
    expect(rc).toMatch(/selecting rows and taking `\.length`/);
    expect(rc).toMatch(/silently under-reports the moment the real count exceeds it/);
  });
});

describe("social proof is scoped to the shops on screen", () => {
  const route = readCode("src/app/api/vendors/route.ts");

  it("REGRESSION: the global 2000-row read is gone", () => {
    expect(route).not.toMatch(/"select=vendor_id&limit=2000"/);
    expect(route).toMatch(/vendor_id=in\.\(\$\{encodeURIComponent\(list\)\}\)/);
  });

  it("the id list comes from the result, so cost scales with the SEARCH", () => {
    expect(route).toMatch(/const ids = vendors\.map\(\(v\) => v\.id\)\.filter\(Boolean\)\.slice\(0, 60\);/);
    // No shops, no query at all.
    expect(route).toMatch(/if \(ids\.length\) \{/);
  });

  it("quotes in an id cannot break out of the in.() list", () => {
    expect(route).toMatch(/\.replace\(\/"\/g, ""\)/);
    expect(route).toMatch(/encodeURIComponent\(list\)/);
  });

  it("the cross-user scope is KEPT - that is what makes it social proof", () => {
    // The bug was the cap and the missing order, not the sharing.
    expect(route).not.toMatch(/user_email=eq\..*bookings/);
  });
});

describe("your own best score is not a fact about the leaderboard", () => {
  const route = readCode("src/app/api/game/score/route.ts");

  it("REGRESSION: myBest comes from a scoped read, not the global top 60", () => {
    expect(route).toMatch(/user_email=eq\.\$\{encodeURIComponent\(\s*session\.email\s*\)\}&order=score\.desc&limit=1/);
  });

  it("...and the old board-slice scan is kept as the degrade path", () => {
    // If the scoped read fails, falling back to the old answer is strictly
    // better than falling back to zero.
    expect(route).toMatch(/Math\.max\(\s*own\[0\]\?\.score \?\? 0,/);
    expect(route).toMatch(/rows\.filter\(\(r\) => r\.user_email === session\.email\)/);
  });
});

describe("one traveller's own thread history is not crowded out by strangers", () => {
  const route = readCode("src/app/api/bargain-draft/route.ts");

  it("REGRESSION: the SQL is scoped to this user, so limit=20 is THEIR 20", () => {
    // Both OR arms are cross-user by construction - a Google place id and a
    // shop's number are shared - so for a popular shop the newest 20 rows were
    // mostly other users', `mine` came back empty, and the prompt lost the
    // traveller's history entirely.
    expect(route).toMatch(/&or=\(raw->>sender\.eq\.\$\{me\},raw->>receiver\.eq\.\$\{me\}\)/);
    expect(route).toMatch(/const me = encodeURIComponent\(session\.email\);/);
  });

  it("the JS ownership filter STAYS - it is the guarantee, the SQL is the fix", () => {
    // It is stricter than the query (it pairs the stamp with the direction),
    // and there was never a leak here; the defect was silent truncation.
    expect(route).toMatch(/m\.direction === "inbound"\s*\? m\.raw\?\.receiver === session\.email\s*: m\.raw\?\.sender === session\.email/);
  });

  it("and the comment no longer claims a filter the query does not have", () => {
    const raw = readFileSync(join(process.cwd(), "src/app/api/bargain-draft/route.ts"), "utf8");
    expect(raw).not.toMatch(/so both directions are filtered to THIS user \(outbound by\n\s*\/\/ sender, inbound by receiver\) - never another user's thread\./);
    expect(raw).toMatch(/PRIVACY holds/);
  });
});

describe("a shared config row cannot be grown without bound", () => {
  const route = readCode("src/app/api/translate/route.ts");

  it("REGRESSION: only strings the app actually renders are accepted", () => {
    expect(route).toMatch(/const allowed = new Set\(I18N_CATALOG\);/);
    expect(route).toMatch(/\.filter\(\(t: string\) => allowed\.has\(t\)\)/);
  });

  it("the catalogue is the honest bound, because t() refuses anything else", () => {
    // A string outside the catalogue could never be RENDERED even if we
    // translated it - so translating it was pure cost with an unbounded tail.
    const gate = readCode("src/lib/i18n-gate.ts");
    expect(gate).toMatch(/const CATALOG = new Set<string>\(I18N_CATALOG\);/);
  });

  it("the terminal state it prevents is already documented for the vault", () => {
    const rc = readFileSync(join(process.cwd(), "src/lib/runtime-config.ts"), "utf8");
    expect(rc).toMatch(/once the corpus exceeded what transfers inside timedFetch's 8s/);
  });

  it("the language key was already safe - that half was never the hole", () => {
    expect(route).toMatch(/LANG_RX\.test\(lang\)/);
  });
});
