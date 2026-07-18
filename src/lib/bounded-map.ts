// A tiny FIFO size-bound for the process-lifetime `globalThis.__wd_*` Maps that
// are used as best-effort per-user / per-thread caches. On a long-lived server
// (the Render-hosted worker, or any non-recycled runtime) these otherwise grow
// one entry per distinct user/thread FOREVER - a slow memory leak that only
// shows up after days of traffic. This caps them: once the map exceeds `cap`,
// the oldest-inserted entries are evicted until it is back under the cap. Maps
// iterate in insertion order, so the first key is the oldest.
//
// These caches are all either authoritative-in-Supabase fallbacks or short-TTL
// freshness caches, so evicting a cold entry is always safe - the value is
// re-derived from the DB (or recomputed) on the next access.

export function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, cap: number): void {
  // Re-insert moves the key to the newest position (delete-then-set), so a hot
  // key is not evicted just because it was created early - approximate LRU.
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  if (map.size > cap) {
    const overflow = map.size - cap;
    let removed = 0;
    for (const k of map.keys()) {
      if (removed++ >= overflow) break;
      map.delete(k);
    }
  }
}
