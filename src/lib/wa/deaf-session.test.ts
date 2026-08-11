import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// risk-rollup reaches runtime-config, which is server-only.
vi.mock("server-only", () => ({}));
import { deafInstances, type FleetSample } from "./risk-rollup";
import { looksDeaf } from "./fleet-truth";
import { RISK_KINDS } from "./risk-events";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// THE DEAF TILE THAT COULD ONLY EVER READ ZERO (W-18).
//
// `session_deaf` is a declared risk kind. The dashboard sums it -
// `deaf: sum(buckets, "session_deaf")` in riskReport. And nothing in the
// codebase ever wrote one, so the number on the screen was a confident zero
// produced by an absent sensor.
//
// `looksDeaf` was written for precisely this condition - an instance that says
// `open`, that Evolution still lists (so its keepalives are fine), and whose
// message count has NOT MOVED while we were actively sending - and it was
// exported and never called. It cannot work on a single sample, which is why
// nobody could wire it from the dashboard's live read: it needs a PRIOR. The
// hourly rollup is the one scheduled thing that can carry one forward.
//
// This is the same defect class as the rest of the tier, at the worst possible
// address: the fail-green read, inside the machinery built to catch fail-green
// reads.

const inst = (state: string | null, messages: number | null) => ({ state, messages });

describe("REPRODUCTION: the condition needs two samples, so one sample found nothing", () => {
  it("a flat message count while we were sending is deaf", () => {
    expect(looksDeaf(inst("open", 100), inst("open", 100), 12)).toBe(true);
  });

  it("...but the SAME current reading, with no prior, says nothing at all", () => {
    // The dashboard's live read has exactly one sample. There is no call it
    // could have made that would have returned true.
    expect(deafInstances(null, { a: inst("open", 100) }, 12)).toEqual([]);
    expect(deafInstances(undefined, { a: inst("open", 100) }, 12)).toEqual([]);
  });

  it("an IDLE instance is not a deaf one", () => {
    // Nothing was sent this hour, so a flat count is exactly what a healthy
    // account looks like. Without this the detector would fire on every
    // account, every night.
    expect(deafInstances({ a: inst("open", 100) }, { a: inst("open", 100) }, 0)).toEqual([]);
  });

  it("a moving count is alive", () => {
    expect(deafInstances({ a: inst("open", 100) }, { a: inst("open", 104) }, 12)).toEqual([]);
  });

  it("an instance that is not open is a different fault, reported elsewhere", () => {
    // 401/403/440 have their own kinds. Reporting them as deaf too would
    // double-count one incident across two tiles.
    expect(deafInstances({ a: inst("close", 100) }, { a: inst("open", 100) }, 12)).toEqual([]);
    expect(deafInstances({ a: inst("open", 100) }, { a: inst("close", 100) }, 12)).toEqual([]);
  });

  it("an unknown count is unknown, never flat", () => {
    // Some Evolution builds do not send `_count`. Treating a missing number as
    // "did not move" would report the entire fleet deaf on those builds.
    expect(deafInstances({ a: inst("open", null) }, { a: inst("open", 100) }, 12)).toEqual([]);
    expect(deafInstances({ a: inst("open", 100) }, { a: inst("open", null) }, 12)).toEqual([]);
  });

  it("an instance with no prior is skipped, not judged", () => {
    // A newly linked account appears mid-window. It has no history to be flat
    // against, and calling it deaf on its first hour would page the owner
    // about every signup.
    const prev: FleetSample = { a: inst("open", 100) };
    const next: FleetSample = { a: inst("open", 100), b: inst("open", 5) };
    expect(deafInstances(prev, next, 12)).toEqual(["a"]);
  });

  it("reports every deaf instance, in a stable order", () => {
    const prev: FleetSample = { z: inst("open", 7), a: inst("open", 100) };
    const next: FleetSample = { z: inst("open", 7), a: inst("open", 100) };
    expect(deafInstances(prev, next, 30)).toEqual(["a", "z"]);
  });
});

describe("the sensor is connected, and says so when it cannot see", () => {
  const rollup = readCode("src/lib/wa/risk-rollup.ts");

  it("the kind the dashboard already sums is now actually written", () => {
    expect(RISK_KINDS).toContain("session_deaf");
    expect(rollup).toMatch(/kind: "session_deaf"/);
    expect(rollup).toMatch(/deaf: sum\(buckets, "session_deaf"\)/);
  });

  it("the rollup carries its own prior forward - there is nowhere else to keep it", () => {
    expect(rollup).toMatch(/snap\.fleet = sample/);
    expect(rollup).toMatch(/priorFleetSample\(/);
    expect(readCode("supabase/schema.sql")).toMatch(
      /add column if not exists fleet jsonb/
    );
  });

  it("every way of not knowing DARKENS instead of reporting no deaf sessions", () => {
    // The whole point. An unreadable fleet, a missing prior and an unreadable
    // send count each produce a named dark signal; none of them produce an
    // empty result that renders as good news.
    for (const s of ["deaf:fleet-unreadable", "deaf:no-prior", "deaf:sends-unreadable"]) {
      expect(rollup, `${s} is not raised`).toContain(s);
    }
    // And an empty prior is treated as NO prior, not as an empty comparison.
    expect(rollup).toMatch(/Object\.keys\(f\)\.length > 0 \? f : undefined/);
  });

  it("a flat count is only deaf if we were sending, and the send count is real", () => {
    expect(rollup).toMatch(/outboundInWindow\(/);
    expect(rollup).toMatch(/direction=eq\.outbound/);
  });

  it("the pass can never cost the bucket its own numbers", () => {
    // The rollup's job is the event aggregate. A fleet probe that threw and
    // took the hour with it would trade a working sensor for a broken one.
    const at = rollup.indexOf("const { fleetTruth } = await import");
    expect(at).toBeGreaterThan(0);
    expect(rollup.slice(at - 200, at)).toMatch(/try \{/);
  });
});
