import { describe, it, expect } from "vitest";
import {
  applyIfNewer,
  optimisticVersion,
  cacheIsStale,
  UNKNOWN_VERSION,
  type Versioned,
} from "./versioned";

const at = (value: boolean, version: number): Versioned<boolean> => ({ value, version });

describe("the client only ever moves forward", () => {
  it("adopts a strictly newer answer", () => {
    expect(applyIfNewer(at(true, 100), at(false, 200))).toEqual(at(false, 200));
  });

  it("DROPS an older answer - the whole resume-flickers-back bug", () => {
    // The user resumed (version 200). A poll answered by another instance still
    // holding the pre-resume value in its 30s cache reports version 100. That
    // answer is not wrong, it is old - and it must not be applied.
    const applied = at(false, 200);
    expect(applyIfNewer(applied, at(true, 100))).toBe(applied);
  });

  it("DROPS an equal answer, so an in-flight optimistic flip survives", () => {
    const applied = at(false, 200);
    expect(applyIfNewer(applied, at(true, 200))).toBe(applied);
  });

  it("takes anything when nothing has been applied yet", () => {
    expect(applyIfNewer(null, at(true, 5))).toEqual(at(true, 5));
  });

  it("ignores a versionless or absent answer rather than trusting it", () => {
    const applied = at(true, 10);
    expect(applyIfNewer(applied, null)).toBe(applied);
    expect(applyIfNewer(applied, undefined)).toBe(applied);
    expect(applyIfNewer(applied, at(false, Number.NaN))).toBe(applied);
  });
});

describe("an optimistic flip outranks the past, not the server", () => {
  const NOW = 1_800_000_000_000;

  it("beats every answer that predates the write", () => {
    const applied = at(true, NOW - 30_000); // a value cached 30s ago
    const optimistic = at(false, optimisticVersion(applied, NOW));
    expect(applyIfNewer(optimistic, at(true, NOW - 30_000))).toBe(optimistic);
    expect(applyIfNewer(optimistic, at(true, NOW - 1_000))).toBe(optimistic);
  });

  it("is still overridden by the server's own confirmation", () => {
    // The server stamps its answer from the durable record at write time, so it
    // is at least `now` - strictly above the optimistic version.
    const applied = at(true, NOW - 30_000);
    const optimistic = at(false, optimisticVersion(applied, NOW));
    expect(applyIfNewer(optimistic, at(false, NOW))).toEqual(at(false, NOW));
  });

  it("never goes backwards from an already-newer applied version", () => {
    const applied = at(true, NOW + 5_000); // clock skew: applied is ahead
    expect(optimisticVersion(applied, NOW)).toBe(NOW + 5_000);
  });
});

describe("a per-instance cache cannot serve a version the caller already passed", () => {
  it("is stale when the cached version is older than what the caller has seen", () => {
    expect(cacheIsStale(100, 200)).toBe(true);
    expect(cacheIsStale(undefined, 200)).toBe(true);
  });

  it("is fresh when it is at least as new", () => {
    expect(cacheIsStale(200, 200)).toBe(false);
    expect(cacheIsStale(300, 200)).toBe(false);
  });

  it("a caller with no known version never invalidates anything", () => {
    expect(cacheIsStale(100, undefined)).toBe(false);
    expect(cacheIsStale(100, UNKNOWN_VERSION)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// THE WIRING.
// ---------------------------------------------------------------------------

import { readFileSync } from "fs";
import { join } from "path";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("the pause switch is versioned end to end", () => {
  it("the server stamps a version on both the write and the read", () => {
    const flags = readCode("src/lib/session-flags.ts");
    expect(flags).toMatch(/sessionPauseState/);
    expect(flags).toMatch(/cacheIsStale\(hit\.version, knownVersion\)/);
    const route = readCode("src/app/api/session/pause/route.ts");
    expect(route).toMatch(/version/);
    expect(route).toMatch(/known/);
  });

  it("the poll carries the version alongside the value", () => {
    const activity = readCode("src/app/api/activity/route.ts");
    expect(activity).toMatch(/sessionPausedVersion/);
    expect(activity).toMatch(/sessionPauseState\(email/);
  });

  it("the switch follows the poll BY VERSION, never by a busy flag", () => {
    const sw = readCode("src/components/AgentKillSwitch.tsx");
    expect(sw).toMatch(/useVersionedToggle/);
    expect(sw).toMatch(/serverPausedVersion/);
    // The old shape - an effect with `busy` in its dependencies - re-applied the
    // pre-write poll value the instant the write finished.
    expect(sw).not.toMatch(/\[serverPaused, busy\]/);
    const hook = readCode("src/lib/client/versioned-toggle.ts");
    expect(hook).toMatch(/applyIfNewer/);
    // The follow-the-poll effect depends on the VALUE and its VERSION - and on
    // nothing about whether a write is in flight. `busy` in there is precisely
    // what made a finished write replay the pre-write value.
    expect(hook).toMatch(/\[incomingValue, incomingVersion, adopt\]/);
  });

  it("the page applies a poll value only when its version is newer", () => {
    const page = readCode("src/app/page.tsx");
    expect(page).toMatch(/sessionPausedVersion/);
    expect(page).toMatch(/if \(v && v <= prev\) return prev/);
  });
});
