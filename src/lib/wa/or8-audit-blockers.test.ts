import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { splitHostLines } from "../evolution";
import { parseDialPrefixes, affinityFor, AFFINITY_MATCH } from "./host-region";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// THE POST-SHIP AUDIT.
//
// Owner report 8 shipped in eight merges, each falsified by revert IN ISOLATION.
// An adversarial sweep over the whole diff found four blockers, and all four are
// the same shape: a fix that is correct in the function that was edited and
// ABSENT at the call site that matters. These tests pin the call sites.

describe("F1.1 the host line survives its own parser", () => {
  // The parser split the WHOLE blob on /[\n,]+/ before splitting a line on `|`,
  // so the third field - added by wave C for geo placement - kept only its first
  // prefix and the rest became keyless fragments that were silently dropped.
  // Wave C was therefore inert for the exact line every one of its own docs
  // tells the owner to paste, while the fleet looked correctly configured.

  it("a multi-prefix host is ONE host that keeps every prefix", () => {
    const lines = splitHostLines("https://sg.example.com|K1|66,84,855,856,60,65");
    expect(lines).toHaveLength(1);
    const [url, key, regions] = lines[0].split("|");
    expect(url).toBe("https://sg.example.com");
    expect(key).toBe("K1");
    expect(parseDialPrefixes(regions)).toHaveLength(6);
  });

  it("THE REGRESSION: the docs' own example routes a Vietnamese number correctly", () => {
    // deploy/fleet/README.md, ANTI-BAN.md, SCALING.md and host-region.ts all
    // show this shape. Before the fix the SG host claimed only "66", so +84
    // ranked as a MISMATCH against the host built for it.
    const blob = [
      "https://sg.example.com|K1|66,84,855,856,60,65",
      "https://eu.example.com|K2|33,34,39,49,44",
    ].join("\n");
    const hosts = splitHostLines(blob).map((l) => {
      const [url, key, regions] = l.split("|").map((x) => x?.trim());
      return { url, key, dialPrefixes: parseDialPrefixes(regions) };
    });
    expect(hosts).toHaveLength(2);
    expect(affinityFor(hosts[0], "84912345678")).toBe(AFFINITY_MATCH);
    expect(affinityFor(hosts[0], "66812345678")).toBe(AFFINITY_MATCH);
  });

  it("the legacy comma-separated form still parses as several hosts", () => {
    // Every fragment carries its own `|`, which is what makes it legacy.
    expect(splitHostLines("https://a|K1,https://b|K2")).toEqual([
      "https://a|K1",
      "https://b|K2",
    ]);
    expect(splitHostLines("https://a|K1|66,https://b|K2|84")).toHaveLength(2);
  });

  it("blank lines and stray whitespace are ignored, not turned into hosts", () => {
    expect(splitHostLines("\n  https://a|K1  \n\n")).toEqual(["https://a|K1"]);
    expect(splitHostLines("")).toEqual([]);
  });

  it("getHosts routes through the shared splitter, not its own regex", () => {
    const evo = readCode("src/lib/evolution.ts");
    expect(evo).toMatch(/splitHostLines\(multi\)/);
    expect(evo).not.toMatch(/multi\s*\n?\s*\.split\(\/\[\\n,\]\+\/\)/);
  });
});

