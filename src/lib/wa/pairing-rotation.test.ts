import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// THE ONE-TIME CODE THAT FAILED ON THE FIRST TRY (W-5, the owner's item 5).
//
// `PAIRING_TTL_MS` is 55 seconds and it is OUR number. The credential is minted
// by Baileys inside the Evolution container, rotated by Baileys on Baileys'
// timer, and `QRCODE_UPDATED` - the event that announces the rotation - was not
// in `WEBHOOK_EVENTS`. So the app was structurally unable to learn that the code
// on the traveller's screen had been replaced.
//
// The client's behaviour makes that fatal rather than merely imprecise: it
// renders one code, counts down from the TTL the server handed it, and only
// asks for a replacement AFTER the countdown lapses plus a grace period. Between
// t=0 and t=55s it never re-checks. A rotation inside that window strands a dead
// code on screen under a countdown that still says it is fine.
//
// What the owner saw follows exactly: type the code, "incorrect", tap Try again
// - which re-polls `/instance/connect` and gets the current code - and it works.

describe("REPRODUCTION: the rotation was unobservable", () => {
  const evolution = readCode("src/lib/evolution.ts");

  it("the app subscribes to the event that announces a new code", () => {
    const set = /const WEBHOOK_EVENTS = \[([\s\S]*?)\] as const;/.exec(evolution);
    expect(set, "the event set moved").toBeTruthy();
    expect(set![1]).toContain("QRCODE_UPDATED");
  });

  it("...alongside the events it already needed, not instead of them", () => {
    const set = /const WEBHOOK_EVENTS = \[([\s\S]*?)\] as const;/.exec(evolution)![1];
    for (const e of ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "CONNECTION_UPDATE", "CALL"]) {
      expect(set, `${e} was dropped`).toContain(e);
    }
  });

  it("every create/re-arm path uses the shared set, so none can lag behind", () => {
    // A literal event array at one create site is how a whole cohort of users
    // once paired with only MESSAGES_UPSERT and never got a delivery receipt.
    expect(evolution.match(/\[\.\.\.WEBHOOK_EVENTS\]/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });
});

describe("a rotation re-anchors the window", () => {
  const ingest = readCode("src/lib/wa/ingest.ts");
  const evolution = readCode("src/lib/evolution.ts");

  it("the webhook handles it", () => {
    expect(ingest).toMatch(/event\.includes\("qrcode\.updated"\)/);
    expect(ingest).toMatch(/notePairingRotation\(who\.email\)/);
  });

  it("the stamp it writes is the one the countdown is measured from", () => {
    // The whole point: connectInstance computes `codeAgeMs` from
    // `pairing_code_issued_at`. Re-stamping on rotation is what makes the
    // remaining life describe the code actually on screen.
    expect(evolution).toMatch(/pairing_code_issued_at: new Date\(\)\.toISOString\(\)/);
    expect(evolution).toMatch(/const issued = row\[0\]\?\.pairing_code_issued_at/);
    expect(evolution).toMatch(/codeAgeMs < PAIRING_TTL_MS/);
  });

  it("it re-stamps ONLY the stamp - a rotation is not a connection state", () => {
    const fn = /export async function notePairingRotation[\s\S]*?\n\}/.exec(evolution);
    expect(fn, "notePairingRotation moved").toBeTruthy();
    expect(fn![0]).not.toMatch(/status:/);
    expect(fn![0]).toMatch(/pairing_code_issued_at/);
  });

  it("an unresolvable instance asks again rather than dropping the signal", () => {
    // Same rule the receipts branch follows: unresolvable is not proof the
    // event is somebody else's, and a dropped rotation is a stranded code.
    const at = ingest.indexOf('event.includes("qrcode.updated")');
    expect(ingest.slice(at, at + 600)).toMatch(/if \(!who\.ok\) return \{ retryable: true \}/);
  });

  it("a failed stamp never breaks the link", () => {
    const fn = /export async function notePairingRotation[\s\S]*?\n\}/.exec(evolution)![0];
    expect(fn).toMatch(/catch/);
  });

  it("the rotation stamp OUTRANKS a generic row touch", () => {
    // `updated_at` moves for any write to the session row - a status change, a
    // proxy stamp - none of which mint a code. Falling back to it is fine when
    // there is no stamp at all, but it must never win over one.
    expect(evolution).toMatch(
      /row\[0\]\?\.pairing_code_issued_at \?\? row\[0\]\?\.updated_at/
    );
  });
});
