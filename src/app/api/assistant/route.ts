import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { analytics } from "@/lib/memory";
import { listUsers } from "@/lib/access";
import { sbSelect } from "@/lib/runtime-config";
import { chat, type ChatMessage } from "@/lib/ai";

// Two assistants behind one route, BOTH management-only (item #9 - plans
// never grant the AI co-manager):
//  - OWNER: the "Deals" co-manager with full operational visibility.
//  - ADMIN: an order-status assistant scoped STRICTLY to the caller's own
//    offers, replies and bookings.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const isOwner = session.role === "owner";
  if (session.role === "user") {
    return NextResponse.json(
      { error: "The AI co-manager is available to management only." },
      { status: 403 }
    );
  }
  const { messages } = (await req.json().catch(() => ({}))) as {
    messages?: { role: "user" | "assistant"; content: string }[];
  };

  // ---- Traveller mode: private, scoped to the caller's own rows -------------
  if (!isOwner) {
    const me = encodeURIComponent(session.email);
    const [myOffers, myReplies, myBookings] = await Promise.all([
      sbSelect(
        "offers",
        `select=vendor_name,price_per_day,currency,verified,deposit_note,created_at&user_email=eq.${me}&simulated=eq.false&order=created_at.desc&limit=15`
      ).catch(() => [] as Record<string, unknown>[]),
      sbSelect(
        "vendor_replies",
        `select=vendor_name,reply_text,price_per_day,found,created_at&user_email=eq.${me}&order=created_at.desc&limit=15`
      ).catch(() => [] as Record<string, unknown>[]),
      sbSelect(
        "bookings",
        `select=vendor_name,total_price,status,scheduled_at,created_at&user_email=eq.${me}&order=created_at.desc&limit=10`
      ).catch(() => [] as Record<string, unknown>[]),
    ]);
    const userContext = JSON.stringify(
      { myOffers, myShopReplies: myReplies, myBookings },
      null,
      1
    );
    const userSystem =
      "You are the WheelDeal trip assistant for ONE traveller. You see ONLY " +
      "their own rental search data below - their offers, the shops' replies " +
      "and their bookings. Answer their order-status questions concretely: " +
      "which shops replied, best price so far (in the shop's own currency, " +
      "never convert), what is still pending, and one clear suggested next " +
      "step. MAX 5 short lines, plain text, no markdown, warm and practical.\n\n" +
      "THEIR DATA:\n" +
      userContext;
    const userHistory: ChatMessage[] = [
      { role: "system", content: userSystem },
      ...(messages ?? []).slice(-12).map((m) => ({
        role: m.role,
        content: String(m.content).slice(0, 2000),
      })),
    ];
    if (userHistory.length === 1) {
      userHistory.push({ role: "user", content: "What's the status of my requests?" });
    }
    const userReply = await chat(userHistory);
    if (userReply) {
      const { sanitizeAiText } = await import("@/lib/text");
      return NextResponse.json({ reply: sanitizeAiText(userReply) });
    }
    // Deterministic fallback when no AI key is live.
    const best = (myOffers as { vendor_name?: string; price_per_day?: number; currency?: string }[])
      .filter((o) => o.price_per_day)
      .sort((a, b) => (a.price_per_day ?? 0) - (b.price_per_day ?? 0))[0];
    return NextResponse.json({
      reply: [
        `Offers so far: ${myOffers.length}. Shop replies: ${myReplies.length}. Bookings: ${myBookings.length}.`,
        best
          ? `Best price: ${best.price_per_day} ${best.currency ?? ""} at ${best.vendor_name}.`
          : "No prices yet - your agents are waiting on the shops.",
        "Tip: shops answer fastest during their local daytime.",
      ].join("\n"),
    });
  }

  // Assemble the operational context the assistant can see.
  const a = analytics();
  const users = await listUsers();
  const [feedback, searches, offers, waMessages, bookings] = await Promise.all([
    sbSelect("feedback", "select=category,summary,severity,is_real_issue,created_at&order=created_at.desc&limit=15"),
    sbSelect("searches", "select=vehicle_class,source,results,created_at&order=created_at.desc&limit=20"),
    sbSelect("offers", "select=vendor_name,price_per_day,simulated,verified,created_at&order=created_at.desc&limit=20"),
    // Marker rows (session/takeover/cancel flags) are plumbing, not chat.
    sbSelect(
      "whatsapp_messages",
      "select=direction,body,received_at&to_number=not.in.(session,takeover,cancel)&order=received_at.desc&limit=15"
    ),
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
    "You are Deals, WheelDeal's co-manager, reporting to the owner. " +
    "STRICT BREVITY: default answers are MAX 5 short lines. Lead with the " +
    "single most important thing, then at most 3 bullet-style lines (simple " +
    "dashes), each one fact + one suggested action. No intros, no summaries, " +
    "no repetition. Only go longer if the owner explicitly asks you to " +
    "elaborate. Plain text only - never markdown, asterisks, backticks or " +
    "hashes. Use the operational data below; cite concrete numbers." +
    "\n\nOPERATIONAL DATA:\n" +
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

// Vercel: allow slow AI/WhatsApp upstreams (Hobby default is ~10s - too short).
export const maxDuration = 60;
