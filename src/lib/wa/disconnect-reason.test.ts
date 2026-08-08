import { describe, it, expect } from "vitest";
import {
  classifyDisconnect,
  disconnectReasonFrom,
  DISCONNECT_REASONS,
} from "./disconnect-reason";

const NOW = Date.parse("2026-08-08T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe("REPRODUCTION: the old word-matching detector could never fire", () => {
  // The shipped predicate, verbatim from ingest.ts before this change.
  const oldDetector = (raw: unknown) =>
    /logged.?out|conflict|banned|forbidden|multidevice.?mismatch/.test(
      String(raw ?? "").toLowerCase()
    );

  it.each([401, 403, 411, 440])("statusReason %i matched no word", (code) => {
    expect(oldDetector(code)).toBe(false);
  });

  it("and the new classifier reads every one of them", () => {
    for (const code of [401, 403, 411, 440]) {
      expect(classifyDisconnect(code, { now: NOW }).code).toBe(code);
      expect(classifyDisconnect(code, { now: NOW }).label).not.toBe("unknown");
    }
  });
});

describe("a genuine logout kills the session", () => {
  it("401 outside the pairing window is terminal", () => {
    const v = classifyDisconnect(401, { pairingIssuedAt: iso(10 * 60_000), now: NOW });
    expect(v.label).toBe("loggedOut");
    expect(v.severity).toBe("terminal");
    expect(v.sessionDead).toBe(true);
  });

  it("401 with no pairing stamp at all is terminal", () => {
    expect(classifyDisconnect(401, { now: NOW }).sessionDead).toBe(true);
  });

  it("403 is enforcement - terminal AND ban-risk", () => {
    const v = classifyDisconnect(403, { now: NOW });
    expect(v.severity).toBe("enforcement");
    expect(v.sessionDead).toBe(true);
    expect(v.banRisk).toBe(true);
  });

  it("411 multideviceMismatch is terminal but not ban-risk", () => {
    const v = classifyDisconnect(411, { now: NOW });
    expect(v.sessionDead).toBe(true);
    expect(v.banRisk).toBe(false);
  });
});

describe("the pairing handshake is NOT a ban - this exemption is load-bearing", () => {
  // Evolution emits a 401 close as an ordinary beat of the pairing-code
  // handshake. Treating it as a logout would pause a number the instant it
  // links, which is worse than the bug being fixed.
  it("401 seconds into pairing is transient, not dead", () => {
    const v = classifyDisconnect(401, { pairingIssuedAt: iso(5_000), now: NOW });
    expect(v.severity).toBe("transient");
    expect(v.sessionDead).toBe(false);
  });

  it("401 just inside the grace window is still transient", () => {
    const v = classifyDisconnect(401, { pairingIssuedAt: iso(119_000), now: NOW });
    expect(v.sessionDead).toBe(false);
  });

  it("401 just outside it is terminal", () => {
    const v = classifyDisconnect(401, { pairingIssuedAt: iso(121_000), now: NOW });
    expect(v.sessionDead).toBe(true);
  });

  it("a future pairing stamp is clock skew, not a live handshake", () => {
    const v = classifyDisconnect(401, { pairingIssuedAt: iso(-60_000), now: NOW });
    expect(v.sessionDead).toBe(true);
  });

  it("515 restartRequired is always handshake churn", () => {
    expect(classifyDisconnect(515, { now: NOW }).sessionDead).toBe(false);
  });
});

describe("transient causes must never tear down a working link", () => {
  it.each([408, 428, 440, 500, 503, 515])("%i is transient", (code) => {
    const v = classifyDisconnect(code, { now: NOW });
    expect(v.severity).toBe("transient");
    expect(v.sessionDead).toBe(false);
    expect(v.banRisk).toBe(false);
  });

  it("440 connectionReplaced does NOT kill our row - another socket took the identity", () => {
    // Tearing down here fights the other socket rather than fixing anything,
    // and our own failover is a known source of double sockets.
    expect(classifyDisconnect(440, { now: NOW }).sessionDead).toBe(false);
  });
});

describe("an unreadable cause is UNKNOWN, never dead", () => {
  // The mirror-image failure: logging users out on a malformed webhook would
  // be a worse bug than the one this replaces.
  it.each([null, undefined, "", "something went wrong", {}, [], NaN])(
    "%s -> unknown, not dead",
    (raw) => {
      const v = classifyDisconnect(raw, { now: NOW });
      expect(v.severity).toBe("unknown");
      expect(v.sessionDead).toBe(false);
      expect(v.banRisk).toBe(false);
    }
  );
});

describe("codes arrive in more than one shape", () => {
  it("reads the numeric string form", () => {
    expect(classifyDisconnect("403", { now: NOW }).banRisk).toBe(true);
  });

  it("reads the word form some builds emit", () => {
    expect(classifyDisconnect("loggedOut", { now: NOW }).code).toBe(401);
    expect(classifyDisconnect("forbidden", { now: NOW }).code).toBe(403);
  });

  it("reads a Boom-ish payload object", () => {
    expect(classifyDisconnect({ output: { statusCode: 401 } }, { now: NOW }).code).toBe(401);
    expect(classifyDisconnect({ statusCode: 403 }, { now: NOW }).code).toBe(403);
  });

  it("an unmapped code is labelled, not swallowed", () => {
    const v = classifyDisconnect(499, { now: NOW });
    expect(v.code).toBe(499);
    expect(v.label).toBe("code-499");
    expect(v.sessionDead).toBe(false);
  });
});

describe("disconnectReasonFrom digs the cause out of the payload shapes", () => {
  it("prefers the top-level statusReason Evolution sends", () => {
    expect(disconnectReasonFrom({ statusReason: 401 })).toBe(401);
  });

  it("falls back through lastDisconnect when present", () => {
    expect(
      disconnectReasonFrom({ lastDisconnect: { error: { output: { statusCode: 403 } } } })
    ).toBe(403);
  });

  it("returns null for a payload with no cause", () => {
    expect(disconnectReasonFrom({ state: "close" })).toBeNull();
    expect(disconnectReasonFrom(null)).toBeNull();
  });
});

describe("the taxonomy covers what Baileys actually emits", () => {
  it.each([401, 403, 408, 411, 428, 440, 500, 515])("%i has a name", (code) => {
    expect(DISCONNECT_REASONS[code as keyof typeof DISCONNECT_REASONS]).toBeTruthy();
  });
});
