// A LIVE SEARCH MUST SURVIVE LEAVING THE TAB.
//
// The restore path was already there and already correct: the funnel writes the
// search to sessionStorage on every change and reads it back on mount. What it
// did not have was a BUDGET.
//
// The blob is the whole vendor list, and a real hunt carries ten to fifteen
// shops, each with a photo gallery, the exact message we sent, the shop's
// options and its reply text. That crosses the ~5MB sessionStorage quota
// somewhere in the middle of a busy search - and `setItem` does not fail
// quietly, it throws. The write sat inside `try { ... } catch {}`, so the throw
// became nothing at all: no save, no warning, and a traveller who tapped
// Profile and came back to an empty page. It failed hardest at exactly the
// moment the session was worth the most.
//
// So persistence is a budget, not a hope. Heavy fields are dropped first
// (galleries, then the message bodies), the shop list is capped, and the ladder
// keeps stepping down until the write actually lands. What comes back is always
// enough to rebuild the funnel: who the shops are, where they stand, and what
// they offered. The gallery reloads from the network; the search does not.
//
// Pure except for the storage handle, which is passed in - so the ladder is
// unit-tested rather than inferred from a quota error nobody can reproduce.

export interface PersistedSearch {
  vendors: unknown[];
  [k: string]: unknown;
}

/** Fields a restored card can happily re-fetch, in the order we give them up. */
const SHEDDABLE: string[][] = [
  ["photoUrls", "photos"],
  ["sentText", "sentTextLocal", "replyText", "lastInboundText"],
  ["options", "reviewsList", "hours"],
];

/** Beyond this many shops a restore is not worth a failed write. */
export const MAX_PERSISTED_VENDORS = 40;

function stripKeys(v: unknown, keys: string[]): unknown {
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = { ...(v as Record<string, unknown>) };
  for (const k of keys) delete out[k];
  return out;
}

/**
 * Progressively lighter snapshots of the same search, heaviest first.
 *
 * Every rung still carries the identity, the stage and the offer - the three
 * things the funnel cannot rebuild on its own. Nothing that matters is ever
 * traded away to make a write fit.
 */
export function snapshotLadder(state: PersistedSearch): PersistedSearch[] {
  const rungs: PersistedSearch[] = [state];
  let vendors = state.vendors;
  for (const keys of SHEDDABLE) {
    vendors = vendors.map((v) => stripKeys(v, keys));
    rungs.push({ ...state, vendors });
  }
  if (vendors.length > MAX_PERSISTED_VENDORS) {
    rungs.push({ ...state, vendors: vendors.slice(0, MAX_PERSISTED_VENDORS) });
  }
  return rungs;
}

export interface SaveResult {
  ok: boolean;
  /** Which rung of the ladder actually landed (0 = the full snapshot). */
  rung: number;
  bytes: number;
}

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * Write the search, shedding weight until it fits. Never throws.
 *
 * A failure here is a real event - the traveller's session is about to be lost -
 * so it is REPORTED rather than swallowed, and the caller decides what to say.
 */
export function saveSearch(
  store: StorageLike | undefined,
  key: string,
  state: PersistedSearch
): SaveResult {
  if (!store) return { ok: false, rung: -1, bytes: 0 };
  const rungs = snapshotLadder(state);
  for (let i = 0; i < rungs.length; i++) {
    let body: string;
    try {
      body = JSON.stringify(rungs[i]);
    } catch {
      continue; // a value that will not serialise - try the lighter rung
    }
    try {
      store.setItem(key, body);
      return { ok: true, rung: i, bytes: body.length };
    } catch {
      // Quota. Clear the stale copy so the next rung is measured against an
      // empty slot rather than against the one we are trying to replace.
      try {
        store.removeItem(key);
      } catch {
        /* nothing left to try */
      }
    }
  }
  return { ok: false, rung: -1, bytes: 0 };
}

export function loadSearch(store: StorageLike | undefined, key: string): PersistedSearch | null {
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedSearch;
    return parsed && Array.isArray(parsed.vendors) ? parsed : null;
  } catch {
    return null;
  }
}
