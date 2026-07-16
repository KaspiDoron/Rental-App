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
  const res = await saveVersionedSpec({
    kind: "graph_spec",
    spec: body.spec,
    note: String(body.note ?? "Studio: graph edit").slice(0, 300),
    author: session.email,
  });
  if (!res.ok) {
    return NextResponse.json({ error: "Invalid graph", problems: res.problems }, { status: 400 });
  }
  return NextResponse.json({ ok: true, spec: await getGraphSpec(), versionId: res.versionId });
}

export const maxDuration = 60;
