import { NextResponse } from "next/server";
import { requireManagement, getSession } from "@/lib/session";
import { monthlyUsage, QUOTAS, limitDefaults, killSwitchOn } from "@/lib/usage";
import { getConfig, setConfig, sbSelect } from "@/lib/runtime-config";

// Cost tracker + abuse limits + owner kill switch.
// GET: this month's usage per API vs free quota, AI token totals, current limits.
// POST: { limits?: {NAME: number}, killSwitch?: boolean } - kill switch owner-only.
export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);

  const since = `created_at=gte.${encodeURIComponent(start.toISOString())}`;
  const [usage, aiRows, searches, offers, outbound, users, kill] = await Promise.all([
    monthlyUsage(),
    sbSelect<{ provider: string; tokens: number }>(
      "ai_usage",
      `select=provider,tokens&${since}&limit=10000`
    ),
    sbSelect<{ id: number }>("searches", `select=id&${since}&limit=10000`),
    sbSelect<{ id: number }>("offers", `select=id&${since}&limit=10000`),
    sbSelect<{ id: number }>(
      "whatsapp_messages",
      `select=id&direction=eq.outbound&received_at=gte.${encodeURIComponent(start.toISOString())}&limit=10000`
    ),
    sbSelect<{ email: string }>("app_users", "select=email&limit=10000"),
    killSwitchOn(),
  ]);

  const aiTokens: Record<string, number> = {};
  let aiCalls = 0;
  for (const r of aiRows) {
    aiTokens[r.provider] = (aiTokens[r.provider] ?? 0) + (r.tokens ?? 0);
    aiCalls += 1;
  }

  const stats = {
    searchesThisMonth: searches.length,
    offersThisMonth: offers.length,
    messagesSent: outbound.length,
    aiCalls,
    totalUsers: users.length,
  };

  const defaults = limitDefaults();
  const limits: Record<string, number> = {};
  for (const name of Object.keys(defaults)) {
    const v = Number(await getConfig(name));
    limits[name] = Number.isFinite(v) && v > 0 ? v : defaults[name];
  }

  const apis = Object.entries(QUOTAS).map(([kind, q]) => {
    const used = usage[kind] ?? 0;
    const over = Math.max(0, used - q.free);
    return {
      kind,
      label: q.label,
      used,
      free: q.free,
      estCostUsd: Number((over * q.unitCost).toFixed(2)),
    };
  });

  return NextResponse.json({ apis, aiTokens, stats, limits, defaults, killSwitch: kill });
}

export async function POST(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const defaults = limitDefaults();

  if (body.limits && typeof body.limits === "object") {
    for (const [name, value] of Object.entries(body.limits)) {
      if (!(name in defaults)) continue;
      const n = Number(value);
      if (Number.isFinite(n) && n > 0 && n <= 100000) {
        await setConfig(name, String(Math.round(n)));
      }
    }
  }

  if (typeof body.killSwitch === "boolean") {
    const me = await getSession();
    if (me?.role !== "owner") {
      return NextResponse.json({ error: "Only the owner can use the kill switch." }, { status: 403 });
    }
    await setConfig("KILL_SWITCH", body.killSwitch ? "1" : "");
  }

  return NextResponse.json({ ok: true });
}
