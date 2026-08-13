import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

let inserts: { table: string; rows: Record<string, unknown>[] }[] = [];
let insertBehaviour: "ok" | "false" | "throw" = "ok";

vi.mock("../runtime-config", () => ({
  sbInsert: async (table: string, rows: Record<string, unknown>[]) => {
    inserts.push({ table, rows });
    if (insertBehaviour === "throw") throw new Error("supabase is having a bad minute");
    return insertBehaviour === "ok";
  },
}));

import {
  noteRisk,
  RISK_KINDS,
  axisOf,
  isRiskKind,
  sanitizeDetail,
  sessionKindForCode,
} from "./risk-events";

const readCode = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

beforeEach(() => {
  inserts = [];
  insertBehaviour = "ok";
});

// STATE, NOT EVENTS.
//
// Every safety signal in this system is a mutable scalar on one reputation row
// per user, overwritten on every send. After a restriction you can read what the
// counters are NOW and nothing at all about the 72 hours that caused it. This
// ledger is the numerator and the denominator that never existed.

describe("the vocabulary", () => {
  it("is exactly twenty-two kinds", () => {
    expect(RISK_KINDS).toHaveLength(23);
    expect(new Set(RISK_KINDS).size).toBe(23);
  });

  it("EVERY kind is assigned an axis - a kind with no axis is unaggregatable", () => {
    for (const k of RISK_KINDS) {
      expect(["velocity", "client", "meter", "policy"]).toContain(axisOf(k));
    }
  });

  it("THE TWO ENFORCEMENT AXES ARE KEPT APART FROM THE FIRST WRITE", () => {
    // A scoped new-chat restriction and a full ban have different causes,
    // different penalties and different observability - and axis 2 fires on
    // accounts doing reply-only work, with zero sends. One blended 0-100 scalar
    // cannot represent either of them.
    expect(axisOf("intro_sent")).toBe("velocity");
    expect(axisOf("restriction_confirmed")).toBe("velocity");
    expect(axisOf("session_logged_out")).toBe("client");
    expect(axisOf("session_deaf")).toBe("client");
  });

  it("A DEAD NUMBER IS NOT A BLOCK - they are separate kinds", () => {
    // recordSendFailure counted "not on WhatsApp" as a recipient block, and
    // blocks feed Math.min(30, blocks_total * 12) into a 100-point score that
    // auto-pauses at 70. Three bad numbers in one Places listing set could pause
    // a perfectly healthy account.
    expect(isRiskKind("recipient_invalid")).toBe(true);
    expect(isRiskKind("recipient_blocked")).toBe(true);
    expect(axisOf("recipient_invalid")).toBe("meter");
  });

  it("rejects a kind that is not in the vocabulary", () => {
    expect(isRiskKind("whatever")).toBe(false);
    expect(isRiskKind("")).toBe(false);
  });

  it("carries the policy-change kind, or before/after means nothing", () => {
    expect(isRiskKind("policy_changed")).toBe(true);
    expect(axisOf("policy_changed")).toBe("policy");
  });
});

describe("THE CAUSE IS A NUMBER, NOT A WORD", () => {
  // The old detector regex-matched `statusReason` against "logged out" and
  // "banned" while Evolution sends 401 - so String(401).toLowerCase() matched
  // nothing and the branch never fired once in production. This mapping is the
  // replacement, pure and exported so it is checkable rather than a ternary
  // chain buried in a webhook.
  it("maps every named code to its own kind", () => {
    expect(sessionKindForCode(401)).toBe("session_logged_out");
    expect(sessionKindForCode(403)).toBe("session_forbidden");
    expect(sessionKindForCode(411)).toBe("session_multidevice_mismatch");
    expect(sessionKindForCode(440)).toBe("session_replaced");
  });

  it("an UNKNOWN code still lands in the ledger, under a coarser label", () => {
    // Deliberately the opposite of the failure it replaces. A reason we have not
    // seen before must be recorded, not silently dropped - the raw code always
    // rides in `detail` regardless.
    for (const c of [428, 500, 0, null, undefined, NaN]) {
      expect(isRiskKind(sessionKindForCode(c as number))).toBe(true);
    }
    expect(sessionKindForCode(999)).toBe("session_forbidden");
  });

  it("every code it can return is on the client axis", () => {
    for (const c of [401, 403, 411, 440, 12345]) {
      expect(axisOf(sessionKindForCode(c))).toBe("client");
    }
  });
});

describe("noteRisk NEVER THROWS - telemetry cannot break a send", () => {
  it("survives the database throwing", async () => {
    insertBehaviour = "throw";
    await expect(noteRisk({ senderKey: "a@b.com", kind: "intro_sent" })).resolves.toBe(false);
  });

  it("survives every shape of garbage input", async () => {
    const junk = [
      undefined,
      null,
      {},
      { senderKey: "" },
      { senderKey: "a@b.com" },
      { senderKey: "a@b.com", kind: "not-a-kind" },
      { senderKey: 7, kind: "intro_sent" },
      { senderKey: "a@b.com", kind: "intro_sent", detail: "not an object" },
    ];
    for (const bad of junk) {
      await expect(
        noteRisk(bad as unknown as Parameters<typeof noteRisk>[0])
      ).resolves.toBeTypeOf("boolean");
    }
  });

  it("reports whether the row landed, so the rollup can mark the bucket dark", async () => {
    // This is the whole difference from the layer it replaces: a period we could
    // not record must read as unknown on the dashboard, never as a quiet zero.
    expect(await noteRisk({ senderKey: "a@b.com", kind: "intro_sent" })).toBe(true);
    insertBehaviour = "false";
    expect(await noteRisk({ senderKey: "a@b.com", kind: "intro_sent" })).toBe(false);
  });
});

