import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// TWENTY-SEVEN SECONDS OF DEAD SERVER, ON A PAGE THAT LOOKED LIKE A SPINNER BUG.
//
// The owner reported "/profile shows only skeletons". The skeleton was a
// symptom: /api/auth/me could not be answered because the Node event loop was
// blocked. scryptSync is a KDF - deliberately expensive, ~71ms - and it is
// SYNCHRONOUS, so it does not merely cost time, it stops everything. decrypt()
// called it once per row, loadOverrides() decrypts the whole table, nothing was
// memoized, and there was no in-flight dedupe, so N concurrent callers each
// paid for a full table. revealKeys() then fanned 52 keys into 52 of those - on
// the Profile page, for every user, not just owners.
//
// These are executed tests, not source pins. The previous audit found that no
// test in this repo executes a route handler and that source pins had been
// letting broken behaviour through; a claim about cost has to be measured.

describe("REPRODUCTION: the key derivation ran once per row, forever", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  // scryptSync cannot be spied (native binding, non-configurable), so this
  // measures the thing that actually mattered: WALL-CLOCK COST. One derivation
  // measured ~71ms in this environment, so 25 unmemoized derivations would cost
  // well over a second of blocked event loop. Memoized, the 25 cost one.
  it("N derivations of the same secret cost ONE derivation, measured", async () => {
    vi.doMock("server-only", () => ({}));
    const rc = await import("./runtime-config");

    rc._resetKeyCache();
    const t0 = performance.now();
    rc.encryptString("warm the key");
    const oneDerivation = performance.now() - t0;

    // Now the key is cached: 40 more encryptions must not pay for it again.
    const t1 = performance.now();
    for (let i = 0; i < 40; i++) rc.encryptString("hello");
    const forty = performance.now() - t1;

    // 40 memoized encryptions must be cheaper than 2 derivations. Unmemoized
    // they would be ~40x. The bound is deliberately loose so this measures the
    // defect, not the machine.
    expect(
      forty,
      `40 encryptions took ${forty.toFixed(1)}ms; one key derivation alone took ${oneDerivation.toFixed(1)}ms`
    ).toBeLessThan(Math.max(oneDerivation * 2, 40));
  });

  it("a DIFFERENT secret still derives its own key - the memo is keyed, not global", async () => {
    vi.doMock("server-only", () => ({}));
    const rc = await import("./runtime-config");
    const before = process.env.SESSION_SECRET;
    try {
      // Round-tripping under two different secrets proves each got its own key:
      // a single shared key would decrypt both, and a global memo would make
      // the second secret silently reuse the first key.
      process.env.SESSION_SECRET = "secret-one";
      rc._resetKeyCache();
      const underOne = rc.encryptString("payload");

      process.env.SESSION_SECRET = "secret-two";
      const underTwo = rc.encryptString("payload");
      expect(rc.decryptString(underTwo)).toBe("payload");

      // The blob written under the OLD secret must no longer decrypt (no
      // SESSION_SECRET_PREVIOUS set), which can only be true if the second
      // secret really derived a different key.
      expect(rc.decryptString(underOne)).toBeNull();
    } finally {
      if (before === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = before;
      rc._resetKeyCache();
    }
  });

  it("...and a round trip still works, so the memo did not break correctness", async () => {
    vi.doMock("server-only", () => ({}));
    const rc = await import("./runtime-config");
    const blob = rc.encryptString("the quick brown fox");
    expect(rc.decryptString(blob)).toBe("the quick brown fox");
  });
});

