// BOUNDED PARALLELISM, FOR WORK THAT IS SLOW BUT NOT SHARED.
//
// The mass-dispatch route localized every shop's opener in a serial `for`
// loop: one LLM round trip per shop, awaited before the next began. At Ultra's
// 24-shop batch that is 24 sequential model calls inside a 60-second request
// ceiling, so the batch could not finish and the shops at the tail were never
// queued at all - the traveller saw a partial hunt with no error.
//
// Unbounded `Promise.all` is not the answer either: 24 simultaneous calls trip
// per-provider rate limits and turn a latency problem into a 429 storm.
//
// So: a small pool. Order of RESULTS is always input order, whatever order the
// work finishes in - callers depend on that (a shop's opener must land on that
// shop's row).

/**
 * Map `items` through `fn`, running at most `limit` at a time.
 *
 * Results are returned in INPUT order. A rejection propagates, like
 * `Promise.all` - callers that want per-item tolerance catch inside `fn`.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return out;
}
