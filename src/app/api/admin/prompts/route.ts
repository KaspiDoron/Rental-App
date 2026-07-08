import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { listPrompts, setPrompt } from "@/lib/prompts";

// Owner control of the agents' core prompts. Prompts can be viewed and edited
// but NEVER removed - saving an empty value just restores the default.

export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json({ prompts: await listPrompts() });
}

export async function POST(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  // Owner-only: core prompts shape every agent, so only the owner may edit them.
  if (session.role !== "owner") {
    return NextResponse.json({ error: "Owner only." }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const id = String(body.id ?? "");
  const text = String(body.text ?? "");
  const ok = await setPrompt(id, text);
  if (!ok) return NextResponse.json({ error: "Unknown prompt id." }, { status: 400 });
  return NextResponse.json({ ok: true, prompts: await listPrompts() });
}
