import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

// HUMANIZE AT PARK (owner report 3, 3.4 #2).
//
// The drain re-guards every parked wa_outbox row with `alreadyHumanized: true`
// - a correct idempotency contract built on a false premise: the paths that
// park MOST rows (parkOutboxOnce's composed replies, the mass route's stagger
// slots) never ran the anti-fingerprinting pass at all. So the dominant share
// of automated traffic went out with the raw composer text: uniform greetings,
// corporate sign-offs, identical punctuation - the exact hash-uniformity the
// engine exists to break, silently exempted on the busiest lane.

const db = {
  inserts: [] as Array<{ table: string; rows: Record<string, unknown>[] }>,
};
vi.mock("../runtime-config", () => ({
  sbSelect: async () => [],
  sbSelectStrict: async () => ({ rows: [] }),
  sbInsert: async (table: string, rows: Record<string, unknown>[]) => {
    db.inserts.push({ table, rows });
    return true;
  },
  sbUpdate: async () => true,
  sbDelete: async () => true,
  sbDeleteReturning: async () => [],
  sbInsertClaim: async () => "won",
  getConfig: async () => undefined,
  setConfig: async () => ({ ok: true, persistent: false }),
  supabaseConfigured: () => true,
  pgTimestamp: (d: Date) => d.toISOString(),
}));
vi.mock("../schema-probe", () => ({
  tableReady: async () => "ready" as const,
  resetSchemaProbeCache: () => {},
  schemaStateSentence: () => "",
}));

import { parkOutboxOnce } from "./park";
import { humanizeForOutbound } from "../wa-guard";

beforeEach(() => {
  db.inserts.length = 0;
});

// A text the pass is GUARANTEED to change: personaHumanize strips the
// corporate sign-off, so raw !== humanized for this input.
const RAW = "Hello, could you possibly do 250 per day? Best regards";

describe("humanizeForOutbound - the one seeded pass", () => {
  it("is deterministic: the same message identity always yields the same text", () => {
    const a = humanizeForOutbound("u@example.com", "66812345678", RAW);
    const b = humanizeForOutbound("u@example.com", "66812345678", RAW);
    expect(a).toBe(b);
  });

  it("normalises the number spelling before seeding, so every call site agrees", () => {
    const a = humanizeForOutbound("u@example.com", "+66 81 234 5678", RAW);
    const b = humanizeForOutbound("u@example.com", "66812345678", RAW);
    expect(a).toBe(b);
  });

  it("actually humanizes: sign-offs are stripped and no markdown survives", () => {
    const out = humanizeForOutbound("u@example.com", "66812345678", RAW);
    expect(out).not.toMatch(/best regards/i);
    const md = humanizeForOutbound("u@example.com", "66812345678", "Can you do *250* per day?");
    expect(md).not.toContain("*");
  });
});

describe("parkOutboxOnce runs the pass at enqueue - the drain's premise made true", () => {
  it("a raw composed reply is parked HUMANIZED, byte-identical to the shared pass", async () => {
    await parkOutboxOnce({
      senderKey: "u@example.com",
      toNumber: "66812345678",
      body: RAW,
      notBeforeMs: Date.parse("2026-07-17T12:00:00Z"),
    });
    const row = db.inserts.find((i) => i.table === "wa_outbox")?.rows[0];
    expect(row).toBeTruthy();
    expect(row!.body).toBe(humanizeForOutbound("u@example.com", "66812345678", RAW));
    expect(row!.body).not.toBe(RAW);
  });

  it("an already-humanized body (failed-send re-park) is parked VERBATIM", async () => {
    const delivered = humanizeForOutbound("u@example.com", "66812345678", RAW);
    await parkOutboxOnce({
      senderKey: "u@example.com",
      toNumber: "66812345678",
      body: delivered,
      notBeforeMs: Date.parse("2026-07-17T12:00:00Z"),
      alreadyHumanized: true,
    });
    const row = db.inserts.find((i) => i.table === "wa_outbox")?.rows[0];
    expect(row!.body).toBe(delivered);
  });
});

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("every park site runs the SAME pass (source pins)", () => {
  it("the mass route's budget-hold and stagger slots humanize the opener at park", () => {
    const mass = readCode("src/app/api/outreach/mass/route.ts");
    const parked = (mass.match(/body: humanizeForOutbound\(session\.email, digits, opener\.text\)/g) ?? []).length;
    expect(parked).toBe(2);
    // The raw opener must never be parked directly anymore.
    expect(mass).not.toMatch(/body: opener\.text/);
  });

  it("guardOutbound's inline path uses the SAME exported helper (one chain, no drift)", () => {
    const guard = readCode("src/lib/wa-guard.ts");
    expect(guard).toMatch(/humanizeForOutbound\(opts\.senderKey, opts\.toDigits, opts\.text\)/);
    expect(guard).toMatch(/export function humanizeForOutbound/);
  });

  it("the engine's failed-send re-park declares its body already humanized", () => {
    const engine = readCode("src/lib/graph/engine.ts");
    expect(engine).toMatch(/alreadyHumanized: true/);
  });
});
