import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// THE RESTRICTION SIGNAL WAS ALREADY ARRIVING, AND WE THREW IT AWAY.
//
// WhatsApp's scoped new-chat restriction surfaces as an Evolution
// `messages.update` carrying status:"ERROR" on a `fromMe` key. The ingest loop
// read READ and DELIVERY and returned, so the only ground-truth evidence that
// this number is being refused never reached any code. Five rounds of research
// concluded we had no restriction detector and would need to build one; in fact
// the sensor was on the wire the whole time.
//
// These are structural assertions rather than a live webhook drive, because the
// property that matters is a LANE ASYMMETRY that is easy to "simplify" away:
// the cold lane holds, the reply lane must not.

describe("the ingest handles the error ack it used to discard", () => {
  const ingest = readCode("src/lib/wa/ingest.ts");

  it("messages.update has an ERROR branch alongside READ and DELIVERY", () => {
    expect(ingest).toMatch(/status\.includes\("ERROR"\)/);
  });

  it("it classifies the lane before recording - a bare counter would be useless", () => {
    expect(ingest).toMatch(/hasInboundFrom\(/);
    expect(ingest).toMatch(/firstContact:\s*!established/);
  });

  it("REGRESSION: the READ and DELIVERY branches still fire", () => {
    expect(ingest).toMatch(/recordReadReceipt\(/);
    expect(ingest).toMatch(/recordDelivery\(/);
  });
});

describe("only the COLD lane is held - this asymmetry is the point", () => {
  const guard = readCode("src/lib/wa-guard.ts");

  it("recordSendError sets cold_hold_until only for a first contact", () => {
    const fn = guard.slice(
      guard.indexOf("export async function recordSendError"),
      guard.indexOf("export async function hasInboundFrom")
    );
    expect(fn).toMatch(/if\s*\(opts\.firstContact\)/);
    expect(fn).toMatch(/cold_hold_until/);
  });

  it("the guard consults cold_hold_until ONLY on rfq sends", () => {
    // A hold that applied to every send would starve replies - and a reply is
    // the one action that clears the unanswered-thread counter the restriction
    // actually meters, so holding it deepens the condition being punished.
    const idx = guard.indexOf("cold_hold_until &&");
    expect(idx).toBeGreaterThan(0);
    const window = guard.slice(idx - 300, idx + 300);
    expect(window).toMatch(/opts\.meta\?\.kind === "rfq"/);
  });

  it("cold_hold_until is READ, not just written - no write-only columns", () => {
    // The repo has a live example of the opposite (the I18N_ cache is written
    // by a writer no reader can ever query), so this is worth pinning.
    expect(guard).toMatch(/rep\.cold_hold_until/);
    expect(guard).toMatch(/cold_hold_until,risk_score/);
  });

  it("hasInboundFrom fails to ESTABLISHED so a DB blip cannot invent a hold", () => {
    const fn = guard.slice(
      guard.indexOf("export async function hasInboundFrom"),
      guard.indexOf("export async function recordSendFailure")
    );
    // The catch must return true (established), never false (cold).
    expect(fn).toMatch(/catch\s*\{[\s\S]*?return true;/);
  });
});

describe("a dead session is finally writable", () => {
  const evo = readCode("src/lib/evolution.ts");
  const ingest = readCode("src/lib/wa/ingest.ts");

  it('markClosed exists and writes the "close" status nothing ever wrote', () => {
    expect(evo).toMatch(/export async function markClosed/);
    expect(evo).toMatch(/saveSession\(email, instanceNameFor\(email\), "close"\)/);
  });

  it("the ingest routes connection.update through the numeric classifier", () => {
    expect(ingest).toMatch(/classifyDisconnect\(/);
    expect(ingest).toMatch(/disconnectReasonFrom\(/);
  });

  it("REGRESSION: the word-matching regex that could never fire is gone", () => {
    expect(ingest).not.toMatch(/logged\.\?out\|conflict\|banned/);
  });

  it("a transient close returns early instead of tearing the session down", () => {
    expect(ingest).toMatch(/if\s*\(!verdict\.sessionDead\)/);
  });

  it("ban-recovery is strictly narrower than session-dead", () => {
    // 401 loggedOut kills the session but is not necessarily enforcement - the
    // user may simply have tapped "log out from linked devices".
    expect(ingest).toMatch(/if\s*\(verdict\.banRisk\)/);
  });

  it("the pairing-handshake exemption survives - it is why 401 is ambiguous", () => {
    expect(ingest).toMatch(/pairingStampFor\(/);
    expect(ingest).toMatch(/pairingIssuedAt/);
  });
});
