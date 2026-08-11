import "server-only";
import { getConfig } from "./runtime-config";
import { SEARCH_SESSION_TTL_MS, parseSessionTtl } from "./session-life";

// The server-side read of the search-session TTL, kept in its own module so the
// arithmetic in ./session-life stays importable from the browser. Splitting them
// is not ceremony: `runtime-config` pulls in `server-only`, and the client
// rehydrate on the Find-deals page has to run the SAME freshness predicate the
// route handlers run, or the two disagree and the bug comes back on one side.

/**
 * How long a search stays "the live hunt", in ms.
 *
 * Owner-tunable via `SEARCH_SESSION_TTL_HOURS` in Admin -> Keys, clamped to a
 * sane band by `parseSessionTtl`. An unreadable vault resolves to the default
 * rather than throwing: a config wobble must not make every session look stale
 * (which would wipe the workspace of everyone mid-hunt) and must not make every
 * session look live (which is the original bug).
 */
export async function searchSessionTtlMs(): Promise<number> {
  try {
    return parseSessionTtl(await getConfig("SEARCH_SESSION_TTL_HOURS"));
  } catch {
    return SEARCH_SESSION_TTL_MS;
  }
}
