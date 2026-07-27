// IS THIS WORTH INTERRUPTING SOMEONE FOR?
//
// There was already a policy for HOW OFTEN to notify - a per-shop collapse
// window, so one shop firing three messages produces one push. There was no
// policy for WHETHER. Every inbound reply notified, and a hunt contacts ten to
// fifteen shops, most of which answer first with an auto-greeting:
//
//     "Thanks for messaging us. We are open every day from 9.00 am to 6.00 pm."
//
// Ten pushes, none of them carrying a single fact the traveller can act on.
// Collapsing per shop cannot help, because the shops are all different.
//
// The missing idea is that a notification is a claim on someone's attention,
// and it has to be paid for in INFORMATION. So an event is judged on what it
// changes for the traveller, not on the fact that something happened:
//
//   - a price that IMPROVES their position (the first one, or a new best)
//   - the moment the hunt comes alive, once
//   - something only they can decide (a risk flag, a thread they took over)
//
// Everything else is real, is worth showing in the app, and is not worth a
// buzz. That distinction is the whole file.
//
// Pure - the judgement is unit-tested rather than tuned by watching a phone.

export type NotifyKind =
  | "first-reply" // the hunt is alive - the very first shop to answer
  | "price" // a shop named a number
  | "plain-reply" // a shop answered with no price (greetings, questions)
  | "deal-ready" // terms are complete and it is lockable
  | "risk" // a reply the traveller should read before acting
  | "takeover" // they messaged a shop themselves; the agent stood down
  | "media-problem"; // a photo or document we could not read

export interface NotifyEvent {
  kind: NotifyKind;
  /** The price this event carries, when it carries one. */
  pricePerDay?: number;
  /** Currency of `pricePerDay` - a cheaper number in another money is not cheaper. */
  currency?: string;
}

export interface NotifyState {
  /** The best price already shown to the traveller, in `bestCurrency`. */
  bestPricePerDay?: number;
  bestCurrency?: string;
  /** Has any shop replied yet this search? */
  anyReplyYet: boolean;
  /** Pushes already sent for this search inside the current window. */
  sentInWindow: number;
}

/**
 * A hard ceiling per search, whatever the events say.
 *
 * Even genuinely good news stops being good news at the eleventh buzz, and a
 * board of fifteen shops can produce a lot of genuinely good news at once.
 */
export const MAX_PUSHES_PER_WINDOW = 4;

export interface Significance {
  notify: boolean;
  /** Why - recorded on the event so the decision is auditable, never guessed at. */
  reason: string;
}

/**
 * Does this event earn a notification?
 *
 * Note what is NOT consulted: how long since the last push, which shop it came
 * from, how many messages arrived. Those are questions about volume, and volume
 * was never the problem - ten pushes that each said "a shop replied" would be
 * just as unwelcome spread over an hour.
 */
export function worthAnInterruption(event: NotifyEvent, state: NotifyState): Significance {
  // Things only the traveller can decide always get through, and are not
  // counted against the budget - they are not news, they are a handover.
  if (event.kind === "risk") return { notify: true, reason: "the traveller has to read this one" };
  if (event.kind === "takeover") return { notify: true, reason: "they are driving this thread now" };

  if (state.sentInWindow >= MAX_PUSHES_PER_WINDOW) {
    return { notify: false, reason: "already interrupted enough for one search" };
  }

  switch (event.kind) {
    case "deal-ready":
      return { notify: true, reason: "a deal is complete and lockable" };

    case "price": {
      const p = event.pricePerDay;
      if (!(typeof p === "number" && p > 0)) {
        return { notify: false, reason: "a price event with no price is not a price" };
      }
      const best = state.bestPricePerDay;
      // A cheaper number in a different currency is not a cheaper price.
      const comparable =
        typeof best === "number" &&
        best > 0 &&
        (!event.currency || !state.bestCurrency || event.currency === state.bestCurrency);
      if (!comparable) return { notify: true, reason: "the first price of the search" };
      return p < best
        ? { notify: true, reason: "a new best price" }
        : { notify: false, reason: "a price, but not better than the one they have" };
    }

    case "first-reply":
      return state.anyReplyYet
        ? { notify: false, reason: "the hunt was already alive" }
        : { notify: true, reason: "the first shop answered - the hunt is live" };

    case "plain-reply":
      // The single largest source of the noise: an auto-greeting from each of
      // fifteen shops. Real, visible in the app, and worth nobody's attention.
      return { notify: false, reason: "a reply with nothing in it to act on" };

    case "media-problem":
      return { notify: false, reason: "visible in the app, and nothing to decide" };
  }
}

/**
 * The event a reply amounts to. One place, so the caller cannot accidentally
 * describe an auto-greeting as news.
 */
export function classifyReply(opts: {
  pricePerDay?: number;
  currency?: string;
  anyReplyYet: boolean;
}): NotifyEvent {
  if (typeof opts.pricePerDay === "number" && opts.pricePerDay > 0) {
    return { kind: "price", pricePerDay: opts.pricePerDay, currency: opts.currency };
  }
  return { kind: opts.anyReplyYet ? "plain-reply" : "first-reply" };
}
