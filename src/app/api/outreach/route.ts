import { NextResponse } from "next/server";
import { runSafety } from "@/lib/agents";
import { sendWhatsApp } from "@/lib/whatsapp";
import { getSession } from "@/lib/session";
import { sbInsert } from "@/lib/runtime-config";

// Screen an outbound custom message through the safety agent, then dispatch it
// via the official WhatsApp Cloud API (or return a compliant wa.me link).
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Sign in to message vendors." }, { status: 401 });
  }
  const { to, message } = await req.json().catch(() => ({}));
  if (!to || !message) {
    return NextResponse.json({ error: "to and message required" }, { status: 400 });
  }

  const verdict = await runSafety(String(message));
  if (!verdict.allowed) {
    return NextResponse.json(
      { allowed: false, reason: verdict.reason, suggestion: verdict.suggestion },
      { status: 200 }
    );
  }

  const result = await sendWhatsApp(String(to), String(message));

  // Best-effort log for the admin communication vault (no-op without Supabase).
  await sbInsert("whatsapp_messages", [
    {
      to_number: String(to),
      body: String(message),
      type: "text",
      direction: "outbound",
      raw: { channel: result.channel, sender: session.email, ok: result.ok },
    },
  ]);

  return NextResponse.json({ allowed: true, delivery: result });
}
