import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/session";
import { getGraphSpec } from "@/lib/graph/engine";
import { saveVersionedSpec } from "@/lib/policy";
import { runGoldenSuite, goldenGateBlocks } from "@/lib/ops/golden";
import { sanitizeGraphSpec } from "@/lib/graph/default-graph";
import type { EdgeSpec, GraphCondition, GraphSpec } from "@/lib/graph/types";

// Create a new branching rule directly from a real conversation: the owner
// picks the target node, condition and priority (prefilled from the reviewed
// decision), and the rule lands as a typed director edge - sanitized,
// validated, golden-gated and versioned like every other behavior change.

export async function POST(req: Request) {
  const session = await requireOwner();
  if (!session) return NextResponse.json({ error: "Owner only." }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const edge = body.edge as
    | { to?: string; label?: string; when?: GraphCondition; priority?: number }
    | undefined;
  if (!edge?.to || !edge.label) {
    return NextResponse.json({ error: "edge.to and edge.label are required." }, { status: 400 });
  }

  const spec = await getGraphSpec();
  if (!spec.nodes.some((n) => n.id === edge.to)) {
    return NextResponse.json(
      { error: `Unknown target node "${edge.to}". Pick an existing node id.` },
      { status: 400 }
    );
  }

  const newEdge: EdgeSpec = {
    id: `d-ops-${Date.now().toString(36)}`,
    from: "director",
    to: edge.to,
    label: String(edge.label).slice(0, 80),
    // No condition = always legal (the typed union's neutral element).
    when: edge.when ?? ({ kind: "always" } as GraphCondition),
    priority: Number.isFinite(Number(edge.priority)) ? Math.round(Number(edge.priority)) : 500,
    enabled: true,
  };
  const candidate: GraphSpec = sanitizeGraphSpec({
    ...spec,
    edges: [...spec.edges, newEdge],
  });

  // EVAL GATE: the new rule must not break any golden case. Fails CLOSED on an
  // unreadable golden store (goldenGateBlocks) - approving a rule the suite
  // could not check is not a gate.
  const report = await runGoldenSuite({ spec: candidate });
  const blocked = goldenGateBlocks(report);
  if (blocked) {
    return NextResponse.json(
      { error: `${blocked} The rule was not applied.`, report },
      { status: 409 }
    );
  }

  const res = await saveVersionedSpec({
    kind: "graph_spec",
    spec: candidate,
    note: `Ops rule: ${newEdge.label}${body.note ? ` - ${String(body.note).slice(0, 150)}` : ""}`,
    author: session.email,
    replayReport: report,
  });
  if (!res.ok) {
    return NextResponse.json(
      { error: `The rule failed validation: ${res.problems.join("; ")}` },
      { status: 400 }
    );
  }
  return NextResponse.json({ ok: true, edgeId: newEdge.id, versionId: res.versionId, report });
}

export const maxDuration = 60;
