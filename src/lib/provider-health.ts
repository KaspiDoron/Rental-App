// WHY A PROVIDER FAILED, NOT JUST THAT IT DID.
//
// The Providers panel painted every non-OK result the same red, with the raw
// error body underneath. So this, from a free tier at peak:
//
//   sambanova 429 - {"error":{"message":"gpt-oss-120b-8k is currently
//   experiencing high demand. Please try again later!"}}
//
// looked exactly like a revoked key or a retired model id. It is neither. The
// key is fine, the model id is right, the provider is simply busy - and the
// chain's whole design is that the next rung answers, which it did. A red block
// with a JSON dump trains the owner to go hunting for a configuration problem
// that does not exist, and worse, to distrust a panel that is telling the truth
// about everything else.
//
// These are deliberately COARSE buckets keyed off the wire, because that is all
// we honestly have: providers do not agree on error shapes, and guessing more
// finely would be inventing certainty. Anything unrecognised stays `unknown`
// and keeps the raw detail - never dressed up as benign.

export type ProviderFailureKind =
  /** Rate limited or capacity-constrained. The chain moves on; nothing to fix. */
  | "busy"
  /** The key is missing, wrong, revoked or lacks access. The owner must act. */
  | "auth"
  /** The model id does not exist for this key - the drift the overrides exist for. */
  | "model"
  /** Never got an answer. Could be them, could be the network. */
  | "timeout"
  /** Unclassified: show the raw detail and claim nothing. */
  | "unknown";

/**
 * Classify a provider failure from its error text.
 *
 * Order matters: `auth` is checked before `busy` because a 429 that is really a
 * quota-exhausted key ("insufficient_quota") needs the owner, while a 429 about
 * demand does not. Getting that pair backwards would hide the one that matters.
 */
export function providerFailureKind(detail: string | null | undefined): ProviderFailureKind {
  const d = (detail ?? "").toLowerCase();
  if (!d) return "unknown";

  // Quota EXHAUSTED is an owner problem even though it often arrives as a 429.
  if (/insufficient_quota|quota exceeded|billing|payment required|\b402\b/.test(d)) return "auth";
  if (/\b401\b|\b403\b|unauthorized|forbidden|invalid api key|invalid_api_key|api key not valid/.test(d))
    return "auth";

  // Capacity. "high demand", "overloaded", "capacity", 429 and Anthropic's 529.
  if (/\b429\b|\b529\b|rate.?limit|too many requests|high demand|overloaded|capacity|try again later/.test(d))
    return "busy";

  if (/\b404\b|model.*(not found|does not exist|unavailable)|unknown model|no such model/.test(d))
    return "model";

  if (/timed out|timeout|aborted|econnreset|etimedout|network|fetch failed/.test(d)) return "timeout";

  return "unknown";
}

/** Whether this failure needs the owner to do something. */
export function providerNeedsOwner(kind: ProviderFailureKind): boolean {
  return kind === "auth" || kind === "model";
}

/**
 * The one-line explanation shown in the panel.
 *
 * Written for the owner, not for a log reader: what it means, and whether the
 * app is still working. The raw detail is still rendered underneath - this
 * replaces the INTERPRETATION, never the evidence.
 */
export function providerFailureCopy(kind: ProviderFailureKind, name: string): string {
  const who = name.charAt(0).toUpperCase() + name.slice(1);
  switch (kind) {
    case "busy":
      return `${who} is busy right now - its free tier is at capacity. Your key is fine and nothing needs fixing: the chain skips it and the next provider answers.`;
    case "auth":
      return `${who} refused the key. Paste a working ${name.toUpperCase()}_TOKEN, or check the account has credit.`;
    case "model":
      return `${who} does not know that model id - it has probably been retired. Paste a current one as ${name.toUpperCase()}_MODEL.`;
    case "timeout":
      return `${who} never answered in time. That is slow-or-down, not misconfigured; the chain moves on.`;
    default:
      return `${who} failed for a reason we cannot classify - the raw response is below.`;
  }
}
