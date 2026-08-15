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

// ---------------------------------------------------------------------------
// W4.6 - THE LANGUAGE DOCTRINE, INVERTED
// ---------------------------------------------------------------------------
//
// Owner report 5, item 15, verbatim: "I want to make this feature better using
// ai, more local... if they answer in English we need to write them in local
// language - we are not speaking English only the local. If the shop writes us
// in English that they are not speaking the local language and only English we
// should move to English also but present the user in the status panel and the
// card map/vendor card that we switched to English because they are not
// speaking the local language."
//
// What shipped did the opposite. `agents.threadPrefersEnglish` flipped a thread
// to English on mere DEMONSTRATION - the shop's current inbound and its
// previous one both "looked English" - and, worse, on the very FIRST inbound
// with no prior at all, because the predicate treated "no previous message" as
// agreement. Half the shops in Thailand type "ok 300 per day" and every one of
// them silently ended the local-language feature for their thread.
//
// Two changes, and they are the whole doctrine:
//
//   1. REPLYING in English is not a statement ABOUT language. Only an explicit
//      one counts ("sorry, I don't speak Thai", "please write English"), and it
//      is read by the W4.3 comprehension pass - a typed model judgement over
//      the gloss, never a phrase list. The owner's standing rule: "In any
//      matter or issue that related to miss understand logic of our ai agents,
//      we should never use if/else."
//   2. It is a DECISION, not a per-turn recomputation. `threadPrefersEnglish`
//      was re-derived from scratch on every single turn from whatever the last
//      two messages happened to look like, so the same thread could flip back
//      and forth - the exact alternating-language bot tell the stickiness rules
//      above exist to prevent. The decision is stored on the thread
//      (`negotiation_threads.fields.language`) with WHY and WHEN.

/** Which language this thread's outbound messages are written in. */
export type ThreadLanguageMode = "local" | "english";

/** Why the thread is in that mode. Only `shop-asked` is a SWITCH. */
export type ThreadLanguageSwitchReason =
  | "default" // the hunt's own setting - nothing has been decided
  | "shop-asked" // the shop explicitly said they do not speak the local language
  | "shop-asked-local"; // ...or explicitly asked us back into the local language

/** The durable decision, stored on `negotiation_threads.fields.language`. */
export interface ThreadLanguage {
  mode: ThreadLanguageMode;
  reason: ThreadLanguageSwitchReason;
  /** ISO stamp of when the decision was taken. */
  at: string;
  /** The shop's own words, so the UI can quote rather than claim. */
  quote?: string;
}

/**
 * How sure the comprehension pass has to be that the shop STATED a language
 * preference before a thread changes language.
 *
 * Deliberately higher than the stance floor (0.6): the cost of a missed switch
 * is one more message in a language the shop can still read through their own
 * translate button, while the cost of a false switch is abandoning the single
 * feature the owner is asking us to make MORE local.
 */
export const LANGUAGE_STATEMENT_FLOOR = 0.7;

/** What the comprehension pass read, before this module decides anything. */
export interface LanguageStatement {
  prefers: ThreadLanguageMode;
  quote?: string;
  confidence: number;
}

/** Read a stored decision back defensively - the column is free-form JSON and
 *  rows written before W4.6 do not have it at all. */
export function threadLanguageFromStored(stored: unknown): ThreadLanguage | undefined {
  if (!stored || typeof stored !== "object") return undefined;
  const r = stored as Record<string, unknown>;
  if (r.mode !== "local" && r.mode !== "english") return undefined;
  const reason =
    r.reason === "shop-asked" || r.reason === "shop-asked-local" ? r.reason : "default";
  return {
    mode: r.mode,
    reason,
    at: typeof r.at === "string" ? r.at : new Date(0).toISOString(),
    ...(typeof r.quote === "string" && r.quote ? { quote: r.quote.slice(0, 200) } : {}),
  };
}

/**
 * THE DECISION. Pure, so the doctrine is testable without a model or a database.
 *
 * Returns the language this thread is in AFTER this turn. `changed` says whether
 * it is worth a write and a user-facing notice.
 *
 * DEGRADATION IS EXPLICIT. No AI means no statement, which means no change: the
 * thread keeps whatever it already decided, or the hunt's default. An outage can
 * never silently flip a thread's language, in either direction.
 */
export function nextThreadLanguage(args: {
  /** What the thread already decided, if anything. */
  persisted?: ThreadLanguage | null;
  /** The explicit statement this turn's comprehension pass read, if any. */
  statement?: LanguageStatement | null;
  /** A tick is our own timer firing - the shop said nothing, so nothing changes. */
  isTick?: boolean;
  /** The hunt's setting, used only when the thread has decided nothing yet. */
  localRequested: boolean;
  now: number;
}): { language: ThreadLanguage; changed: boolean } {
  const current: ThreadLanguage =
    args.persisted ?? {
      mode: args.localRequested ? "local" : "english",
      reason: "default",
      at: new Date(args.now).toISOString(),
    };

  // A TICK IS NOT A MESSAGE. The graph engine already guarded its flip against
  // ticks and the legacy loop did not, so the same thread could change language
  // depending on which engine happened to answer - the asymmetry this closes.
  if (args.isTick) return { language: current, changed: false };

  const st = args.statement;
  if (!st || st.confidence < LANGUAGE_STATEMENT_FLOOR) {
    return { language: current, changed: false };
  }
  if (st.prefers === current.mode) return { language: current, changed: false };

  return {
    language: {
      mode: st.prefers,
      reason: st.prefers === "english" ? "shop-asked" : "shop-asked-local",
      at: new Date(args.now).toISOString(),
      ...(st.quote ? { quote: st.quote.slice(0, 200) } : {}),
    },
    changed: true,
  };
}

/** Does this thread compose in English? (`undefined` = nothing decided yet.) */
export function threadWritesEnglish(lang: ThreadLanguage | null | undefined): boolean {
  return lang?.mode === "english";
}

/**
 * Is this a switch the TRAVELLER should be told about?
 *
 * Only an explicit request is - a thread that was English because the hunt was
 * English is not news. This is the fact the status panel and the vendor card
 * render; before W4.6 no language decision reached any surface at all (the
 * localize trace stage is filtered out of the feed and the one `overridden`
 * signal that WAS computed is discarded by its only caller).
 */
export function languageSwitchNotice(
  lang: ThreadLanguage | null | undefined
): { mode: ThreadLanguageMode; quote?: string } | null {
  if (!lang) return null;
  if (lang.reason !== "shop-asked" && lang.reason !== "shop-asked-local") return null;
  return { mode: lang.mode, ...(lang.quote ? { quote: lang.quote } : {}) };
}
