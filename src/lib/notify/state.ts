// The facts `worthAnInterruption` judges against, read from what the search has
// already produced. Derived per push rather than stored - the same discipline
// as everywhere else here, so there is no counter to keep in sync and nothing
// that can drift from what the traveller actually saw.

import "server-only";
import type { NotifyState } from "./significance";

/** How far back "already interrupted enough for one search" looks. */
export const NOTIFY_WINDOW_SEC = 3600;

const EMPTY: NotifyState = { anyReplyYet: false, sentInWindow: 0 };

export async function notifyState(email: string, nowMs = Date.now()): Promise<NotifyState> {
  if (!email) return EMPTY;
  const { sbSelect } = await import("../runtime-config");
  const since = new Date(nowMs - NOTIFY_WINDOW_SEC * 1000).toISOString();
  const who = encodeURIComponent(email);

  const [sent, best, anyReply] = await Promise.all([
    sbSelect<{ id: number }>(
      "agent_events",
      `select=id&kind=eq.push-sent&user_email=eq.${who}&created_at=gte.${encodeURIComponent(
        since
      )}&limit=20`
    ).catch(() => [] as { id: number }[]),
    sbSelect<{ price_per_day: number | null; currency: string | null }>(
      "vendor_replies",
      `select=price_per_day,currency&user_email=eq.${who}&found=is.true&price_per_day=not.is.null&order=price_per_day.asc&limit=1`
    ).catch(() => [] as { price_per_day: number | null; currency: string | null }[]),
    sbSelect<{ id: number }>("vendor_replies", `select=id&user_email=eq.${who}&limit=1`).catch(
      () => [] as { id: number }[]
    ),
  ]);

  return {
    sentInWindow: sent.length,
    bestPricePerDay: best[0]?.price_per_day ?? undefined,
    bestCurrency: best[0]?.currency ?? undefined,
    anyReplyYet: anyReply.length > 0,
  };
}

/** Record that we spent one of the traveller's interruptions, and on what. */
export async function markPushSent(email: string, reason: string): Promise<void> {
  if (!email) return;
  const { sbInsert } = await import("../runtime-config");
  await sbInsert("agent_events", [
    { kind: "push-sent", user_email: email, vendor_id: "", vendor_name: "", detail: reason.slice(0, 200) },
  ]).catch(() => {});
}
