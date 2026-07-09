import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { getFunnel, saveFunnel, defaultFunnel, type FunnelNode } from "@/lib/funnel";
import { chat, extractJson, aiEnabled } from "@/lib/ai";

// Owner control of the negotiation funnel tree (New#3/#10).

export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json({ tree: await getFunnel() });
}

export async function PUT(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (session.role !== "owner") {
    return NextResponse.json({ error: "Owner only." }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  if (body.reset) {
    const tree = defaultFunnel();
    await saveFunnel(tree);
    return NextResponse.json({ ok: true, tree });
  }
  if (!body.tree?.id) return NextResponse.json({ error: "Bad tree." }, { status: 400 });
  await saveFunnel(body.tree as FunnelNode);
  return NextResponse.json({ ok: true });
}

// AI suggestion for a node: propose a better branch/wording with the top model.
export async function POST(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!(await aiEnabled())) {
    return NextResponse.json({ error: "Add an AI key in Admin -> Keys first." }, { status: 400 });
  }
  const body = await req.json().catch(() => ({}));
  const node = body.node ?? {};
  const out = await chat([
    {
      role: "system",
      content:
        "You improve a rental-negotiation funnel. Given one funnel step (a " +
        "condition + the agent's action), suggest a sharper, more human, more " +
        "effective version AND optionally one new child branch to handle a case " +
        "it misses. Keep the agent's rules: ask once, never push, anchor to the " +
        "local market floor, stay authentic. Reply ONLY as JSON: { \"label\": " +
        'string, "condition": string, "message": string, "newBranch"?: { "label": ' +
        'string, "condition": string, "message": string } }.',
    },
    {
      role: "user",
      content: `Step: ${JSON.stringify({
        label: node.label,
        condition: node.condition,
        message: node.message,
      })}`,
    },
  ]);
  if (!out) return NextResponse.json({ error: "No AI response." }, { status: 502 });
  const parsed = extractJson<{
    label?: string; condition?: string; message?: string;
    newBranch?: { label: string; condition: string; message: string };
  }>(out);
  if (!parsed) return NextResponse.json({ error: "Could not parse suggestion." }, { status: 502 });
  return NextResponse.json({ suggestion: parsed });
}

// Vercel: allow slow AI/WhatsApp upstreams (Hobby default is ~10s - too short).
export const maxDuration = 60;
