import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { aiStatus, PROVIDER_NAMES } from "@/lib/ai";
import { setConfig } from "@/lib/runtime-config";

// AI provider dashboard: usage, remaining quota (where the provider exposes
// it), and the active provider. Failover order is preferred-first, then the
// rest - when one runs out or errors, the next takes over automatically.
export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json({ providers: await aiStatus() });
}

// Switch the preferred provider from the app.
export async function POST(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { provider } = await req.json().catch(() => ({}));
  // Any configured provider can be starred as the preferred one (was limited to
  // 4 - so deepseek/mistral/together/sambanova/huggingface could never be set).
  if (!(PROVIDER_NAMES as string[]).includes(String(provider))) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  }
  const result = await setConfig("AI_PROVIDER", String(provider));
  return NextResponse.json({
    ok: true,
    warning: result.error,
    providers: await aiStatus(),
  });
}
