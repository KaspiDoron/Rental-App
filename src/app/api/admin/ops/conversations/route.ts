import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/session";
import { sbSelect } from "@/lib/runtime-config";

// Ops Center: every negotiation across ALL users, as a reviewable list.
// Owner-only - this is the internal quality-improvement surface, never a
// customer feature. Merges thread state + owner reviews + chief-judge
// verdicts + the latest message snippet, all app-side over capped selects.

interface ThreadRow {
  thread_key: string;
  user_email: string;
  vendor_id: string | null;
  vendor_name: string | null;
  to_number: string;
  phase: string;
  fields: Record<string, unknown> | null;
  updated_at: string;
}

interface ReviewRow {
  thread_key: string;
  decision_id: string | null;
  rating: number | null;
  status: string;
  bookmark: boolean;
  source: string;
  auto_reason: string | null;
  created_at: string;
}

interface ChiefRow {
  thread_key: string;
  scores: Record<string, number> | null;
  verdict: string | null;
  created_at: string;
}

interface MsgRow {
  to_number: string;
  from_number: string | null;
  body: string | null;
  direction: string;
  received_at: string;
}

export async function GET(req: Request) {
  const session = await requireOwner();
  if (!session) return NextResponse.json({ error: "Owner only." }, { status: 403 });

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  const onlyFlagged = url.searchParams.get("flagged") === "1";
  const onlyBookmarked = url.searchParams.get("bookmarked") === "1";
  const limit = Math.min(120, Math.max(1, Number(url.searchParams.get("limit") ?? 60)));

  const [threads, reviews, chiefs, msgs] = await Promise.all([
    sbSelect<ThreadRow>(
      "negotiation_threads",
      "select=thread_key,user_email,vendor_id,vendor_name,to_number,phase,fields,updated_at&order=updated_at.desc&limit=120"
    ).catch(() => []),
    sbSelect<ReviewRow>(
      "agent_reviews",
      "select=thread_key,decision_id,rating,status,bookmark,source,auto_reason,created_at&order=created_at.desc&limit=400"
    ).catch(() => []),
    sbSelect<ChiefRow>(
      "agent_scores",
      "select=thread_key,scores,verdict,created_at&scorer=eq.chief-judge&order=created_at.desc&limit=200"
    ).catch(() => []),
    sbSelect<MsgRow>(
      "whatsapp_messages",
      "select=to_number,from_number,body,direction,received_at&order=received_at.desc&limit=400"
    ).catch(() => []),
  ]);

  // Newest chief verdict per thread.
  const chiefBy = new Map<string, ChiefRow>();
  for (const c of chiefs) if (!chiefBy.has(c.thread_key)) chiefBy.set(c.thread_key, c);

  // Review aggregate per thread.
  const revBy = new Map<
    string,
    { ratings: number[]; open: number; bookmark: boolean; autoReasons: string[]; count: number }
  >();
  for (const r of reviews) {
    const agg =
      revBy.get(r.thread_key) ??
      ({ ratings: [], open: 0, bookmark: false, autoReasons: [], count: 0 } as {
        ratings: number[];
        open: number;
        bookmark: boolean;
        autoReasons: string[];
        count: number;
      });
    agg.count++;
    if (typeof r.rating === "number") agg.ratings.push(r.rating);
    if (r.status === "flagged" || r.status === "auto_flagged" || r.status === "open") agg.open++;
    if (r.bookmark) agg.bookmark = true;
    if (r.source === "auto" && r.auto_reason && agg.autoReasons.length < 3)
      agg.autoReasons.push(r.auto_reason);
    revBy.set(r.thread_key, agg);
  }

  // Latest message per shop number (thread digits).
  const lastMsg = new Map<string, MsgRow>();
  for (const m of msgs) {
    const digits = m.direction === "inbound" ? m.from_number ?? "" : m.to_number;
    if (digits && !lastMsg.has(digits)) lastMsg.set(digits, m);
  }

  const out = threads
    .map((t) => {
      const f = (t.fields ?? {}) as {
        rounds?: number;
        pricePerDay?: number;
        currency?: string;
        declined?: boolean;
        presented?: boolean;
        firmCount?: number;
        dealComplete?: boolean;
      };
      const agg = revBy.get(t.thread_key);
      const chief = chiefBy.get(t.thread_key);
      const last = lastMsg.get(t.to_number);
      return {
        threadKey: t.thread_key,
        userEmail: t.user_email,
        vendorId: t.vendor_id,
        vendorName: t.vendor_name || `+${t.to_number}`,
        phase: t.phase,
        updatedAt: t.updated_at,
        rounds: f.rounds ?? 0,
        pricePerDay: f.pricePerDay ?? null,
        currency: f.currency ?? null,
        declined: f.declined === true,
        dealComplete: f.dealComplete === true,
        avgRating: agg?.ratings.length
          ? Number((agg.ratings.reduce((a, b) => a + b, 0) / agg.ratings.length).toFixed(1))
          : null,
        reviewCount: agg?.count ?? 0,
        openFlags: agg?.open ?? 0,
        bookmark: agg?.bookmark ?? false,
        autoReasons: agg?.autoReasons ?? [],
        judge: chief
          ? { outcomeDelta: chief.scores?.outcomeDelta ?? null, verdict: chief.verdict }
          : null,
        lastMsg: last
          ? {
              dir: last.direction === "inbound" ? "in" : "out",
              text: (last.body ?? "").slice(0, 140),
              at: last.received_at,
            }
          : null,
      };
    })
    .filter((t) => {
      if (onlyFlagged && t.openFlags === 0) return false;
      if (onlyBookmarked && !t.bookmark) return false;
      if (q) {
        const hay = `${t.vendorName} ${t.userEmail} ${t.phase}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .slice(0, limit);

  return NextResponse.json({ threads: out });
}

export const maxDuration = 60;
