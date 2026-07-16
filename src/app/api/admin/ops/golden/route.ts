import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/session";
import { sbSelect, sbInsertReturning, sbUpdate, sbDelete } from "@/lib/runtime-config";
import { listGoldenCases } from "@/lib/ops/golden";
import type { GoldenExpect, GoldenTurn } from "@/lib/ops/types";

// Golden regression cases - real conversations frozen into deterministic
// replays. create-from-thread snapshots the ACTUAL shop messages, the stored
// extraction results and the floor that was in force, and defaults each
// turn's expectation to what the agent actually did (owner-auditable).

export async function GET() {
  const session = await requireOwner();
  if (!session) return NextResponse.json({ error: "Owner only." }, { status: 403 });
  const cases = await listGoldenCases(false);
  return NextResponse.json({
    cases: cases.map((c) => ({
      id: c.id,
      name: c.name,
      threadKey: c.thread_key,
      region: c.region,
      turnCount: Array.isArray(c.turns) ? c.turns.length : 0,
      enabled: c.enabled,
      createdAt: c.created_at,
    })),
  });
}

export async function POST(req: Request) {
  const session = await requireOwner();
  if (!session) return NextResponse.json({ error: "Owner only." }, { status: 403 });
  const body = await req.json().catch(() => ({}));

  if (body.action === "toggle" && Number.isFinite(Number(body.id))) {
    const rows = await sbSelect<{ enabled: boolean }>(
      "agent_golden_cases",
      `select=enabled&id=eq.${Number(body.id)}&limit=1`
    ).catch(() => []);
    if (!rows[0]) return NextResponse.json({ error: "Case not found." }, { status: 404 });
    await sbUpdate("agent_golden_cases", `id=eq.${Number(body.id)}`, {
      enabled: !rows[0].enabled,
    }).catch(() => false);
    return NextResponse.json({ ok: true, enabled: !rows[0].enabled });
  }
  if (body.action === "delete" && Number.isFinite(Number(body.id))) {
    await sbDelete("agent_golden_cases", `id=eq.${Number(body.id)}`).catch(() => false);
    return NextResponse.json({ ok: true });
  }
  if (body.action !== "create-from-thread") {
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }

  const threadKey = String(body.threadKey ?? "").trim();
  const idx = threadKey.lastIndexOf(":");
  if (idx <= 0) return NextResponse.json({ error: "threadKey required" }, { status: 400 });
  const userEmail = threadKey.slice(0, idx);
  const digits = threadKey.slice(idx + 1);

  const [outs, ins, replies] = await Promise.all([
    sbSelect<{
      body: string | null;
      received_at: string;
      raw: {
        kind?: string;
        decisionId?: string;
        rfq?: Record<string, unknown>;
        region?: string;
      } | null;
    }>(
      "whatsapp_messages",
      `select=body,received_at,raw&direction=eq.outbound&to_number=eq.${encodeURIComponent(
        digits
      )}&raw->>sender=eq.${encodeURIComponent(userEmail)}&order=received_at.asc&limit=60`
    ).catch(() => []),
    sbSelect<{ body: string | null; received_at: string }>(
      "whatsapp_messages",
      `select=body,received_at&direction=eq.inbound&from_number=eq.${encodeURIComponent(
        digits
      )}&order=received_at.asc&limit=60`
    ).catch(() => []),
    sbSelect<{
      reply_text: string | null;
      found: boolean | null;
      price_per_day: number | null;
      currency: string | null;
      matches_spec: boolean | null;
      confidence: string | null;
      created_at: string;
    }>(
      "vendor_replies",
      `select=reply_text,found,price_per_day,currency,matches_spec,confidence,created_at&user_email=eq.${encodeURIComponent(
        userEmail
      )}&order=created_at.asc&limit=60`
    ).catch(() => []),
  ]);

  if (ins.length === 0) {
    return NextResponse.json(
      { error: "No shop messages in this thread - nothing to freeze." },
      { status: 400 }
    );
  }

  // Frozen extraction per inbound: the stored vendor_replies parse closest in
  // time (within 5 minutes), else an honest found:false stub.
  const stubFor = (at: string): Record<string, unknown> => {
    const t = Date.parse(at);
    let best: (typeof replies)[number] | null = null;
    let bestGap = 5 * 60_000;
    for (const r of replies) {
      const gap = Math.abs(Date.parse(r.created_at) - t);
      if (gap < bestGap) {
        best = r;
        bestGap = gap;
      }
    }
    if (!best) return { found: false };
    return {
      found: best.found === true,
      pricePerDay: best.price_per_day ?? undefined,
      currency: best.currency ?? undefined,
      matchesSpec: best.matches_spec,
      confidence: best.confidence ?? "medium",
    };
  };

  // Expectation per inbound = what actually happened: the next outbound's kind.
  const expectFor = (at: string): GoldenExpect => {
    const t = Date.parse(at);
    const next = outs.find((o) => Date.parse(o.received_at) > t);
    const kind = next?.raw?.kind ?? "";
    const action = kind.replace(/^auto-/, "");
    return action ? { action } : {};
  };

  const inbound = ins.slice(0, 8);
  const turns: GoldenTurn[] = inbound.map((m) => ({
    shopSays: (m.body ?? "").slice(0, 800),
    stubExtraction: stubFor(m.received_at),
  }));
  const expects: GoldenExpect[] = inbound.map((m) => expectFor(m.received_at));

  // Frozen floor: parsed from the comparator trace of this thread's decisions.
  let floor: { floor?: number; typical?: number; currency?: string } | null = null;
  const decisionIds = outs.map((o) => o.raw?.decisionId).filter((x): x is string => Boolean(x));
  if (decisionIds.length) {
    const comp = await sbSelect<{ input: string | null }>(
      "agent_traces",
      `select=input&stage=eq.comparator&decision_id=in.(${decisionIds
        .slice(-20)
        .map((d) => encodeURIComponent(d))
        .join(",")})&order=created_at.desc&limit=1`
    ).catch(() => []);
    const m = (comp[0]?.input ?? "").match(/floor=(\d+)/);
    if (m) {
      const stub = turns.find((t) => (t.stubExtraction as { currency?: string }).currency);
      floor = {
        floor: Number(m[1]),
        currency: (stub?.stubExtraction as { currency?: string })?.currency,
      };
    }
  }

  const newest = outs[outs.length - 1];
  const rows = await sbInsertReturning<{ id: number }>("agent_golden_cases", [
    {
      name: String(body.name ?? "").trim().slice(0, 120) || `Golden - ${digits}`,
      thread_key: threadKey,
      rfq: newest?.raw?.rfq ?? {},
      region: newest?.raw?.region ?? null,
      floor,
      turns,
      expects,
      enabled: true,
    },
  ]).catch(() => []);

  if (!rows[0]?.id) {
    return NextResponse.json(
      { error: "Could not store the golden case (is Supabase configured?)." },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true, id: rows[0].id, turnCount: turns.length });
}

export const maxDuration = 60;
