// What a traveller should be told when a message did not go out.
//
// The live failure: a shop card showed `instance requires property "text"` in
// an amber box under a green "Ask for price" button. That string is Evolution's
// JSON-schema validator complaining about a request body OUR code built - it is
// not about the traveller, their WhatsApp, or the shop, and there is nothing
// they could possibly do with it.
//
// Upstream text is still worth keeping for the log and the admin doctor; it is
// simply never the thing a traveller reads. Pure, so the mapping is unit-tested
// rather than discovered in a screenshot.

export interface FriendlySend {
  /** One sentence, plain, and true. */
  text: string;
  /** Is this worth the traveller retrying right now? */
  retryable: boolean;
}

const RULES: Array<{ rx: RegExp; text: string; retryable: boolean }> = [
  {
    // A body/schema rejection is OUR bug, never theirs. Say what is true -
    // the message did not go - and do not invite a pointless retry loop.
    rx: /requires property|should have required|invalid body|validation|is not allowed|must be a?\s*string/i,
    text: "Something went wrong on our side sending that. Nothing was sent - we're on it.",
    retryable: false,
  },
  {
    rx: /not.*connected|instance.*(?:close|disconnect)|connection.*closed/i,
    text: "Your WhatsApp link dropped for a moment. It reconnects on its own - try again shortly.",
    retryable: true,
  },
  {
    rx: /reconnecting/i,
    text: "Reconnecting to WhatsApp - your message will go as soon as the link is back.",
    retryable: true,
  },
  {
    rx: /not.*(?:on )?whatsapp|number.*(?:invalid|not exist)|does not exist/i,
    text: "This shop's number is not on WhatsApp, so we can't message them.",
    retryable: false,
  },
  {
    rx: /forbidden|not.?authoriz|401|403/i,
    text: "WhatsApp refused that request. Re-link your number in Profile if it keeps happening.",
    retryable: false,
  },
  {
    rx: /too many|rate.?limit|429/i,
    text: "We're pacing your messages to keep your number safe. This one goes out shortly.",
    retryable: false,
  },
  {
    rx: /timed out|timeout|abort|network|fetch failed|econn/i,
    text: "Couldn't reach WhatsApp just now - it retries automatically.",
    retryable: true,
  },
];

const FALLBACK =
  "Not sent - a brief hiccup reaching WhatsApp. It retries on its own; try again in a few seconds.";

/**
 * Turn whatever the send path produced into something worth showing.
 * Anything unrecognised falls back to the honest generic - a raw upstream
 * string is never returned.
 */
export function friendlySendError(raw?: string | null): FriendlySend {
  const s = String(raw ?? "").trim();
  if (!s) return { text: FALLBACK, retryable: true };
  for (const r of RULES) {
    if (r.rx.test(s)) return { text: r.text, retryable: r.retryable };
  }
  return { text: FALLBACK, retryable: true };
}
