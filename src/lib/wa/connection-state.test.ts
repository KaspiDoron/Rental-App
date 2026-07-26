import { describe, it, expect } from "vitest";
import {
  deriveConnectionPhase,
  isFrozen,
  isIdle,
  phaseHeadline,
  type ConnectionPhase,
} from "./connection-state";

describe("deriveConnectionPhase", () => {
  it("CONNECTED wins over everything, including a stale error", () => {
    expect(deriveConnectionPhase({ state: "open" })).toBe("CONNECTED");
    // A durable pairing survives a socket blip.
    expect(deriveConnectionPhase({ state: "connecting", paired: true })).toBe("CONNECTED");
    // An error left over from an earlier attempt must not mask a live link.
    expect(deriveConnectionPhase({ state: "open", failed: true, hostDown: true })).toBe(
      "CONNECTED"
    );
  });

  it("reports FAILED for a terminal give-up or a down host", () => {
    expect(deriveConnectionPhase({ failed: true })).toBe("FAILED");
    expect(deriveConnectionPhase({ hostDown: true })).toBe("FAILED");
    // hostDown outranks a credential that is still on screen but now useless.
    expect(
      deriveConnectionPhase({ hasCredential: true, credentialMsLeft: 30_000, hostDown: true })
    ).toBe("FAILED");
  });

  it("SCAN_PENDING while the shown code still has life", () => {
    expect(
      deriveConnectionPhase({ state: "connecting", hasCredential: true, credentialMsLeft: 30_000 })
    ).toBe("SCAN_PENDING");
  });

  it("flips to AUTHENTICATING once the shown code lapses", () => {
    expect(
      deriveConnectionPhase({ state: "connecting", hasCredential: true, credentialMsLeft: 0 })
    ).toBe("AUTHENTICATING");
  });

  it("AUTHENTICATING when the handshake outlived its credential", () => {
    expect(deriveConnectionPhase({ state: "connecting", hasCredential: false })).toBe(
      "AUTHENTICATING"
    );
  });

  it("GENERATING_QR only while a request is in flight with nothing on screen", () => {
    expect(deriveConnectionPhase({ requesting: true })).toBe("GENERATING_QR");
    // A credential already on screen outranks an in-flight refresh.
    expect(
      deriveConnectionPhase({ requesting: true, hasCredential: true, credentialMsLeft: 10_000 })
    ).toBe("SCAN_PENDING");
  });

  it("DISCONNECTED is the resting state", () => {
    expect(deriveConnectionPhase({})).toBe("DISCONNECTED");
    expect(deriveConnectionPhase({ state: "disconnected" })).toBe("DISCONNECTED");
    expect(deriveConnectionPhase({ state: "unknown" })).toBe("DISCONNECTED");
  });

  it("walks the full happy path exactly once through each phase", () => {
    const seen: ConnectionPhase[] = [
      deriveConnectionPhase({ state: "disconnected" }),
      deriveConnectionPhase({ requesting: true }),
      deriveConnectionPhase({ state: "connecting", hasCredential: true, credentialMsLeft: 40_000 }),
      deriveConnectionPhase({ state: "connecting", hasCredential: true, credentialMsLeft: 0 }),
      deriveConnectionPhase({ state: "open" }),
    ];
    expect(seen).toEqual([
      "DISCONNECTED",
      "GENERATING_QR",
      "SCAN_PENDING",
      "AUTHENTICATING",
      "CONNECTED",
    ]);
  });

  it("never yields a code-visible phase and a failure at the same time", () => {
    // The exact contradiction seen in production: a code on screen AND a
    // "server didn't hand out a code" error. Exactly one phase must win.
    const phase = deriveConnectionPhase({
      state: "connecting",
      hasCredential: true,
      credentialMsLeft: 20_000,
      failed: true,
    });
    expect(phase).toBe("FAILED");
    expect(phase === "SCAN_PENDING").toBe(false);
  });
});

describe("isFrozen / isIdle", () => {
  it("freezes regeneration once verifying or connected", () => {
    expect(isFrozen("AUTHENTICATING")).toBe(true);
    expect(isFrozen("CONNECTED")).toBe(true);
    expect(isFrozen("SCAN_PENDING")).toBe(false);
    expect(isFrozen("GENERATING_QR")).toBe(false);
  });

  it("treats only the resting states as idle", () => {
    expect(isIdle("DISCONNECTED")).toBe(true);
    expect(isIdle("FAILED")).toBe(true);
    expect(isIdle("SCAN_PENDING")).toBe(false);
  });
});

describe("phaseHeadline", () => {
  it("gives every phase exactly one non-empty sentence", () => {
    const phases: ConnectionPhase[] = [
      "DISCONNECTED",
      "GENERATING_QR",
      "SCAN_PENDING",
      "AUTHENTICATING",
      "CONNECTED",
      "FAILED",
    ];
    const lines = phases.map(phaseHeadline);
    expect(lines.every((l) => l.length > 0)).toBe(true);
    // No two phases share a headline - the user can always tell them apart.
    expect(new Set(lines).size).toBe(phases.length);
  });
});