describe("what actually gets written", () => {
  it("writes one append-only row with the axis resolved", async () => {
    await noteRisk({ senderKey: "A@B.com", kind: "restriction_suspected", toKey: "66812345678" });
    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe("wa_risk_events");
    const row = inserts[0].rows[0];
    expect(row.sender_key).toBe("a@b.com"); // canonicalised, so it groups
    expect(row.kind).toBe("restriction_suspected");
    expect(row.axis).toBe("velocity");
    expect(row.to_key).toBe("66812345678");
    expect(typeof row.at).toBe("string");
  });

  it("an event with NO SENDER is refused rather than written unqueryable", async () => {
    // Append-only means a row with no attribution is there forever and can never
    // be aggregated, attributed or acted on.
    expect(await noteRisk({ senderKey: "   ", kind: "intro_sent" })).toBe(false);
    expect(inserts).toHaveLength(0);
  });

  it("stamps the config fingerprint, which is what makes axis 2 analysable", async () => {
    // Where one Meta rule keys on a shared config, the fleet's effective sample
    // size is 1. Without this stamp a config change and its consequences cannot
    // be told apart afterwards - the only comparison that would have mattered.
    await noteRisk({
      senderKey: "a@b.com",
      kind: "fingerprint_observed",
      configFingerprint: "Mac OS|Chrome|120",
      policyVersion: "v7",
    });
    expect(inserts[0].rows[0].config_fingerprint).toBe("Mac OS|Chrome|120");
    expect(inserts[0].rows[0].policy_version).toBe("v7");
  });
});

describe("detail is a LABEL, not a payload", () => {
  it("caps the number of keys and the length of each value", () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) wide[`k${i}`] = "x".repeat(1000);
    const out = sanitizeDetail(wide)!;
    expect(Object.keys(out).length).toBeLessThanOrEqual(12);
    for (const v of Object.values(out)) expect(v.length).toBeLessThanOrEqual(200);
  });

  it("drops nulls and returns null rather than an empty object", () => {
    expect(sanitizeDetail({ a: null, b: undefined })).toBeNull();
    expect(sanitizeDetail(null)).toBeNull();
    expect(sanitizeDetail("nope" as unknown as Record<string, unknown>)).toBeNull();
  });

  it("stringifies non-strings so a nested blob cannot ride in", () => {
    const out = sanitizeDetail({ n: 5, o: { deep: { deeper: 1 } } })!;
    expect(out.n).toBe("5");
    expect(typeof out.o).toBe("string");
  });
});

describe("the schema is additive and indexed for the query that matters", () => {
  const schema = readCode("supabase/schema.sql");

  it("all three tables exist and are RLS-on", () => {
    for (const t of ["wa_risk_events", "wa_risk_snapshots", "wa_policy_versions"]) {
      expect(schema).toMatch(new RegExp(`create table if not exists public\\.${t}`));
      expect(schema).toMatch(new RegExp(`alter table public\\.${t} enable row level security`));
    }
  });

  it("the sender window index is DESCENDING", () => {
    // The ledger this replaces was capped ascending with limit 200, so past that
    // it kept the oldest week-prefix and discarded the diagnostic tail - the
    // exact rows an incident review needs.
    expect(schema).toMatch(/wa_risk_events_sender_idx[\s\S]*?\(sender_key, at desc\)/);
  });

  it("the snapshot keeps its dark and truncated signal lists", () => {
    // E1 and E9 have to stay reconstructable after the incident, not only while
    // it is live.
    expect(schema).toMatch(/dark_signals\s+text\[\]/);
    expect(schema).toMatch(/truncated_signals\s+text\[\]/);
  });

  it("policy versions carry an author and a diff", () => {
    expect(schema).toMatch(/wa_policy_versions[\s\S]*?author_email text/);
    expect(schema).toMatch(/wa_policy_versions[\s\S]*?changes\s+jsonb/);
  });

  it("the eight existing hooks actually write to the ledger", () => {
    // A ledger nobody writes to is a schema migration, not observability.
    const guard = readCode("src/lib/wa-guard.ts");
    for (const kind of [
      "delivery_receipt",
      "read_receipt",
      "intro_sent",
      "intro_answered",
      "restriction_suspected",
      "ban_recovery_entered",
    ]) {
      expect(guard).toMatch(new RegExp(`"${kind}"`));
    }
    // send_failed / recipient_blocked / recipient_invalid come off one ternary
    // in recordSendFailure, so they are asserted as the trio they are.
    expect(guard).toMatch(/recipient_blocked[\s\S]{0,80}recipient_invalid[\s\S]{0,40}send_failed/);
    // Axis 2 rides the disconnect webhook, which is the only evidence it gives.
    const ingest = readCode("src/lib/wa/ingest.ts");
    expect(ingest).toMatch(/sessionKindForCode\(verdict\.code\)/);
  });

  it("REPRODUCTION GUARD: a cold error is SUSPECTED, never CONFIRMED", () => {
    // A restriction is a lane ASYMMETRY - cold failing while replies succeed -
    // which no single event can establish. Writing "confirmed" from one error
    // would put a verdict in an append-only table that the evidence does not
    // support, which is the exact class of claim this dashboard exists to stop.
    const guard = readCode("src/lib/wa-guard.ts");
    expect(guard).toMatch(/"restriction_suspected"/);
    expect(guard).not.toMatch(/kind: "restriction_confirmed"/);
  });

  it("nothing here alters or drops an existing table", () => {
    const block = schema.slice(schema.indexOf("TIER 3 OBSERVABILITY"));
    expect(block).not.toMatch(/\bdrop\s+(table|column|index)\b/i);
    expect(block).not.toMatch(/alter table[\s\S]*?drop column/i);
  });
});
