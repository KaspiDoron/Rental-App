import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { sbSelect, sbCountDark } from "@/lib/runtime-config";

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
  { name: "market_floor_prices", label: "Market floor prices", order: "updated_at.desc" },
  { name: "whatsapp_number_reputation", label: "WA trust scores", order: "created_at.desc" },
  { name: "whatsapp_security_policies", label: "WA security policies", order: "id.asc" },
  { name: "wa_outbox", label: "WA outbox (queued)", order: "not_before.asc" },
];

export async function GET(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const table = url.searchParams.get("table");
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));

  if (!table) {
    // A COUNT IS A COUNT, NOT A THOUSAND ROWS WITH .length TAKEN.
    //
    // This downloaded up to 1000 FULL rows from all 18 tables in parallel and
    // reported `rows.length`. Three things wrong with that, and sbCount's own
    // docblock in runtime-config already forbids the pattern by name:
    //
    //   - the number saturates at exactly 1000 and then never moves again;
    //   - sbSelect maps a timeout or non-2xx to [], so a slow table reports
    //     ZERO rows rather than "could not read";
    //   - `select=*` over 1000 whatsapp_messages rows (full `raw` jsonb) or
    //     app_users rows (including password_hash) realistically trips the 8s
    //     timedFetch deadline - and every byte is discarded except .length.
    //
    // sbCountDark answers from Content-Range with a single-row body, and
    // returns null on an outage so an unreadable table reads as unknown rather
    // than as empty - the fail-dark contract this panel is supposed to honour.
    const tables = await Promise.all(
      TABLES.map(async (t) => {
        // No filter - the whole table. Range: 0-0 keeps the body to one row.
        const n = await sbCountDark(t.name, "");
        return { name: t.name, label: t.label, count: n, unreadable: n === null };
      })
    );
    return NextResponse.json({
      tables,
      // So the panel can say so rather than rendering a confident zero.
      degraded: tables.filter((t) => t.unreadable).map((t) => t.name),
    });
  }

  const meta = TABLES.find((t) => t.name === table);
  if (!meta) return NextResponse.json({ error: "Unknown table." }, { status: 400 });
  const rows = await sbSelect<Record<string, unknown>>(
    meta.name,
    `select=*&order=${meta.order}&limit=${limit}`
  );
  return NextResponse.json({ table: meta.name, label: meta.label, rows });
}
