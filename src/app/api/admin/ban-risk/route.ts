import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { riskReport, rollupBucket } from "@/lib/wa/risk-rollup";
import { fleetTruth } from "@/lib/wa/fleet-truth";
import { transportSummary } from "@/lib/wa/proxy";

export const dynamic = "force-dynamic";

/**
 * THE BAN RISK DASHBOARD, read side. Owner-gated, opened by a human, never
 * polled.
 *
 * At most FOUR Supabase round trips regardless of how many accounts exist,
 * because it reads the hourly rollup and never the event table.
 * `/api/activity` is the counter-example already in this repo - ~21 round trips
 * per tick plus two awaited eight-second WhatsApp drains before it reads
 * anything - and at fleet scale a live fan-out monitor becomes the load it
 * monitors.
 *
 * `fleetTruth()` is one HTTP call per Evolution host and returns null rather
 * than an empty fleet when it cannot read, so the panel can go dark instead of
 * reporting a healthy zero.
 */
export async function GET(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const hours = Math.min(168, Math.max(1, Number(url.searchParams.get("hours") ?? 24) || 24));

  const [report, fleet, transport] = await Promise.all([
    riskReport(Date.now(), hours),
    fleetTruth().catch(() => null),
    transportSummary().catch(() => null),
  ]);

  return NextResponse.json({
    report,
    // null means UNREADABLE, and the panel renders it as such. It is emphatically
    // not "no instances" - a fleet of two hundred reading zero because every host
    // timed out is the single most dangerous number this screen could show.
    fleet,
    // Transport tiles (Tier 3): configured? verified exits? "not configured" is
    // a first-class state, never a red dot, because with the paid proxy cut it
    // is the expected baseline.
    transport,
    hours,
    // THE FOOTER IS PART OF THE CONTRACT, not decoration. Nothing on this
    // screen reduces the probability of Meta restricting a number. What it does
    // is shorten the gap between Meta pushing back and the owner knowing, and
    // a dashboard that lets anyone believe otherwise is worse than none.
    disclaimer:
      "Nothing on this page reduces the chance of a number being restricted. It shortens the time between WhatsApp pushing back and you knowing.",
  });
}

/**
 * Compute the closed hour. Called by the scheduler; also usable by hand from
 * the panel when a bucket is visibly missing.
 *
 * Management-gated rather than open, because a public rollup endpoint is a free
 * way to make the database do work.
 */
export async function POST() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const snap = await rollupBucket(Date.now());
  return NextResponse.json({ ok: Boolean(snap), snapshot: snap });
}
