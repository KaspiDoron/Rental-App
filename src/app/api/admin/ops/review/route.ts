import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/session";
import { sbSelect, sbInsert, sbInsertReturning, sbUpdate } from "@/lib/runtime-config";
import type { ReviewInput, ReviewVerdict, OutcomeImpact, ReviewStatus } from "@/lib/ops/types";

// Ops Center: owner reviews of agent decisions - the feedback that actually
// teaches the system. Upserted per (thread, decision). Two side effects make
// the learning REAL the moment the owner saves:
//   bookmark        -> the negotiation is distilled into agent_training, which
//                      composeBargain already injects into every future prompt
//   better_response -> stored as a correction exemplar the same way
// (Phase 3 additionally recompiles the ops_learning blob for the director.)

const VERDICTS: ReviewVerdict[] = ["approve", "reject"];
const IMPACTS: OutcomeImpact[] = ["improved", "worsened", "neutral"];
const STATUSES: ReviewStatus[] = ["open", "flagged", "auto_flagged", "resolved"];

export async function GET(req: Request) {
  const session = await requireOwner();
  if (!session) return NextResponse.json({ error: "Owner only." }, { status: 403 });
  const url = new URL(req.url);
  if (url.searchParams.get("queue") === "inbox") {
    const rows = await sbSelect<Record<string, unknown>>(
      "agent_reviews",
      "select=*&status=in.(open,flagged,auto_flagged)&order=created_at.desc&limit=100"
    ).catch(() => []);
    return NextResponse.json({ reviews: rows });
  }
  const threadKey = url.searchParams.get("threadKey") ?? "";
  const rows = threadKey
    ? await sbSelect<Record<string, unknown>>(
        "agent_reviews",
        `select=*&thread_key=eq.${encodeURIComponent(threadKey)}&order=created_at.desc&limit=60`
      ).catch(() => [])
    : [];
  return NextResponse.json({ reviews: rows });
}

