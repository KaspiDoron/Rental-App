import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { lifecycleReport } from "@/lib/lifecycle";
import { WARMUP_DEFAULTS, warmupGateOn } from "@/lib/warmup";
import { getConfig } from "@/lib/runtime-config";

export const dynamic = "force-dynamic";

/**
 * Monetization + lifecycle. Admin only.
 *
 * Deliberately NOT wired into any polling surface. `/api/activity` costs ~21
 * Supabase round trips per tick, and the lesson from it is that a monitor which
 * fans out at fleet scale becomes the load it monitors. This route is opened by
 * a human, answers from bounded reads, and is never called on an interval.
 */
export async function GET() {
  const session = await requireManagement();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const report = await lifecycleReport();

  // The live thresholds travel with the report, because every number above is
  // only interpretable against the predicate that produced it. Reading "p90 is
  // 40 hours" without knowing the gate asks for three shops is not a finding.
  const [gateOn, minSearches, minEngaged, minReplies, holdoutPct, holdoutList] = await Promise.all([
    warmupGateOn(),
    getConfig("WARMUP_MIN_SEARCHES"),
    getConfig("WARMUP_MIN_ENGAGED"),
    getConfig("WARMUP_MIN_REPLIES"),
    getConfig("WARMUP_HOLDOUT_PCT"),
    getConfig("WARMUP_HOLDOUT_LIST"),
  ]);

  return NextResponse.json({
    ...report,
    gate: {
      on: gateOn,
      searches: Number(minSearches) || WARMUP_DEFAULTS.WARMUP_MIN_SEARCHES,
      engaged: Number(minEngaged) || WARMUP_DEFAULTS.WARMUP_MIN_ENGAGED,
      replies: Number(minReplies) || WARMUP_DEFAULTS.WARMUP_MIN_REPLIES,
      holdoutPct: Number(holdoutPct) || 0,
      // Count only - the emails are not needed to operate the screen, and an
      // admin surface should not hand out a user list it has no use for.
      holdoutNamed: (holdoutList ?? "").split(/[,\n]/).filter((s) => s.trim()).length,
    },
  });
}
