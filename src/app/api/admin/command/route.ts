import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { sbSelect } from "@/lib/runtime-config";

// Owner Command Center: one call that surfaces everything needing immediate
// attention - real bugs, stuck queues, WhatsApp health, low trust scores,
// billing activity - ranked by urgency.

export interface Alert {
  level: "critical" | "warning" | "info";
  title: string;
  detail: string;
  href?: string; // admin tab to jump to
}

export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const alerts: Alert[] = [];
  const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();

  const [feedback, outbox, reputation, sessions, billing, replies, offers, aiErrors] =
    await Promise.all([
      sbSelect<{ id: number; severity: string; summary: string; created_at: string }>(
        "feedback",
        `select=id,severity,summary,created_at&is_real_issue=eq.true&order=created_at.desc&limit=20`
      ).catch(() => []),
      sbSelect<{ id: number; not_before: string }>(
        "wa_outbox",
        "select=id,not_before&order=not_before.asc&limit=50"
      ).catch(() => []),
      sbSelect<{ sender_key: string; trust_score: number }>(
        "whatsapp_number_reputation",
        "select=sender_key,trust_score&trust_score=lt.15&limit=20"
      ).catch(() => []),
      sbSelect<{ email: string; status: string }>(
        "wa_sessions",
        "select=email,status&limit=100"
      ).catch(() => []),
      sbSelect<{ id: number; kind: string; created_at: string }>(
        "billing_events",
        `select=id,kind,created_at&created_at=gte.${encodeURIComponent(dayAgo)}&limit=50`
      ).catch(() => []),
      sbSelect<{ id: number }>(
        "vendor_replies",
        `select=id&created_at=gte.${encodeURIComponent(dayAgo)}&limit=200`
      ).catch(() => []),
      sbSelect<{ id: number }>(
        "offers",
        `select=id&created_at=gte.${encodeURIComponent(dayAgo)}&limit=200`
      ).catch(() => []),
      sbSelect<{ id: number; provider: string; ok: boolean; created_at: string }>(
        "ai_usage",
        `select=id,provider,ok,created_at&ok=eq.false&created_at=gte.${encodeURIComponent(dayAgo)}&limit=100`
      ).catch(() => []),
    ]);

  // Bugs first - real triaged issues are the owner's top priority.
  const highBugs = feedback.filter((f) => f.severity === "high");
  if (highBugs.length) {
    alerts.push({
      level: "critical",
      title: `${highBugs.length} high-severity bug${highBugs.length > 1 ? "s" : ""} reported`,
      detail: highBugs
        .slice(0, 3)
        .map((b) => b.summary)
        .join(" · "),
      href: "feedback",
    });
  } else if (feedback.length) {
    alerts.push({
      level: "warning",
      title: `${feedback.length} open feedback issue${feedback.length > 1 ? "s" : ""}`,
      detail: feedback.slice(0, 3).map((b) => b.summary).join(" · "),
      href: "feedback",
    });
  }

  // Stuck outbox: messages queued far in the past mean the drain is not firing.
  const overdue = outbox.filter(
    (o) => Date.parse(o.not_before) < Date.now() - 30 * 60_000
  );
  if (overdue.length) {
    alerts.push({
      level: "critical",
      title: `${overdue.length} queued WhatsApp message${overdue.length > 1 ? "s" : ""} overdue`,
      detail: "The outbox drain has not run for 30+ minutes - check the Evolution hosts.",
      href: "whatsapp",
    });
  } else if (outbox.length) {
    alerts.push({
      level: "info",
      title: `${outbox.length} message${outbox.length > 1 ? "s" : ""} queued for shop opening hours`,
      detail: "The anti-ban engine is pacing sends - all normal.",
      href: "whatsapp",
    });
  }

  // Numbers at ban risk.
  if (reputation.length) {
    alerts.push({
      level: "critical",
      title: `${reputation.length} WhatsApp number${reputation.length > 1 ? "s" : ""} at ban risk`,
      detail:
        "Trust score under 15 (lots of outbound, few replies): " +
        reputation.slice(0, 3).map((r) => `${r.sender_key} (${r.trust_score})`).join(", "),
      href: "data",
    });
  }

  // AI provider failures.
  if (aiErrors.length >= 5) {
    const byProvider = new Map<string, number>();
    aiErrors.forEach((e) => byProvider.set(e.provider, (byProvider.get(e.provider) ?? 0) + 1));
    alerts.push({
      level: "warning",
      title: `${aiErrors.length} AI calls failed in the last 24h`,
      detail: [...byProvider.entries()].map(([p, n]) => `${p}: ${n}`).join(", "),
      href: "keys",
    });
  }

  // Money.
  if (billing.length) {
    alerts.push({
      level: "info",
      title: `${billing.length} billing event${billing.length > 1 ? "s" : ""} in the last 24h`,
      detail: billing.slice(0, 4).map((b) => b.kind).join(" · "),
      href: "users",
    });
  }

  return NextResponse.json({
    alerts,
    stats: {
      waSessions: sessions.filter((s) => s.status === "open").length,
      repliesToday: replies.length,
      offersToday: offers.length,
      queuedMessages: outbox.length,
      openIssues: feedback.length,
    },
  });
}
