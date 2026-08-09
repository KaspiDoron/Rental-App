import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

let inserts: { table: string; rows: Record<string, unknown>[] }[] = [];
let insertThrows = false;

vi.mock("../runtime-config", () => ({
  sbInsert: async (table: string, rows: Record<string, unknown>[]) => {
    inserts.push({ table, rows });
    if (insertThrows) throw new Error("db down");
    return true;
  },
}));

import { recordPolicyChange, isSafetyPolicy } from "./policy-versions";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

beforeEach(() => {
  inserts = [];
  insertThrows = false;
});

// THE GOVERNANCE WAS EXACTLY INVERTED.
//
// Negotiation policy: versioned, golden-replay gated, one-click rollbackable,
// owner-only. Worst case, a bad haggle.
// whatsapp_security_policies: a bare upsert from any management session, no
// version, no author, no previous value, no undo. Worst case, a traveller loses
// their personal WhatsApp account.

describe("what the audit row carries", () => {
  it("writes who, when, from what, to what", async () => {
    await recordPolicyChange({ key: "min_gap_seconds", from: "12", to: "20" }, "owner@x.com", "slower");
    const row = inserts.find((i) => i.table === "wa_policy_versions")!.rows[0];
    expect(row.author_email).toBe("owner@x.com");
    expect(row.changes).toEqual({ key: "min_gap_seconds", from: "12", to: "20" });
    expect(row.note).toBe("slower");
    expect(typeof row.version).toBe("string");
  });

  it("THE PREVIOUS VALUE IS THE HALF THAT MATTERS", async () => {
    // Without `from`, the row says what the knob became and not what it was -
    // which makes both a revert and a before/after comparison impossible.
    await recordPolicyChange({ key: "k", from: null, to: "on" }, null);
    const row = inserts[0].rows[0] as { changes: { from: unknown } };
    // null means the key had no override row: the CODE DEFAULT was in force,
    // which is a real state and not the same as an empty string.
    expect(row.changes.from).toBeNull();
  });

  it("an unattributed change still records", async () => {
    // A change with nobody's name on it is still infinitely more useful than no
    // record at all, so a missing author must never suppress the row.
    expect(await recordPolicyChange({ key: "k", from: "a", to: "b" }, null)).toBe(true);
  });

  it("also lands on the risk ledger, so behaviour and consequence share a stream", async () => {
    // Two tables that have to be joined by eye during an incident are two
    // tables nobody joins.
    await recordPolicyChange({ key: "k", from: "a", to: "b" }, "o@x.com");
    const risk = inserts.find((i) => i.table === "wa_risk_events");
    expect(risk).toBeDefined();
    expect(risk!.rows[0].kind).toBe("policy_changed");
    // The two rows carry the SAME version, or the join is by timestamp luck.
    expect(risk!.rows[0].policy_version).toBe(
      (inserts.find((i) => i.table === "wa_policy_versions")!.rows[0] as { version: string }).version
    );
  });

  it("never throws, and refuses an empty key", async () => {
    insertThrows = true;
    await expect(recordPolicyChange({ key: "k", from: null, to: "v" }, null)).resolves.toBe(false);
    insertThrows = false;
    expect(await recordPolicyChange({ key: "  ", from: null, to: "v" }, null)).toBe(false);
  });
});

describe("which keys are audited", () => {
  it("is INCLUSIVE - an unrecognised key is treated as safety-relevant", () => {
    // Over-recording costs a row. Under-recording is the gap this exists to
    // close, so the default has to lean the other way.
    expect(isSafetyPolicy("something_nobody_added_yet")).toBe(true);
    expect(isSafetyPolicy("min_gap_seconds")).toBe(true);
    expect(isSafetyPolicy("fast_dispatch")).toBe(true);
  });

  it("only provably cosmetic prefixes are exempt", () => {
    expect(isSafetyPolicy("ui_theme")).toBe(false);
    expect(isSafetyPolicy("label_queue")).toBe(false);
    expect(isSafetyPolicy("")).toBe(false);
  });
});

describe("setPolicy is wired to it", () => {
  const guard = readCode("src/lib/wa-guard.ts");
  const route = readCode("src/app/api/admin/wa-security/route.ts");

  it("reads the current value BEFORE overwriting it", () => {
    expect(guard).toMatch(/select=id,value&key=eq\./);
    expect(guard).toMatch(/const previous = rows\[0\]\?\.value \?\? null;/);
  });

  it("records only a real change", () => {
    expect(guard).toMatch(/if \(previous !== value\)/);
    expect(guard).toMatch(/recordPolicyChange\(\{ key, from: previous, to: value \}/);
  });

  it("THE AUTHOR COMES FROM THE SERVER SESSION, never the request body", () => {
    // A client naming its own author would make the one field the record exists
    // to establish the one field we could not trust.
    expect(route).toMatch(/setPolicy\(key, verdict\.normalized, session\.email/);
    expect(route).not.toMatch(/setPolicy\([^)]*body\.(author|email)/);
  });

  it("the audit write is AWAITED - Cloud Run throttles CPU at response flush", () => {
    expect(guard).toMatch(/await recordPolicyChange\(/);
  });
});
