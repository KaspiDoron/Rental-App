import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { sbSelect } from "@/lib/runtime-config";

// Owner data explorer: read recent rows from any of the app's tables so the
// owner has full visibility into everything the app records. Read-only, an
// allow-list of tables, capped rows. Never returns secret config values.
const TABLES: { name: string; label: string; order: string }[] = [
  { name: "app_users", label: "Users", order: "last_seen.desc" },
  { name: "bookings", label: "Bookings", order: "created_at.desc" },
  { name: "searches", label: "Searches", order: "created_at.desc" },
  { name: "offers", label: "Offers", order: "created_at.desc" },
  { name: "vendor_replies", label: "Vendor replies", order: "created_at.desc" },
  { name: "bargain_drafts", label: "Bargain drafts", order: "created_at.desc" },
  { name: "whatsapp_messages", label: "WhatsApp messages", order: "received_at.desc" },
  { name: "wa_sessions", label: "WhatsApp sessions", order: "updated_at.desc" },
  { name: "agent_training", label: "Agent memory", order: "created_at.desc" },
  { name: "feedback", label: "Feedback", order: "created_at.desc" },
  { name: "auth_events", label: "Auth events", order: "created_at.desc" },
  { name: "billing_events", label: "Billing events", order: "created_at.desc" },
  { name: "api_usage", label: "API usage", order: "created_at.desc" },
  { name: "ai_usage", label: "AI usage", order: "created_at.desc" },
];

export async function GET(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const table = url.searchParams.get("table");
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));

  if (!table) {
    // List the tables + a live row count for each.
    const tables = await Promise.all(
      TABLES.map(async (t) => {
        const rows = await sbSelect<Record<string, unknown>>(t.name, "select=*&limit=1000");
        return { name: t.name, label: t.label, count: rows.length };
      })
    );
    return NextResponse.json({ tables });
  }

  const meta = TABLES.find((t) => t.name === table);
  if (!meta) return NextResponse.json({ error: "Unknown table." }, { status: 400 });
  const rows = await sbSelect<Record<string, unknown>>(
    meta.name,
    `select=*&order=${meta.order}&limit=${limit}`
  );
  return NextResponse.json({ table: meta.name, label: meta.label, rows });
}
