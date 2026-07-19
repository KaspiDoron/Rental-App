// Multi-message inbound coalescing - the fix for the "dropped price" data loss.
//
// A rental shop frequently answers in a BURST of separate WhatsApp messages
// ("Good day!" / "We have available Fazzio" / "Regular rate is 550, we can give
// you 400 per day"), each arriving as its own webhook. Extracting from a single
// frame binds a bare price to no vehicle (matchesSpec=false -> the offer is
// dropped, the UI stays on "No price yet"). Coalescing the whole UNREAD inbound
// buffer (everything the shop sent since OUR last outbound) into one
// chronological blob lets a single extraction see the vehicle AND its price.
//
// Pure + unit-tested: shared by the live ingestion path (agent-loop) and the
// strategic-wait tick path (engine) so both behave identically.

export interface CoalesceMsg {
  direction: "inbound" | "outbound";
  body: string | null;
  received_at: string; // ISO
}

/**
 * Concatenate the shop's unread inbound messages (strictly AFTER our last
 * outbound) chronologically. `currentText` is appended when the just-arrived
 * message's row is not yet visible to the read (concurrent webhooks). Capped to
 * the last few frames and a char budget so a chatty shop cannot inflate the
 * extraction prompt.
 */
// A pure media placeholder ("[photo]", "[voice note]") or the synthetic
// "(the shop sent a photo... couldn't be loaded)" carries no extractable text
// and must not crowd out real frames or bypass the crafted photo fallback.
const PLACEHOLDER = /^\[[^\]]{0,20}\]$|^\(the shop sent\b/i;

export function coalesceUnreadInbound(
  thread: CoalesceMsg[],
  lastOutboundAt: string,
  currentText?: string,
  opts: { maxFrames?: number; maxChars?: number } = {}
): string {
  const maxFrames = opts.maxFrames ?? 8;
  const maxChars = opts.maxChars ?? 1600;
  let unread = thread
    .filter(
      (m) => m.direction === "inbound" && (!lastOutboundAt || m.received_at > lastOutboundAt)
    )
    .map((m) => (m.body ?? "").trim())
    .filter(Boolean)
    .filter((b) => !PLACEHOLDER.test(b));
  const cur = (currentText ?? "").trim();
  if (cur && !PLACEHOLDER.test(cur) && !unread.includes(cur)) unread.push(cur);
  // Cap by frame count keeping the OLDEST frame (it usually names the vehicle -
  // "We have available Fazzio") PLUS the newest frames (they usually carry the
  // price). Dropping the oldest would re-create the exact matchesSpec=false drop
  // this exists to fix.
  if (unread.length > maxFrames) {
    unread = [unread[0], ...unread.slice(-(maxFrames - 1))];
  }
  let out = unread.join("\n");
  if (out.length > maxChars && unread.length > 0) {
    // Preserve the leading frame (vehicle) whole, then as much of the tail
    // (price) as the budget allows.
    const first = unread[0];
    const rest = unread.slice(1).join("\n");
    const budget = Math.max(0, maxChars - first.length - 2);
    out = budget > 0 ? `${first}\n${rest.slice(-budget)}` : first.slice(0, maxChars);
  }
  return out;
}
