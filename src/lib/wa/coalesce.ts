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

/**
 * IS THIS TEXT SOMETHING THE SHOP SAID, OR SOMETHING WE WROTE FOR THEM?
 *
 * Exported because the coalescer is no longer the only consumer, and a SECOND
 * copy of this judgement is what broke the never-silent photo fallback.
 *
 * The incident: ingest stamps `syntheticText = "[image]"` on every captionless
 * photo so the frame is never nothing. The fallback that fires when a photo's
 * bytes could not be downloaded was guarded on `!syntheticText` - "the shop
 * gave us no words to work with" - and that guard became false BY
 * CONSTRUCTION the moment the placeholder was stamped: a photo we could not
 * read produced no clarify, no reading, and a panel with nothing in it.
 *
 * "The shop said nothing" and "the body is empty" are different questions.
 * This answers the first one, in one place, for everybody who asks it.
 */
export function isMediaPlaceholder(text: string | null | undefined): boolean {
  const t = (text ?? "").trim();
  return t.length === 0 || PLACEHOLDER.test(t);
}

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
    .filter((b) => !isMediaPlaceholder(b));
  const cur = (currentText ?? "").trim();
  if (!isMediaPlaceholder(cur) && !unread.includes(cur)) unread.push(cur);
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
