import { NextResponse } from "next/server";
import { webhookToken, sendFromUser } from "@/lib/evolution";
import { sbSelect, sbInsertClaim } from "@/lib/runtime-config";

// SELF-CHAINING QUEUE DRIVER - the fix for "I locked my phone and nothing
// sent for an hour". On Vercel Hobby there is no background worker: the
// queue only moved when someone's app polled or the external pinger fired.
// This route keeps a staggered batch progressing on its own:
//
//   1. drain whatever is due
//   2. if the NEXT row is due within this invocation's time budget, wait for
//      it in-process and drain again (covers one 45-75s stagger step)
//   3. if more work is due soon, fire ONE fire-and-forget call to itself
//      (hop-bounded) so the chain continues in a fresh invocation
//
// Safety: token-gated (same derived token as the webhook/ping), a global
// 30s claim slot means at most ONE chain runner exists at a time no matter
// how many kicks arrive, and the hop counter hard-bounds a runaway chain.
// The activity polls + external ping cron remain independent backstops.

const MAX_HOPS = 40; // ~30-40 min of autonomous progression per kick
const IN_CALL_BUDGET_MS = 45_000; // stay well inside maxDuration=60
const CHAIN_HORIZON_MS = 10 * 60_000; // chain only for work due soon

export async function GET(req: Request) {
  const url = new URL(req.url);
  const expected = await webhookToken();
  if (!expected || url.searchParams.get("token") !== expected) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const hop = Math.max(0, Number(url.searchParams.get("hop")) || 0);

  // ONE runner at a time: whoever wins this 30s slot drives; everyone else
  // exits immediately (kicks are cheap and frequent by design).
  let claim = await sbInsertClaim("wa_send_claims", {
    sender_key: "__chain__",
    slot_key: `chain:${Math.floor(Date.now() / 30_000)}`,
  });
  if (claim === "lost" && hop > 0) {
    // A chained hop may land inside its parent's 30s window - wait for the
    // next window and try once more so the chain survives the handoff.
    const nextWindow = (Math.floor(Date.now() / 30_000) + 1) * 30_000;
    await new Promise((r) => setTimeout(r, Math.max(0, nextWindow - Date.now()) + 250));
    claim = await sbInsertClaim("wa_send_claims", {
      sender_key: "__chain__",
      slot_key: `chain:${Math.floor(Date.now() / 30_000)}`,
    });
  }
  if (claim === "lost") return NextResponse.json({ ok: true, ran: false, why: "another runner" });

  const started = Date.now();
  let drained = 0;
  const drainOnce = async () => {
    try {
      const { drainOutbox } = await import("@/lib/wa-guard");
      drained += await drainOutbox((k, to, text) => sendFromUser(k, to, text));
      const { drainGraphWakeups } = await import("@/lib/graph/engine");
      drained += await drainGraphWakeups((k, to, text) => sendFromUser(k, to, text));
    } catch (e) {
      console.error("[wa:tick]", e instanceof Error ? e.message : e);
    }
  };
  const nextDueMs = async (): Promise<number | null> => {
    const rows = await sbSelect<{ not_before: string }>(
      "wa_outbox",
      "select=not_before&order=not_before.asc&limit=1"
    ).catch(() => []);
    const at = rows[0] ? Date.parse(rows[0].not_before) : NaN;
    return Number.isFinite(at) ? at - Date.now() : null;
  };

  await drainOnce();
  // Ride out short waits inside THIS invocation (one stagger step).
  for (;;) {
    const due = await nextDueMs();
    if (due === null) break; // queue empty - chain ends
    const remaining = IN_CALL_BUDGET_MS - (Date.now() - started);
    if (due > 0 && due < remaining) {
      await new Promise((r) => setTimeout(r, due + 500));
      await drainOnce();
      continue;
    }
    if (due <= 0 && remaining > 5_000) {
      // Due right now (guard may have re-queued forward) - one more pass.
      await drainOnce();
      const after = await nextDueMs();
      if (after !== null && after <= 0) break; // not progressing - stop
      continue;
    }
    break;
  }

  // Continue the chain in a fresh invocation while near-term work remains.
  const due = await nextDueMs();
  if (due !== null && due < CHAIN_HORIZON_MS && hop < MAX_HOPS) {
    fetch(
      `${url.origin}/api/wa/tick?token=${encodeURIComponent(expected)}&hop=${hop + 1}`
    ).catch(() => {});
    // Give the outgoing request a moment to actually leave this instance.
    await new Promise((r) => setTimeout(r, 350));
    return NextResponse.json({ ok: true, ran: true, drained, chained: true, hop });
  }
  return NextResponse.json({ ok: true, ran: true, drained, chained: false, hop });
}

export const maxDuration = 60;