export async function POST(req: Request) {
  const session = await requireOwner();
  if (!session) return NextResponse.json({ error: "Owner only." }, { status: 403 });

  const body = (await req.json().catch(() => null)) as ReviewInput | null;
  const threadKey = String(body?.threadKey ?? "").trim();
  const idx = threadKey.lastIndexOf(":");
  if (!body || idx <= 0) {
    return NextResponse.json({ error: "threadKey required" }, { status: 400 });
  }
  const userEmail = threadKey.slice(0, idx);
  const digits = threadKey.slice(idx + 1);
  const decisionId = body.decisionId ? String(body.decisionId).slice(0, 64) : null;

  // Validate/clamp every field - the console can never write garbage.
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.rating !== undefined) {
    const r = Math.round(Number(body.rating));
    if (r >= 1 && r <= 5) patch.rating = r;
  }
  if (body.verdict !== undefined && VERDICTS.includes(body.verdict)) patch.verdict = body.verdict;
  if (typeof body.branchCorrect === "boolean") patch.branch_correct = body.branchCorrect;
  if (body.outcomeImpact !== undefined && IMPACTS.includes(body.outcomeImpact))
    patch.outcome_impact = body.outcomeImpact;
  if (body.betterResponse !== undefined)
    patch.better_response = String(body.betterResponse).slice(0, 1500) || null;
  if (body.feedback !== undefined) patch.feedback = String(body.feedback).slice(0, 2000) || null;
  if (Array.isArray(body.tags))
    patch.tags = body.tags.map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 10);
  if (typeof body.bookmark === "boolean") patch.bookmark = body.bookmark;
  if (body.status !== undefined && STATUSES.includes(body.status)) patch.status = body.status;

  // Existing review for this (thread, decision)?
  const filter = decisionId
    ? `thread_key=eq.${encodeURIComponent(threadKey)}&decision_id=eq.${encodeURIComponent(decisionId)}`
    : `thread_key=eq.${encodeURIComponent(threadKey)}&decision_id=is.null`;
  const existing = await sbSelect<{
    id: number;
    bookmark: boolean;
    better_response: string | null;
  }>("agent_reviews", `select=id,bookmark,better_response&${filter}&limit=1`).catch(() => []);

  let reviewId = existing[0]?.id ?? null;
  if (reviewId) {
    await sbUpdate("agent_reviews", `id=eq.${reviewId}`, patch).catch(() => false);
  } else {
    // Denormalize vendor + chosen node/edge so priors and heatmaps never
    // need to re-join agent_traces at read time.
    const [thread, traces] = await Promise.all([
      sbSelect<{ vendor_id: string | null; vendor_name: string | null }>(
        "negotiation_threads",
        `select=vendor_id,vendor_name&thread_key=eq.${encodeURIComponent(threadKey)}&limit=1`
      ).catch(() => []),
      decisionId
        ? sbSelect<{ node_id: string | null; edge_id: string | null }>(
            "agent_traces",
            `select=node_id,edge_id&decision_id=eq.${encodeURIComponent(
              decisionId
            )}&edge_id=not.is.null&order=created_at.asc&limit=1`
          ).catch(() => [])
        : Promise.resolve([] as { node_id: string | null; edge_id: string | null }[]),
    ]);
    const rows = await sbInsertReturning<{ id: number }>("agent_reviews", [
      {
        decision_id: decisionId,
        thread_key: threadKey,
        user_email: userEmail,
        vendor_id: thread[0]?.vendor_id ?? digits,
        vendor_name: thread[0]?.vendor_name ?? null,
        node_id: traces[0]?.node_id ?? null,
        edge_id: traces[0]?.edge_id ?? null,
        source: "owner",
        status: "open",
        ...patch,
      },
    ]).catch(() => []);
    reviewId = rows[0]?.id ?? null;
  }

  // ---- learning side effects (only on TRANSITIONS, never duplicated) ----------
  const becameBookmarked = body.bookmark === true && existing[0]?.bookmark !== true;
  const newCorrection =
    typeof body.betterResponse === "string" &&
    body.betterResponse.trim().length > 0 &&
    body.betterResponse.trim() !== (existing[0]?.better_response ?? "").trim();

  if (becameBookmarked || newCorrection) {
    const [outs, ins, thread] = await Promise.all([
      sbSelect<{ body: string | null; received_at: string }>(
        "whatsapp_messages",
        `select=body,received_at&direction=eq.outbound&to_number=eq.${encodeURIComponent(
          digits
        )}&raw->>sender=eq.${encodeURIComponent(userEmail)}&order=received_at.desc&limit=4`
      ).catch(() => []),
      sbSelect<{ body: string | null; received_at: string }>(
        "whatsapp_messages",
        `select=body,received_at&direction=eq.inbound&from_number=eq.${encodeURIComponent(
          digits
        )}&order=received_at.desc&limit=4`
      ).catch(() => []),
      sbSelect<{ vendor_name: string | null }>(
        "negotiation_threads",
        `select=vendor_name&thread_key=eq.${encodeURIComponent(threadKey)}&limit=1`
      ).catch(() => []),
    ]);
    const vendorName = thread[0]?.vendor_name || "a rental shop";
    const day = new Date().toISOString().slice(0, 10);

    if (becameBookmarked) {
      const exchange = [
        ...outs.map((m) => ({ who: "Agent", text: m.body ?? "", at: m.received_at })),
        ...ins.map((m) => ({ who: "Shop", text: m.body ?? "", at: m.received_at })),
      ]
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
        .map((m) => `${m.who}: ${m.text.slice(0, 260)}`)
        .join("\n");
      await sbInsert("agent_training", [
        {
          text: `[OPS-EXEMPLAR ${day}] Owner-approved negotiation with ${vendorName}:\n${exchange}`.slice(
            0,
            3500
          ),
          note: (body.feedback ?? "").slice(0, 300) || "Bookmarked in the Ops Center",
          added_by: session.email,
          source: "ops-exemplar",
        },
      ]).catch(() => {});
    }
    if (newCorrection) {
      const lastShop = ins[0]?.body ?? "";
      const lastAgent = outs[0]?.body ?? "";
      await sbInsert("agent_training", [
        {
          text:
            `[OPS-CORRECTION ${day}] With ${vendorName}, the shop said: "${lastShop.slice(0, 300)}". ` +
            `The agent replied: "${lastAgent.slice(0, 300)}". ` +
            `The CORRECT reply would have been: "${body.betterResponse!.trim().slice(0, 600)}".` +
            (body.feedback ? ` Why: ${String(body.feedback).slice(0, 300)}` : ""),
          note: "Owner correction from the Ops Center",
          added_by: session.email,
          source: "ops-correction",
        },
      ]).catch(() => {});
    }
  }

  // Recompile the director-facing learning blob (priors/exemplars) - Phase 3
  // makes this live; a failed recompile never blocks the review save.
  try {
    const { recompileOpsLearning } = await import("@/lib/ops/learning");
    await recompileOpsLearning();
  } catch {
    /* not wired yet / best-effort */
  }

  return NextResponse.json({ ok: true, id: reviewId });
}

export const maxDuration = 60;
