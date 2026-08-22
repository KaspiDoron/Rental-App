import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// OWNER REPORT 8, A1 - THE WORST DEFECT THIS CODEBASE HAD.
//
// WhatsApp closes a session with 401 (the ordinary shape of a restriction).
// ingest calls markClosed and writes wa_sessions.status = "close". But NO send
// path read that column, so the guard kept allowing rows, sendFromUser kept
// calling ensureConnected, and ensureConnected fires instance/create +
// instance/connect unconditionally - a fresh device registration against the
// number WhatsApp just severed - re-parked as "transient" every 45-120s for
// 24 HOURS. ANTI-BAN.md's first runbook line is "every attempt during a
// restriction is a fresh strike".

describe("a disconnected link stops the send path dead", () => {
  const guard = read("src/lib/wa-guard.ts");

  it("THE REGRESSION: guardOutbound reads wa_sessions.status", () => {
    // Before this fix the ONLY wa_sessions read in the whole file was inside a
    // diagnostic - never a gate.
    expect(guard).toMatch(/sbSelectStrict<\{ status: string \| null \}>\(\s*"wa_sessions"/);
    expect(guard).toMatch(/link\.rows\[0\]\?\.status === "close"/);
  });

  it("an automated send PARKS - the traveller's message is not lost", () => {
    const gate = guard.slice(guard.indexOf("0.a THE LINK IS DEAD"));
    expect(gate.slice(0, 2600)).toMatch(/whatsapp link is disconnected/);
    expect(gate.slice(0, 2600)).toMatch(/jitteredHold\(now, 30, 10\)/);
  });

  it("...and it never reaches the transport, which is the whole point", () => {
    // The gate must sit BEFORE the pacing/claim machinery that ends in
    // sendFromUser -> ensureConnected -> instance/create.
    const gateAt = guard.indexOf('link.rows[0]?.status === "close"');
    const claimAt = guard.indexOf("claimSendSlots");
    expect(gateAt).toBeGreaterThan(0);
    expect(claimAt).toBeGreaterThan(0);
    expect(gateAt, "the dead-link gate must precede the send claim").toBeLessThan(claimAt);
  });

  it("a MANUAL send gets an honest refusal, not a silent park", () => {
    const gate = guard.slice(guard.indexOf("0.a THE LINK IS DEAD"));
    expect(gate.slice(0, 3400)).toMatch(/reconnect it and this will send/);
  });

  it("FAILS OPEN on an unreadable row - an outage must not freeze a good number", () => {
    // `"rows" in link` is the fail-open: an { error } result skips the gate.
    const gate = guard.slice(guard.indexOf("0.a THE LINK IS DEAD"));
    expect(gate.slice(0, 2600)).toMatch(/if \("rows" in link &&/);
  });

  it("it does NOT invent a ban from a deliberate unlink", () => {
    // The tempting fix - forcing banRisk:true on any non-pairing 401 - would
    // punish "log out from linked devices" with a 24h recovery. The honest
    // statement is narrower and true for both causes.
    const dis = read("src/lib/wa/disconnect-reason.ts");
    const four01 = dis.slice(dis.indexOf("if (code === 401)"));
    expect(four01.slice(0, 700)).toMatch(/banRisk: false/);
  });
});

describe("a failed resume feeds the risk engine instead of vanishing", () => {
  it("THE SILENT TELEMETRY: a paired-but-unreachable send records a hard outcome", () => {
    const evo = read("src/lib/evolution.ts");
    const block = evo.slice(evo.indexOf("const conn = await ensureConnected(email, 6000)"));
    expect(block.slice(0, 1800)).toMatch(/noteSendOutcome\(email, "hard"\)/);
    // ...and only when the user is actually paired - an unlinked user failing
    // to connect is not a risk signal.
    expect(block.slice(0, 1800)).toMatch(/if \(paired\) \{/);
  });

  it("the stop-loss it feeds is the 3-hard-fails breaker", () => {
    const guard = read("src/lib/wa-guard.ts");
    expect(guard).toMatch(/export async function noteSendOutcome/);
    expect(guard).toMatch(/outcome: "ok" \| "soft" \| "hard"/);
  });
});
