import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

// A PLUS SIGN EMPTIED THE ENTIRE TRIPS HUB.
//
// PostgREST renders a `timestamptz` as `2026-08-11T12:00:00.123456+00:00`. The
// obvious thing to do with that value - feed it back as the floor of the next
// query - is broken, because `+` in a query string means SPACE. Postgres gets
// `...123456 00:00`, cannot parse it, and answers 400. `sbSelect` maps 400 to
// `[]`, so the caller sees an empty table rather than an error.
//
// It shipped twice, in opposite directions:
//
//   /api/deals used the oldest kept session's created_at as the floor for FIVE
//   reads. All five 400'd, so Trips showed 0 contacted, 0 replied, no offers and
//   no best price to every user who had ever run a hunt. The offers read has a
//   two-tier fallback and BOTH tiers carried the same broken filter, so the
//   fallback could not rescue it.
//
//   /api/outreach/mass used the newest searches.created_at as the floor for the
//   per-session shop cap - the one its own comment calls "backend truth, cannot
//   be bypassed by repeat taps". Zero rows counted as contacted, so the cap
//   failed OPEN.
//
// Every other call site in the repo was fine, and that is the trap: they all
// derived their bound from `new Date(...).toISOString()`, which ends in `Z` and
// survives raw interpolation. Raw interpolation was never SAFE - it was
// UNTESTED, and it broke the first time a value came from the database instead
// of from a clock.

describe("the decode that did it", () => {
  it("REPRODUCTION: a raw PostgREST timestamp arrives at the server as garbage", async () => {
    const { pgTimestamp } = await import("./runtime-config");
    const fromDb = "2026-08-11T12:00:00.123456+00:00";

    // URLSearchParams applies exactly the form-decoding a WAI/PostgREST server
    // applies to a query string. This is the bug, executed.
    const broken = new URLSearchParams(`created_at=gte.${fromDb}`).get("created_at");
    expect(broken).toBe("gte.2026-08-11T12:00:00.123456 00:00");
    expect(Number.isNaN(Date.parse(broken!.slice(4)))).toBe(true);

    // ...and through the normalizer it survives the round trip.
    const fixed = new URLSearchParams(`created_at=gte.${pgTimestamp(fromDb)}`).get("created_at");
    expect(fixed).toBe("gte.2026-08-11T12:00:00.123Z");
    expect(Number.isNaN(Date.parse(fixed!.slice(4)))).toBe(false);
  });

  it("microseconds round DOWN, which is the safe direction for both bounds", async () => {
    const { pgTimestamp } = await import("./runtime-config");
    // A `gte` floor that moved down can only include a row it already included;
    // an `lte` ceiling that moved down can only drop the final microsecond.
    // Rounding UP would silently drop a row from a floor.
    expect(decodeURIComponent(pgTimestamp("2026-08-11T12:00:00.999999+00:00"))).toBe(
      "2026-08-11T12:00:00.999Z"
    );
  });

  it("it accepts the three shapes call sites actually hold", async () => {
    const { pgTimestamp } = await import("./runtime-config");
    const iso = "2026-08-11T12:00:00.000Z";
    for (const v of [iso, Date.parse(iso), new Date(iso)]) {
      expect(decodeURIComponent(pgTimestamp(v))).toBe(iso);
    }
  });

  it("an unparseable bound THROWS rather than matching everything", async () => {
    const { pgTimestamp } = await import("./runtime-config");
    // A floor that has quietly become "the beginning of time" is how the mass
    // cap failed open. Loud is the only correct direction here.
    expect(() => pgTimestamp("")).toThrow(/not a timestamp/);
    expect(() => pgTimestamp("last tuesday")).toThrow(/not a timestamp/);
    expect(() => pgTimestamp(Number.NaN)).toThrow(/not a timestamp/);
  });
});

describe("the class is closed, not the two instances", () => {
  function walk(dir: string, out: string[] = []): string[] {
    let entries;
    try {
      entries = readdirSync(join(process.cwd(), dir), { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".next" || e.name === "dist") continue;
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
    }
    return out;
  }

  it("no comparison filter interpolates a bare value", () => {
    // `gte.`/`lte.`/`gt.`/`lt.` are the operators whose right-hand side is a
    // timestamp in this codebase. Requiring the wrapper at the INTERPOLATION
    // SITE rather than trusting the variable is the point: the two defects were
    // both a variable whose name promised an ISO string and whose value came
    // from the database.
    const offenders: string[] = [];
    for (const f of [...walk("src"), ...walk("services"), ...walk("packages"), ...walk("apps")]) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      src.split("\n").forEach((line, i) => {
        for (const m of line.matchAll(/\b(?:gte|lte|gt|lt)\.\$\{([^}]*)/g)) {
          const arg = m[1].trim();
          if (arg.startsWith("pgTimestamp(") || arg.startsWith("encodeURIComponent(")) continue;
          offenders.push(`${f}:${i + 1}  ${line.trim().slice(0, 120)}`);
        }
      });
    }
    expect(
      offenders,
      `wrap these in pgTimestamp() - a raw "+00:00" from the database decodes to a space and 400s the read, which sbSelect renders as an empty table:\n${offenders.join(
        "\n"
      )}`
    ).toEqual([]);
  });

  it("and the two sites that were broken are wrapped", () => {
    const deals = readFileSync(join(process.cwd(), "src/app/api/deals/route.ts"), "utf8");
    // All five reads, not just the first - the offers fallback carried it too.
    expect(deals.match(/gte\.\$\{pgTimestamp\(oldestStart\)\}/g)?.length).toBe(5);
    const mass = readFileSync(join(process.cwd(), "src/app/api/outreach/mass/route.ts"), "utf8");
    expect(mass).toMatch(/gte\.\$\{pgTimestamp\(sinceIso\)\}/);
  });
});
