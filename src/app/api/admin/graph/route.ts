import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { getGraphSpec } from "@/lib/graph/engine";
import { defaultGraphSpec } from "@/lib/graph/default-graph";
import { CONDITION_VOCABULARY } from "@/lib/graph/conditions";
import { saveVersionedSpec } from "@/lib/policy";

// The Pipeline Studio's read/save/reset endpoint (owner/manager only). The spec
// is the whole owner-editable digraph; it is sanitized + validated on save, and
// every save lands as a policy_versions snapshot (audit + one-click rollback).
export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const spec = await getGraphSpec();
  return NextResponse.json({ spec, vocabulary: CONDITION_VOCABULARY });
}

export async function POST(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({}));

  if (body.action === "reset") {
    const res = await saveVersionedSpec({
      kind: "graph_spec",
      spec: defaultGraphSpec(),
      note: "Studio: reset to default graph",
      author: session.email,
    });
    return NextResponse.json({ ok: res.ok, spec: await getGraphSpec(), problems: res.problems });
  }
  if (!body.spec || body.spec.version !== 2) {
    return NextResponse.json({ error: "Send a version 2 graph spec." }, { status: 400 });
  }
  // EVAL GATE: the edited graph must keep every golden case green before it
  // takes over live traffic (deterministic replay - fast, no LLM calls).
  // FAIL CLOSED: an unreadable golden store (or a crashed gate) is an unknown
  // verdict, not a green one - the old `total > 0` guard approved any edit the
  // moment Supabase blinked, which is the one moment approvals must stop.
  let gateReport = null;
  try {
    const { runGoldenSuite, goldenGateBlocks } = await import("@/lib/ops/golden");
    const { sanitizeGraphSpec } = await import("@/lib/graph/default-graph");
    gateReport = await runGoldenSuite({ spec: sanitizeGraphSpec(body.spec) });
    const blocked = goldenGateBlocks(gateReport);
    if (blocked) {
      return NextResponse.json(
        {
          error: `${blocked} The edit was NOT applied.`,
          problems: gateReport.cases
            .filter((c) => !c.pass)
            .map((c) => `${c.name}: ${c.turns.flatMap((t) => t.failures).join("; ")}`),
          report: gateReport,
        },
        { status: 409 }
      );
    }
  } catch (e) {
    return NextResponse.json(
      {
        error: `The golden gate could not run (${e instanceof Error ? e.message : "unknown error"}) - refusing to apply the edit blind.`,
      },
      { status: 503 }
    );
  }
  const res = await saveVersionedSpec({
    kind: "graph_spec",
    spec: body.spec,
    note: String(body.note ?? "Studio: graph edit").slice(0, 300),
    author: session.email,
    replayReport: gateReport,
  });
  if (!res.ok) {
    return NextResponse.json({ error: "Invalid graph", problems: res.problems }, { status: 400 });
  }
  return NextResponse.json({ ok: true, spec: await getGraphSpec(), versionId: res.versionId });
}

export const maxDuration = 60;