describe("the vault read, and what it must not download", () => {
  const rc = readCode("src/lib/runtime-config.ts");

  it("REPRODUCTION: the translation corpus is excluded from the vault read", () => {
    // app_config is BOTH the Key Vault and the i18n cache. With no key filter,
    // every cold start downloaded and AES-decrypted every translated string in
    // all 20 languages before it could read OPERATOR_NAME - so the cold-start
    // cost grew monotonically with every non-English negotiation, permanently.
    expect(rc).toMatch(/const VAULT_SELECT = "select=key,value&key=not\.like\.I18N_\*";/);
    expect(rc).toMatch(/app_config\?\$\{VAULT_SELECT\}/);
    // The old unfiltered read must be gone.
    expect(rc).not.toMatch(/app_config\?select=key,value["`]/);
  });

  it("concurrent callers share ONE in-flight read", () => {
    expect(rc).toMatch(/if \(s\.inflight\) return s\.inflight;/);
    expect(rc).toMatch(/s\.inflight = run;/);
    expect(rc).toMatch(/s\.inflight = null;/);
  });

  it("a FAILED read is cached too, or a slow Supabase becomes a fetch storm", () => {
    // The cache was written only on the success path, so during an outage there
    // was effectively no cache and all 140 getConfig call sites issued a fresh
    // 8s-abort request on every call.
    expect(rc).toMatch(/const NEGATIVE_TTL_MS = /);
    expect(rc).toMatch(/exp: Date\.now\(\) \+ NEGATIVE_TTL_MS/);
  });

  it("an undecryptable row is COUNTED, not silently dropped", () => {
    // SESSION_SECRET is both the cookie signing key and the vault key, so a
    // rotation makes every row undecryptable - and that was handled by dropping
    // the row with no counter and no log. The owner saw a working app with
    // every integration blank and nothing anywhere saying why.
    expect(rc).toMatch(/undecryptable \+= 1;/);
    expect(rc).toMatch(/export function vaultDecryptHealth\(\)/);
    expect(rc).toMatch(/SESSION_SECRET_PREVIOUS/);
  });

  it("many keys cost one vault read, and revealKeys uses it", () => {
    expect(rc).toMatch(/export async function getConfigMany\(/);
    const cfg = readCode("src/lib/config.ts");
    expect(cfg).toMatch(/const values = await getConfigMany\(KEYS\.map\(\(k\) => k\.name\)\);/);
    // The 52-way fan-out is gone.
    expect(cfg).not.toMatch(/KEYS\.map\(async \(k\) => \(\{/);
  });
});

describe("the FAB can no longer be displaced by its own entrance animation", () => {
  it("pop-in animates `scale`, never the `transform` shorthand", () => {
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    const block = css.slice(css.indexOf("@keyframes pop-in"), css.indexOf(".pop-in {") + 200);
    expect(block).toMatch(/scale: 0\.96/);
    expect(block).toMatch(/scale: 1/);
    // `transform` in a filled-forwards keyframe outranks author declarations
    // and is retained forever - that is what destroyed -translate-x-1/2.
    expect(block).not.toMatch(/transform:/);
    // `backwards`, not `both`: nothing is retained after the run.
    expect(block).toMatch(/animation: pop-in [^;]*backwards;/);
  });

  it("...and the FAB anchors to `right`, needing no transform at all", () => {
    const fab = readCode("src/components/StatusFab.tsx");
    expect(fab).toMatch(/right: "calc\(env\(safe-area-inset-right, 0px\) \+ 1rem\)"/);
    expect(fab).not.toMatch(/-translate-x-1\/2/);
    expect(fab).not.toMatch(/left-1\/2/);
  });
});

describe("AI usage is recorded, which is why the providers page read zero", () => {
  it("the insert is awaited", () => {
    // The defect this pins is the MISSING AWAIT: a detached insert stops
    // wherever it is when Cloud Run throttles the CPU at response flush, which
    // is why every provider read "0 tokens / 0 calls". The row's columns are a
    // separate concern - M20 added `model` and `detail` - so this asserts the
    // await, not the shape.
    const ai = readCode("src/lib/ai.ts");
    expect(ai).toMatch(/await sbInsert\(\s*"ai_usage"/);
    expect(ai).not.toMatch(/[^t] sbInsert\("ai_usage"/);
  });
});
