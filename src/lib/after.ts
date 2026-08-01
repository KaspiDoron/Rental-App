// WORK THAT HAPPENS AFTER THE INTERESTING PART, AND STILL HAS TO HAPPEN.
//
// A push notification, a risk screen, an English gloss: none of them belong on
// the critical path of answering a shop, so each was written as
// `void (async () => { ... })()` - started, deliberately not awaited, left to
// finish on its own.
//
// On Cloud Run there is no "on its own". The container's CPU is throttled to
// ~0 the instant the HTTP response is flushed, so a detached promise stops
// wherever it happens to be: mid-fetch to the push service, mid-insert of the
// gloss. It does not fail - it simply never finishes, and nothing anywhere
// records that it did not. The tell is that the ONE push path the owner could
// test by hand (the test button) is awaited, so "push works" and "push arrives"
// were two different facts.
//
// Awaiting them is correct but not sufficient on its own: a hung provider must
// never hold a webhook open while WhatsApp waits for its 200. So each piece of
// after-work is awaited WITH A BUDGET - finished if it can be, abandoned if it
// cannot, never simply dropped on the floor by the platform.

/** Default ceiling for a single piece of after-work. Generous enough for an
 *  LLM round trip, short enough that Evolution never times out on us. */
export const AFTER_BUDGET_MS = 8_000;

/**
 * Run work that must complete before this request returns, bounded and never
 * throwing. Named so a slow one is greppable in the logs rather than anonymous.
 */
export async function finishBeforeResponse(
  label: string,
  work: () => Promise<unknown>,
  budgetMs: number = AFTER_BUDGET_MS
): Promise<void> {
  const started = Date.now();
  try {
    await Promise.race([
      work().catch((e) => {
        console.error(`[after:${label}]`, e instanceof Error ? e.message : e);
      }),
      new Promise<void>((r) => setTimeout(r, budgetMs)),
    ]);
  } catch (e) {
    console.error(`[after:${label}]`, e instanceof Error ? e.message : e);
  }
  const took = Date.now() - started;
  if (took >= budgetMs) console.warn(`[after:${label}] exceeded ${budgetMs}ms budget`);
}
