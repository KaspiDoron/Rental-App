// THE TRANSLATE LOOP THAT COULD NOT STOP.
//
// `t()` records every string it cannot translate in a `pending` set, and a
// 1.5-second sweep drains that set to /api/translate. Nothing ever removed a
// string that came back UNTRANSLATED - so the next render put it straight back
// into `pending`, the next sweep asked again, and the loop ran for as long as
// the page was open.
//
// Two ways that ended badly, both silent:
//
//   - No AI provider configured. The route answers with an `error` and an empty
//     map. The client broke out of its BATCH loop and the interval simply
//     re-ran 1.5s later, forever, on a feature that could not work at all.
//   - The daily cap reached. The route answers 429 with `{map:{}}` and NO error
//     field, so even that break never fired - just a request every 1.5 seconds,
//     indefinitely, for nothing.
//
// A retry needs a reason to expect a different answer. This decides, in one
// place, which failures are worth retrying and which are terminal for this
// session - and the terminal ones become a thing the traveller is TOLD, because
// silently showing English while claiming to support their language is how the
// whole feature looked dead in the field.

export type TranslateOutcome = "ok" | "retry" | "stop";

export interface TranslateResponseShape {
  map?: Record<string, string> | null;
  error?: string | null;
}

/**
 * What to do after one /api/translate call.
 *
 * `stop` means: nothing about this session will change the answer. Do not ask
 * again, and say so.
 */
export function translateOutcome(
  status: number,
  data: TranslateResponseShape | null
): TranslateOutcome {
  // The daily cap. It resets tomorrow, not in 1.5 seconds.
  if (status === 429) return "stop";
  // Signed out, or a language the server refuses - asking again cannot help.
  if (status === 401 || status === 400) return "stop";
  // An explicit error from the route is the "no provider configured" case.
  if (data?.error) return "stop";
  if (status >= 500) return "retry";
  if (!data || typeof data.map !== "object" || data.map === null) return "retry";
  return "ok";
}

/** The user-facing note for a terminal stop. Never a stack trace, never blank. */
export function unavailableNote(status: number, data: TranslateResponseShape | null): string {
  if (data?.error) return data.error;
  if (status === 429) {
    return "Today's translation budget is used up - the app stays in English until tomorrow. Everything else works normally.";
  }
  if (status === 401) return "Sign in again to keep the app in your language.";
  return "Translation is unavailable right now - showing English.";
}

/**
 * The strings still worth asking about.
 *
 * A string the server has already declined to translate is REMOVED from the
 * work, not left in the pending set to be asked about on every sweep for the
 * rest of the session. That single omission is what turned a miss into a loop.
 */
export function retriable(pending: Iterable<string>, failed: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const s of pending) if (!failed.has(s)) out.push(s);
  return out;
}

/**
 * The strings a response did NOT translate, so they can be retired.
 *
 * The route answers with only the entries it has, so anything asked for and
 * absent from the map is a miss - not an error, just an answer of "no".
 */
export function missedFrom(asked: string[], map: Record<string, string> | null | undefined): string[] {
  if (!map) return [...asked];
  return asked.filter((s) => !map[s]);
}
