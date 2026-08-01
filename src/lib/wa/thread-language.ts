import "server-only";
import { numberFilter, waDigits } from "./phone-key";

// A THREAD IS OPENED IN ONE LANGUAGE AND STAYS IN IT.
//
// The local-language toggle is a global switch on the search screen. The
// traveller flips it after the batch has gone out - out of curiosity, or by
// accident, or because they want to read the next one in English - and every
// SUBSEQUENT message in every already-open thread switches language mid
// conversation. From the shop's side, the person they have been messaging in
// Thai for ten minutes suddenly writes in English, then Thai again. That does
// not read as a bilingual customer; it reads as a bot, which is the one thing
// this entire anti-fingerprinting effort exists to avoid.
//
// The fix is not another flag. The language of a thread is already recorded -
// every outbound row stamps `localLang` in its raw payload - so the thread's
// FIRST message is the authority, and the live toggle only decides the language
// of threads that have not started yet. The client greys the switch once a
// hunt is under way; this is the half that cannot be bypassed by a stale tab,
// a replayed request or a second device.

/**
 * The language this thread was opened in, or null when it has not started.
 *
 * `null` means the caller's own preference applies - there is no history to
 * honour yet. Never throws: an unreadable database returns null, which
 * degrades to today's behaviour rather than silently flipping a live thread.
 */
export async function threadLanguageMode(
  senderEmail: string,
  toNumber: string
): Promise<boolean | null> {
  const digits = waDigits(toNumber);
  if (!digits || !senderEmail) return null;
  try {
    const { sbSelect } = await import("../runtime-config");
    // OLDEST first: the opener decides. The newest row would be the previous
    // message, which is the same thing until someone flips the toggle twice.
    const rows = await sbSelect<{ raw: { localLang?: unknown } | null }>(
      "whatsapp_messages",
      `select=raw&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
        senderEmail
      )}&order=received_at.asc&limit=1${numberFilter("to_number", digits)}`
    );
    const first = rows[0]?.raw;
    if (!first || typeof first.localLang !== "boolean") return null;
    return first.localLang;
  } catch {
    return null;
  }
}

/**
 * Resolve the language for THIS send.
 *
 * `requested` is what the client asked for; `established` is what the thread
 * was opened in. The thread wins whenever it has an answer - including when it
 * says English and the toggle now says local, which is the direction people
 * actually hit (turn it on mid-hunt to "improve" the open conversations).
 */
export function resolveThreadLanguage(args: {
  requested: boolean;
  established: boolean | null;
}): { localLang: boolean; overridden: boolean } {
  if (args.established === null) return { localLang: args.requested, overridden: false };
  return {
    localLang: args.established,
    overridden: args.established !== args.requested,
  };
}
