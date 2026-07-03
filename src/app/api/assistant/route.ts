import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { analytics } from "@/lib/memory";
import { listUsers } from "@/lib/access";
import { sbSelect } from "@/lib/runtime-config";
import { chat, type ChatMessage } from "@/lib/ai";

// The owner's co-manager AI. Owner-only. It has read access to the agents'
// memory and the databases, briefs the owner on what needs attention, and
// answers free-form questions.
export async function POST(req: Request) {
  const session = await getSession();
  if (session?.role !== "owner") {
    return NextResponse.json({ error: "Owner only" }, { status: 403 });
  }
  const { messages } = (await req.json().catch(() => ({}))) as {
    messages?: { role: "user" | "assistant"; content: string }[];
  };

  // Assemble the operational context the assistant can see.
  const a = analytics();
  const users = await listUsers();
  const [feedback, searches, offers, waMessages, bookings] = await Promise.all([
    sbSelect("feedback", "select=category,summary,severity,is_real_issue,created_at&order=created_at.desc&limit=15"),
    sbSelect("searches", "select=vehicle_class,source,results,created_at&order=created_at.desc&limit=20"),
    sbSelect("offers", "select=vendor_name,price_per_day,simulated,verified,created_at&order=created_at.desc&limit=20"),
    sbSelect("whatsapp_messages", "select=direction,body,received_at&order=received_at.desc&limit=15"),
    sbSelect("bookings", "select=vendor_id,total_price,status,created_at&order=created_at.desc&limit=15"),
  ]);

  const context = JSON.stringify(
    {
      negotiationAnalytics: a,
      registeredUsers: users.length,
      recentUsers: users.slice(0, 10).map((u) => ({
        email: u.email,
        status: u.status,
        provider: u.provider,
      })),
      recentFeedback: feedback,
      recentSearches: searches,
      recentOffers: offers,
      recentWhatsApp: waMessages,
      recentBookings: bookings,
      dataNote:
        feedback.length + searches.length + offers.length === 0
          ? "Supabase not connected or empty - durable history unavailable yet."
          : undefined,
    },
    null,
    1
  );

  const system =
    "You are Deals, the co-owner and operations manager of WheelDeal, reporting " +
    "directly to the owner. You have full read access to agent memory and the " +
    "database snapshot provided. Be sharp, concise and proactive: lead with what " +
    "needs immediate attention (high-severity feedback, blocked funnels, missing " +
    "keys, negotiation performance), give concrete numbers, and propose next " +
    "actions. STRICT FORMAT: plain conversational text only - never use " +
    "markdown, asterisks, backticks, hashes or any special formatting " +
    "characters; use simple dashes for lists.\n\nOPERATIONAL DATA:\n" +
    context;

  const history: ChatMessage[] = [
    { role: "system", content: system },
    ...(messages ?? []).slice(-12).map((m) => ({
      role: m.role,
      content: String(m.content).slice(0, 2000),
    })),
  ];
  if (history.length === 1) {
    history.push({ role: "user", content: "Brief me. What needs my attention right now?" });
  }

  const reply = await chat(history);
  if (reply) {
    const { sanitizeAiText } = await import("@/lib/text");
    return NextResponse.json({ reply: sanitizeAiText(reply) });
  }

  // Deterministic fallback briefing when no LLM key is configured.
  const urgent = (feedback as any[]).filter((f) => f.is_real_issue && f.severity === "high");
  const lines = [
    "Here's your briefing (offline mode - add an AI key for full analysis):",
    `- Negotiation engine: ${a.totalRuns} runs, ${a.totalOffers} offers, avg discount ${a.avgDiscountPct}%. Best tactic: ${a.bestTactic ?? "n/a"}.`,
    `- Registered users: ${users.length}.`,
    urgent.length
      ? `- NEEDS ATTENTION: ${urgent.length} high-severity issue(s): ${urgent
          .map((f: any) => f.summary)
          .slice(0, 3)
          .join("; ")}.`
      : "- No high-severity feedback right now.",
    searches.length ? `- ${searches.length} recent searches logged.` : "- No searches logged yet (connect Supabase to persist history).",
  ];
  return NextResponse.json({ reply: lines.join("\n") });
}
