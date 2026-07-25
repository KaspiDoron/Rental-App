// J: data-driven "counter-offer" detection.
//
// A thread is in the "counter-offer" stage once the agent has sent a bargain
// move AFTER the shop's opening quote this session - i.e. an outbound bargain
// FOLLOWING an inbound price. This is DERIVED from real rows, never a cosmetic
// label. Two independent signals, either of which is sufficient:
//   1. an `offers` row with round >= 1 - the round counter increments on every
//      agent bargain ask (nodes.ts fieldsPatch rounds+1), so round>=1 means we
//      have already countered this thread; or
//   2. an outbound bargain (raw.kind auto-bargain/bargain) whose timestamp is
//      AFTER the vendor's earliest inbound reply/quote (we replied to a quote
//      with a counter).
//
// Pure + dependency-free so it unit-tests without the route. The activity route
// emits the result as a SEPARATE signal (not folded into the messaged<active<
// offer rank) so it never blocks the priced offer from surfacing on the card -
// the client only relabels the STAGE while the offer/price still shows.

export interface CounterOfferInputs {
  offers: { vendor_id: string | null; round: number | null; created_at: string }[];
  replies: { vendor_id: string | null; created_at: string }[];
  outbound: { raw: { vendorId?: string; kind?: string } | null; received_at: string }[];
}

const BARGAIN_KINDS = new Set(["auto-bargain", "bargain"]);

export function deriveCountered(input: CounterOfferInputs): string[] {
  // Earliest inbound signal (reply or quote) per vendor.
  const earliestInboundAt: Record<string, string> = {};
  const noteInbound = (id: string | null | undefined, at: string) => {
    if (!id || !at) return;
    if (!earliestInboundAt[id] || at < earliestInboundAt[id]) earliestInboundAt[id] = at;
  };
  for (const r of input.replies) noteInbound(r.vendor_id, r.created_at);
  for (const o of input.offers) noteInbound(o.vendor_id, o.created_at);

  const countered = new Set<string>();
  // Signal 1: a re-quote round (agent already asked for a better price).
  for (const o of input.offers) {
    if (o.vendor_id && (o.round ?? 0) >= 1) countered.add(o.vendor_id);
  }
  // Signal 2: an outbound bargain timestamped after the shop's first quote.
  for (const m of input.outbound) {
    const vid = m.raw?.vendorId;
    const kind = m.raw?.kind;
    if (!vid || !kind || !BARGAIN_KINDS.has(kind)) continue;
    const firstIn = earliestInboundAt[vid];
    if (firstIn && m.received_at > firstIn) countered.add(vid);
  }
  return [...countered].sort();
}
