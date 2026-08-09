import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("server-only", () => ({}));

// Controllable storage for coldEngagementWindow's three reads.
const state = {
  fail: false,
  intros: [] as Array<{ to_number: string; received_at: string }>,
  inbound: [] as Array<{ from_number: string }>,
  recip: [] as Array<{ to_number: string; read: boolean | null; last_reply_at: string | null }>,
};
vi.mock("../runtime-config", () => ({
  sbSelect: async (table: string, q: string) => {
    if (state.fail) throw new Error("db down");
    if (table === "whatsapp_messages" && q.includes("direction=eq.outbound")) return state.intros;
    if (table === "whatsapp_messages" && q.includes("direction=eq.inbound")) return state.inbound;
    if (table === "wa_recipient_state") return state.recip;
    return [];
  },
  // introductionsInWindow moved from the permissive sbSelect to sbSelectStrict
  // so an unreadable count fails CLOSED (it used to read as "zero used" and
  // open the whole introduction budget during a Supabase wobble). The mock has
  // to answer on the same helper or every intro read comes back empty.
  sbSelectStrict: async (table: string, q: string) => {
    if (state.fail) return { error: "unavailable" as const };
    if (table === "whatsapp_messages" && q.includes("direction=eq.outbound")) {
      return { rows: state.intros };
    }
    if (table === "whatsapp_messages" && q.includes("direction=eq.inbound")) {
      return { rows: state.inbound };
    }
    if (table === "wa_recipient_state") return { rows: state.recip };
    return { error: "missing" as const };
  },
  sbInsert: async () => true,
  sbUpdate: async () => true,
  sbDelete: async () => true,
  sbDeleteReturning: async () => [],
  sbInsertClaim: async () => "won",
  getConfig: async () => undefined,
  setConfig: async () => ({ ok: true, persistent: false }),
  supabaseConfigured: () => true,
}));

import { coldEngagementWindow } from "../wa-guard";

const iso = (agoH: number) => new Date(Date.now() - agoH * 3600_000).toISOString();

beforeEach(() => {
  state.fail = false;
  state.intros = [];
  state.inbound = [];
  state.recip = [];
});

// The latch this kills: the old breaker was replies_total/sent_total over the
// number's LIFETIME. The denominator grew with every send while the numerator
// depended on inbound ingest recording replies - one ingest defect and cold
// outreach froze forever, with the hold rolled to next morning (05:38).

describe("coldEngagementWindow - the breaker's windowed, engagement-based input", () => {
  it("counts distinct intros and distinct engaged shops in the window", () => {
    state.intros = [
      { to_number: "63111", received_at: iso(5) },
      { to_number: "63222", received_at: iso(4) },
      { to_number: "63222", received_at: iso(3) }, // repeat - one shop
      { to_number: "63333", received_at: iso(2) },
    ];
    state.inbound = [{ from_number: "63222" }];
    return coldEngagementWindow("owner@example.com").then((w) => {
      expect(w).toEqual({ intros: 3, engaged: 1 });
    });
  });

  it("a READ receipt counts as engagement - reads survive an inbound-text ingest defect", async () => {
    state.intros = [
      { to_number: "63111", received_at: iso(5) },
      { to_number: "63222", received_at: iso(4) },
    ];
    state.recip = [
      { to_number: "63111", read: true, last_reply_at: null },
      { to_number: "63222", read: false, last_reply_at: null },
    ];
    expect(await coldEngagementWindow("owner@example.com")).toEqual({ intros: 2, engaged: 1 });
  });

  it("no recent intros means a clean slate - the breaker cannot trip on ancient history", async () => {
    expect(await coldEngagementWindow("owner@example.com")).toEqual({ intros: 0, engaged: 0 });
  });

  it("unreadable storage returns null - the breaker stands down instead of freezing on blindness", async () => {
    state.fail = true;
    expect(await coldEngagementWindow("owner@example.com")).toBe(null);
  });
});

const readCode = (p: string) =>
  readFileSync(p, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("the guard's hold architecture (source pins)", () => {
  const guard = readCode("src/lib/wa-guard.ts");

  it("the reply-rate breaker reads the WINDOW, not lifetime counters", () => {
    expect(guard).toMatch(/coldEngagementWindow\(opts\.senderKey\)/);
    expect(guard).not.toMatch(/replyRate\(rep\) < p\.min_reply_rate/);
  });

  it("every multi-hour anti-ban hold is bounded by the plan window", () => {
    expect((guard.match(/boundHold\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("a fresh user RFQ is exempt from the engagement halt (rfq-dedup still guards repeats)", () => {
    expect(guard).toMatch(/const freshUserRfq = opts\.meta\?\.kind === "rfq"/);
    expect(guard).toMatch(/&& !freshUserRfq/);
  });

  it("terminal drops leave a durable, attributable trace", () => {
    expect(guard).toMatch(/recordSendDropped\(opts\.senderKey, opts\.toDigits, "engagement-halt/);
    expect(guard).toMatch(/recordSendDropped\(opts\.senderKey, opts\.toDigits, "rfq-dedup/);
    expect(guard).toMatch(/recordSendDropped\(opts\.senderKey, opts\.toDigits, "duplicate message suppressed/);
    expect(guard).toMatch(/kind: "send-dropped"/);
  });

  it("the drain sees dispatch facts: openNow + the batch deadline ride the row meta", () => {
    expect(guard).toMatch(/opts\.meta\?\.openNow/);
    expect(guard).toMatch(/batchDeadlineMs/);
    const mass = readCode("src/app/api/outreach/mass/route.ts");
    expect(mass).toMatch(/batchDeadline: batchStart \+ batchWindowMs\(\)/);
    expect(mass).toMatch(/openNow: v\.openNow/);
    // LLM latency inside the loop can no longer stamp rows due-in-the-past.
    expect(mass).toMatch(/Math\.max\(batchStart \+ offsets\[slot\], Date\.now\(\) \+ HARD_MIN_GAP_SEC \* 1000\)/);
  });

  it("the hours decision lives in ONE pure module and the clamp honors the dials", () => {
    const bh = readCode("src/lib/wa/business-hours.ts");
    expect(bh).toMatch(/if \(p\.fast_dispatch \|\| p\.ignore_business_hours\) return iso;/);
    expect(guard).not.toMatch(/const PREFIX_UTC/); // moved out, not duplicated
  });
});
