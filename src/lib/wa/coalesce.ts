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
export function coalesceUnreadInbound(
  thread: CoalesceMsg[],
  lastOutboundAt: string,
  currentText?: string,
  opts: { maxFrames?: number; maxChars?: number } = {}
): string {
  const maxFrames = opts.maxFrames ?? 8;
  const maxChars = opts.maxChars ?? 1600;
  const unread = thread
    .filter(
      (m) => m.direction === "inbound" && (!lastOutboundAt || m.received_at > lastOutboundAt)
    )
    .map((m) => (m.body ?? "").trim())
    .filter(Boolean);
  const cur = (currentText ?? "").trim();
  if (cur && !unread.includes(cur)) unread.push(cur);
  let out = unread.slice(-maxFrames).join("\n");
  if (out.length > maxChars) out = out.slice(-maxChars);
  return out;
}