describe("F1.2 the dead-link refusal sits where every caller passes", () => {
  const evo = readCode("src/lib/evolution.ts");

  it("ensureConnected itself refuses a severed link", () => {
    const at = evo.indexOf("export async function ensureConnected");
    expect(at).toBeGreaterThan(-1);
    const head = evo.slice(at, at + 900);
    expect(head).toMatch(/storedStatus\(email\)\) === "close"/);
    // ...and refuses BEFORE it can touch the transport.
    const refuse = head.indexOf('=== "close"');
    const create = head.indexOf("resolveHost");
    expect(refuse).toBeGreaterThan(-1);
    expect(refuse).toBeLessThan(create);
  });

  it("it fails OPEN - only the literal 'close' refuses", () => {
    // storedStatus returns "unknown" when the read is unavailable and null when
    // there is no row. A Supabase blip must never block a healthy re-pair.
    const at = evo.indexOf("async function storedStatus");
    const fn = evo.slice(at, at + 700);
    expect(fn).toMatch(/res\.error === "unavailable" \? "unknown" : null/);
  });

  it("our own refusal is not counted as a WhatsApp failure", () => {
    // Feeding the 3-hard-fails stop-loss with our own caution would pause the
    // number for a restriction it had already detected.
    const at = evo.indexOf("const conn = await ensureConnected(email, 6000)");
    expect(at).toBeGreaterThan(-1);
    expect(evo.slice(at, at + 2400)).toMatch(/conn\.state !== "close"/);
  });

  it("the three bypassing callers now inherit it by construction", () => {
    // They call ensureConnected bare, which is exactly why the refusal belongs
    // inside it rather than being repeated at each site.
    for (const f of [
      "src/app/api/outreach/mass/route.ts",
      "src/app/api/admin/training/import/route.ts",
    ]) {
      expect(readCode(f)).toMatch(/ensureConnected\(session\.email/);
    }
    expect(evo).toMatch(/const conn = await ensureConnected\(email, 6000\)/);
  });
});

describe("F1.3 the cap refuses applicants, not occupants", () => {
  const evo = readCode("src/lib/evolution.ts");

  it("a stored user gets their own host back instead of null", () => {
    const at = evo.indexOf("if (!underCap.length) {");
    expect(at).toBeGreaterThan(-1);
    const branch = evo.slice(at, at + 1200);
    expect(branch).toMatch(/const home = stored \? hosts\.find\(\(h\) => h\.url === stored\) : undefined;/);
    expect(branch).toMatch(/return home \?\? null;/);
  });

  it("a genuinely new user is still refused - the cap still caps", () => {
    // `home` is undefined without a stored host, so the branch still returns null.
    const at = evo.indexOf("if (!underCap.length) {");
    const branch = evo.slice(at, at + 1200);
    expect(branch).toMatch(/\?\? null;/);
  });

  it("the single-host branch keeps its own exemption", () => {
    expect(evo).toMatch(/if \(stored === hosts\[0\]\.url\) return hosts\[0\];/);
  });
});

describe("F1.4 a rejected move falls back to the SAME move", () => {
  const orch = readCode("src/lib/spte/orchestrator.ts");

  it("the rejected move is composed deterministically before the ladder", () => {
    // fallbackArtifact takes legalMoves[0], so a bargain rejected by
    // cite-the-rival became an `answer` that cites no rival - dropping the
    // leverage at the exact moment the rail fired to enforce it.
    expect(orch).toMatch(/const sameMove = templateFor\(ctx, artifact\.move\);/);
    expect(orch).toMatch(/move: artifact\.move,/);
    expect(orch).toMatch(/: fallbackArtifact\(ctx\);/);
  });

  it("a double rejection says SILENT rather than acting with no text", () => {
    // finalize renders `text: move === "silent" ? undefined : finalText`, so a
    // non-silent move whose text was rejected claims to have spoken and carries
    // nothing to send.
    expect(orch).toMatch(/out = \{ \.\.\.out, move: "silent", message: undefined \};/);
    // ...and the ladder gets one more chance first.
    expect(orch).toMatch(/const ladder = fallbackArtifact\(ctx\);/);
  });

  it("the bargain template it now reaches does cite the rival", () => {
    const pass = read("src/lib/spte/pass.ts");
    expect(pass).toMatch(/Another shop offered \$\{money\(rival\.pricePerDay\)\}\/day/);
  });

  it("leverageUsed is derived from the text, not hard-coded to []", () => {
    const pass = readCode("src/lib/spte/pass.ts");
    expect(pass).toMatch(/export function fallbackLeverage\(/);
    expect(pass).toMatch(/leverageUsed: fallbackLeverage\(ctx, move, message\)/);
    expect(pass).not.toMatch(/leverageUsed: \[\],\s*\n\s*digestPatch: \[\],\s*\n\s*\};\s*\n\}/);
  });
});
