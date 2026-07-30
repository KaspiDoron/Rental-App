// Persistent acknowledgements for the "Removed by you" notice.
//
// The old dismissal was a bare in-memory Set: TabBar navigation is a full
// document load, the vendor list (with cancelled=true) is restored from
// sessionStorage, and the dismissal was not - so one hop to Deals brought
// the whole notice back and DISMISS read as "does nothing". The set now
// persists beside the search blob it acknowledges.
//
// Keys carry the tombstone's timestamp, so dismissing today's removal does
// NOT swallow a LATER removal of the same shop - that is a new fact and the
// notice must return carrying it.
//
// Pure + storage-injectable so it is unit-testable in node (no jsdom
// harness in this repo).

export interface DismissalStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORE_KEY = "wd_removed_dismissed";
const CAP = 200;

/** One acknowledgement = one (vendor, tombstone-instant) pair. */
export function dismissalKey(vendorId: string, cancelledAt?: string | null): string {
  return `${vendorId}|${cancelledAt ?? "local"}`;
}

export function loadDismissals(store: DismissalStore | null): Set<string> {
  if (!store) return new Set();
  try {
    const raw = store.getItem(STORE_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveDismissals(store: DismissalStore | null, keys: Set<string>): void {
  if (!store) return;
  try {
    // Bounded: newest acknowledgements win; an unbounded list would grow for
    // the life of the browser session.
    store.setItem(STORE_KEY, JSON.stringify([...keys].slice(-CAP)));
  } catch {
    /* storage full/blocked - the in-memory set still works for this page */
  }
}
