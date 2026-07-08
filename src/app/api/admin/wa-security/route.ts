import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { getPolicies, setPolicy } from "@/lib/wa-guard";
import { sbSelect } from "@/lib/runtime-config";

// Owner control panel for the Anti-Ban engine: current effective policies
// (DB overrides merged over code defaults), per-number trust scores, and the
// queued outbox. POST updates one policy knob - applied live, no redeploy.

export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const [policies, reputation, outbox] = await Promise.all([
    getPolicies(),
    sbSelect(
      "whatsapp_number_reputation",
      "select=sender_key,trust_score,sent_total,replies_total,last_send_at,created_at&order=trust_score.desc&limit=100"
    ),
    sbSelect(
      "wa_outbox",
      "select=id,sender_key,to_number,not_before,created_at&order=not_before.asc&limit=50"
    ),
  ]);
  return NextResponse.json({ policies, reputation, outbox });
}

export async function POST(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const key = String(body.key ?? "").trim();
  const value = String(body.value ?? "").trim();
  if (!key || !value) {
    return NextResponse.json({ error: "key and value required" }, { status: 400 });
  }
  await setPolicy(key, value);
  return NextResponse.json({ ok: true, policies: await getPolicies() });
}
