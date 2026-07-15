import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { sbSelect } from "@/lib/runtime-config";

// Live decision replay (owner/manager only): recent agent_traces grouped by
// decision_id, each carrying the node/edge path so the Studio can animate the
// EXACT route a real WhatsApp event took through the graph. Score badges come
// from agent_scores keyed by the same decision_id.
interface TraceRow {
  decision_id: string;
  user_email: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  stage: string;
  input: string | null;
  reasoning: string | null;
  output: string | null;
  verdict: string | null;
  node_id: string | null;
  edge_id: string | null;
  created_at: string;
}

export async function GET(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const vendor = url.searchParams.get("vendor");
  const decisionId = url.searchParams.get("decisionId");

  let filter = "";
  if (decisionId) filter = `&decision_id=eq.${encodeURIComponent(decisionId)}`;
  else if (vendor) filter = `&vendor_id=eq.${encodeURIComponent(vendor)}`;

  const rows = await sbSelect<TraceRow>(
    "agent_traces",
    `select=decision_id,user_email,vendor_id,vendor_name,stage,input,reasoning,output,verdict,node_id,edge_id,created_at&order=created_at.desc${filter}&limit=240`
  ).catch(() => []);

  // Group by decision, newest first, preserving stage order within a decision.
  const byDecision = new Map<string, TraceRow[]>();
  for (const r of rows) {
    if (!byDecision.has(r.decision_id)) byDecision.set(r.decision_id, []);
    byDecision.get(r.decision_id)!.push(r);
  }
  const decisions = [...byDecision.entries()].slice(0, 40).map(([id, stages]) => {
    const ordered = [...stages].reverse(); // chronological within the decision
    return {
      decisionId: id,
      vendorName: ordered[0]?.vendor_name ?? ordered[0]?.vendor_id ?? "",
      userEmail: ordered[0]?.user_email ?? "",
      at: ordered[ordered.length - 1]?.created_at ?? "",
      path: ordered.filter((s) => s.node_id).map((s) => s.node_id!),
      stages: ordered.map((s) => ({
        stage: s.stage,
        nodeId: s.node_id,
        edgeId: s.edge_id,
        input: s.input,
        reasoning: s.reasoning,
        output: s.output,
        verdict: s.verdict,
      })),
    };
  });

  // Attach any judge scores for these decisions.
  const ids = decisions.map((d) => d.decisionId);
  let scores: Record<string, { scores: Record<string, number>; verdict: string; scorer: string }> = {};
  if (ids.length) {
    const scoreRows = await sbSelect<{
      decision_id: string;
      scores: Record<string, number>;
      verdict: string;
      scorer: string;
    }>(
      "agent_scores",
      `select=decision_id,scores,verdict,scorer&decision_id=in.(${ids
        .map((x) => `"${x}"`)
        .join(",")})&limit=80`
    ).catch(() => []);
    for (const s of scoreRows) scores[s.decision_id] = s;
  }

  return NextResponse.json({ decisions, scores });
}

export const maxDuration = 60;
