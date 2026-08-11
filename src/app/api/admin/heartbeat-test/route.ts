import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";

export const dynamic = "force-dynamic";

// "IS THE MACHINERY ALIVE?" - ASKED DIRECTLY, FROM THE PHONE.
//
// The owner's self-check showed a red heartbeat and there was no way to tell
// which of two very different things it meant:
//
//   * nothing is CALLING the drain (no scheduler job exists), or
//   * the drain itself is broken (it runs and does nothing, or throws).
//
// The first is an infrastructure gap the deploy fixes; the second is a bug.
// Waiting for a cron to prove which one is a slow way to learn it, and there
// was no other way to run the drain by hand from an iPhone.
//
// This runs EXACTLY what the cron runs, in the foreground, and reports what it
// did - including the breadcrumb write, so a successful tap also turns the
// heartbeat tile green and proves the whole chain end to end.
export async function POST() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const started = Date.now();
  const steps: Array<{ step: string; ok: boolean; detail: string }> = [];

  let drained = 0;
  try {
    const { drainOutbox } = await import("@/lib/wa-guard");
    const { sendFromUser } = await import("@/lib/evolution");
    drained = await drainOutbox((senderKey, to, text, lane) =>
      sendFromUser(senderKey, to, text, true, { lane })
    );
    steps.push({
      step: "outbox drain",
      ok: true,
      detail: drained > 0 ? `sent ${drained} queued message(s)` : "nothing was due",
    });
  } catch (e) {
    steps.push({
      step: "outbox drain",
      ok: false,
      detail: e instanceof Error ? e.message.slice(0, 200) : "failed",
    });
  }

  let wakeups = 0;
  try {
    const { drainGraphWakeups } = await import("@/lib/graph/engine");
    const { sendFromUser } = await import("@/lib/evolution");
    wakeups = await drainGraphWakeups((senderKey, to, text) =>
      sendFromUser(senderKey, to, text, true, { lane: "reply" })
    );
    steps.push({
      step: "scheduled follow-ups",
      ok: true,
      detail: wakeups > 0 ? `ran ${wakeups} due turn(s)` : "none were due",
    });
  } catch (e) {
    steps.push({
      step: "scheduled follow-ups",
      ok: false,
      detail: e instanceof Error ? e.message.slice(0, 200) : "failed",
    });
  }

  // The same breadcrumb the cron writes, so a manual run counts as a heartbeat
  // and the tile above it turns green on the next refresh.
  try {
    const { sbInsert } = await import("@/lib/runtime-config");
    await sbInsert("agent_events", [
      {
        kind: "cron-ping",
        detail: JSON.stringify({ drained, wakeups, manual: true, by: session.email }),
      },
    ]);
    steps.push({ step: "heartbeat breadcrumb", ok: true, detail: "recorded" });
  } catch (e) {
    steps.push({
      step: "heartbeat breadcrumb",
      ok: false,
      detail: e instanceof Error ? e.message.slice(0, 200) : "could not record",
    });
  }

  const ok = steps.every((s) => s.ok);
  return NextResponse.json({
    ok,
    tookMs: Date.now() - started,
    drained,
    wakeups,
    steps,
    verdict: ok
      ? "The drain works. If the heartbeat still reads stale later, the problem is the SCHEDULE, not the machinery."
      : "The drain itself failed - see the failing step.",
  });
}
