import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { getGraphSpec, saveGraphSpec } from "@/lib/graph/engine";
import { defaultGraphSpec } from "@/lib/graph/default-graph";
import { CONDITION_VOCABULARY } from "@/lib/graph/conditions";

// The Pipeline Studio's read/save/reset endpoint (owner/manager only). The spec
// is the whole owner-editable digraph; it is sanitized + validated on save.
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
    const res = await saveGraphSpec(defaultGraphSpec());
    return NextResponse.json({ ok: res.ok, spec: await getGraphSpec(), problems: res.problems });
  }
  if (!body.spec || body.spec.version !== 2) {
    return NextResponse.json({ error: "Send a version 2 graph spec." }, { status: 400 });
  }
  const res = await saveGraphSpec(body.spec);
  if (!res.ok) {
    return NextResponse.json({ error: "Invalid graph", problems: res.problems }, { status: 400 });
  }
  return NextResponse.json({ ok: true, spec: await getGraphSpec() });
}

export const maxDuration = 60;
