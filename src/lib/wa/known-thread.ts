// "IS THIS ONE OF YOUR THREADS?" - and, crucially, WHICH stored number is it.
//
// Two routes send a message to a number the CLIENT supplied: the pickup-consent
// share (which reveals where the traveller is staying) and the close-deal
// handoff. Both guard it by proving the user's agent already messaged that
// number. The guard was an exact `to_number=eq.` match, and that made it fail in
// both directions at once:
//
//   - FALSE NEGATIVE (the common one): the same shop stored under a different
//     spelling - Google hands out national numbers, WhatsApp international ones
//     - failed its own guard, so a real close or a real location share was
//     refused with "not one of your negotiation threads".
//   - FALSE ROUTING: even when it passed, the message went to the CLIENT's
//     spelling rather than the one we actually hold.
//
// This resolves instead of merely checking: tolerant matching finds the thread,
// and the number that comes back is the one WE stored. A client can therefore
// only ever address a line we already negotiated with - never a near-miss it
// composed - which is a strictly stronger guarantee than the exact match gave.

import "server-only";
import { numberFilter, waDigits } from "./phone-key";

/**
 * The stored destination for a thread this user's agent really opened, or null.
 * Never throws; an unreadable database is treated as "unknown", so the guard
 * fails CLOSED.
 */
export async function resolveKnownThreadNumber(
  senderEmail: string,
  supplied: string
): Promise<string | null> {
  const digits = waDigits(supplied);
  if (!digits || !senderEmail) return null;
  const { sbSelect } = await import("../runtime-config");
  const rows = await sbSelect<{ to_number: string }>(
    "whatsapp_messages",
    `select=to_number&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
      senderEmail
    )}&order=received_at.desc&limit=1${numberFilter("to_number", digits)}`
  ).catch(() => [] as { to_number: string }[]);
  const stored = waDigits(rows[0]?.to_number ?? "");
  return stored || null;
}
