// RENDER ISOLATION: a poll that changes one shop must re-render one card.
//
// The vendor list scrolled like treacle, and the reason was not the card
// components. Two 6-second polls each did:
//
//     setVendors((vs) => vs.map((v) => ({ ...v, ...patch })))
//
// which allocates a NEW object for every shop on every tick, whether or not
// anything about that shop changed. `memo(VendorCard)` compares props by
// reference, so a new object is a new prop, so every card re-rendered - twenty
// cards, twice a cycle, forever. Add a fresh handler closure per render (fixed
// separately) and the memo was decorative.
//
// The missing capability is a RECONCILE step: the poll produces the state the
// server says is true, and this decides what actually changed. An unchanged
// shop keeps its exact object, so React skips it and the compositor has nothing
// to do. That is a contract, not an optimisation - and it is the only reason a
// list can stay smooth while a live poll runs underneath it.
//
// PURE, so the contract is testable rather than hoped for.

/** Fields that decide whether a rendered row would look any different. */
export type Fingerprint = string;

/**
 * Merge a patch into an item, returning the SAME REFERENCE when the patch
 * changes nothing observable. Compares by value, one level deep, because that
 * is the shape every one of these patches has.
 */
export function mergeIfChanged<T extends object>(current: T, patch: Partial<T>): T {
  let changed = false;
  for (const k of Object.keys(patch) as Array<keyof T>) {
    const next = patch[k];
    if (next === undefined) continue;
    if (!shallowEqual(current[k], next)) {
      changed = true;
      break;
    }
  }
  return changed ? { ...current, ...patch } : current;
}

/**
 * Reconcile a whole list. Returns the SAME ARRAY when no item changed, so a
 * `useMemo` or an effect keyed on the list is not woken either.
 */
export function reconcileList<T extends object>(
  items: T[],
  patchFor: (item: T, index: number) => Partial<T> | null | undefined
): T[] {
  let changed = false;
  const next = items.map((item, i) => {
    const patch = patchFor(item, i);
    if (!patch) return item;
    const merged = mergeIfChanged(item, patch);
    if (merged !== item) changed = true;
    return merged;
  });
  return changed ? next : items;
}

/**
 * The same contract for a KEYED LOOKUP rather than a list.
 *
 * `setAgentPending(payload.agentPending)` replaced the whole record - and every
 * value inside it - on every activity tick, so `agentPending[v.id]` was a brand
 * new object for every card twice a poll cycle. `memo(VendorCard)` compares
 * props by reference, so that single line un-memoised the entire board: exactly
 * the bug this module was written for, applied to `vendors` and missed on the
 * lookup handed alongside them.
 *
 * Returns the SAME record when nothing changed, and preserves the previous
 * reference for every entry whose value is unchanged, so a card whose shop did
 * not move is skipped even when a different shop did.
 */
export function reconcileRecord<T>(
  current: Record<string, T>,
  next: Record<string, T>
): Record<string, T> {
  let changed = false;
  const out: Record<string, T> = {};
  for (const key of Object.keys(next)) {
    const before = current[key];
    const after = next[key];
    if (key in current && shallowEqual(before, after)) {
      out[key] = before;
    } else {
      out[key] = after;
      changed = true;
    }
  }
  // A key that disappeared is a change too - a shop the agent has finished
  // with must stop reporting as busy.
  for (const key of Object.keys(current)) {
    if (!(key in next)) changed = true;
  }
  return changed ? out : current;
}

/** Value equality for the kinds of values these patches carry. */
function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => shallowEqual(v, (b as unknown[])[i]));
  }
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    shallowEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
  );
}

/**
 * How long a staggered list entrance may run in total.
 *
 * The stagger was `--i * 60ms` with no cap, so the twentieth card started
 * animating 1.14 SECONDS after the first and the last one finished at 2.34s -
 * two and a half seconds of continuous compositing on a phone, while the
 * traveller was already trying to scroll. A stagger is a flourish for the first
 * few rows; past that it is just work.
 */
export const MAX_STAGGER_INDEX = 6;

export function staggerIndex(i: number): number {
  return Math.min(Math.max(0, i), MAX_STAGGER_INDEX);
}
