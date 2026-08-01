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
  | "media-problem" // a photo or document we could not read
  // THE TERMS. A deposit, how the handover works, what document they want -
  // the facts that decide whether a good price is a good deal, and the ones
  // the traveller most often has to go and DO something about (find an ATM,
  // decide whether to leave a passport). Judged like a price: worth a buzz
  // once per shop, never a running commentary.
  | "terms"
  // THE AGENT CANNOT PROCEED, and only the traveller can unstick it. This is
  // the class the whole engine was missing: every push described progress, so
  // the one state that actually needs a human - a dropped WhatsApp link, a
  // guard that terminally refused a thread, the cheapest shop lost - was the
  // one state that produced silence. The owner's decision: high-value PLUS
  // agent-blocked.
  | "agent-blocked"
  // A SHOP IS RINGING THE TRAVELLER'S PHONE RIGHT NOW.
  //
  // Not news either - it is a person waiting on the line, in a country where
  // the traveller may be on airplane mode, out of credit, or simply unable to
  // hold a conversation in the local language. It expires in seconds, which is
  // the one thing no budget should ever be allowed to delay.
  | "call";

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
  /**
   * THIS shop's previous quote, when it has one.
   *
   * Without it, a shop moving 250 -> 200 while another sits at 180 produced
   * nothing: not the session best, so not news. But it IS news - it is the
   * shop moving, which is the only evidence the traveller has that the
   * negotiation is working, and it is the moment to decide whether to push
   * again. Sky Light did exactly this at 12:48 and the phone stayed silent.
   */
  vendorPreviousPricePerDay?: number;
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
  // A BLOCKED AGENT IS A HANDOVER TOO, and the same logic applies: this is not
  // news competing for attention, it is the system saying it cannot continue
  // without them. Budgeting it would mean the fifth event of a busy hunt is
  // the one that silently strands the whole search.
  if (event.kind === "agent-blocked") {
    return { notify: true, reason: "the agent is stuck and only they can unstick it" };
  }
  // A ringing phone cannot wait for a budget window. By the time the window
  // opened the call would be long over.
  if (event.kind === "call") return { notify: true, reason: "a shop is calling them right now" };

  if (state.sentInWindow >= MAX_PUSHES_PER_WINDOW) {
    return { notify: false, reason: "already interrupted enough for one search" };
  }

  switch (event.kind) {
    case "deal-ready":
      return { notify: true, reason: "a deal is complete and lockable" };

    case "terms":
      // Once, when they land. The deposit is the second question of every
      // rental and the traveller cannot plan around one they have not read.
      return { notify: true, reason: "their terms landed - deposit and handover" };

    case "price": {
      const p = event.pricePerDay;
      if (!(typeof p === "number" && p > 0)) {
        return { notify: false, reason: "a price event with no price is not a price" };
      }
      // THIS SHOP MOVED. Not the session best, and still the most useful thing
      // that can happen in a negotiation: it is the evidence that pushing
      // works, and the moment to decide whether to push again.
      const prev = state.vendorPreviousPricePerDay;
      if (typeof prev === "number" && prev > 0 && p < prev) {
        return { notify: true, reason: `this shop came down from ${prev}` };
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
  /** Terms landed in this message: a deposit, a handover, a document ask. */
  termsLanded?: boolean;
  /** Price AND terms are both known for this shop - it is lockable. */
  dealReady?: boolean;
}): NotifyEvent {
  // ORDERED BY WHAT IT CHANGES, most consequential first. `deal-ready` and
  // `terms` were reachable in the type and by no code path - `classifyReply`
  // could only ever return price / plain-reply / first-reply, so two of the
  // gate's branches were dead the day they were written.
  if (opts.dealReady && typeof opts.pricePerDay === "number" && opts.pricePerDay > 0) {
    return { kind: "deal-ready", pricePerDay: opts.pricePerDay, currency: opts.currency };
  }
  if (typeof opts.pricePerDay === "number" && opts.pricePerDay > 0) {
    return { kind: "price", pricePerDay: opts.pricePerDay, currency: opts.currency };
  }
  if (opts.termsLanded) return { kind: "terms" };
  return { kind: opts.anyReplyYet ? "plain-reply" : "first-reply" };
}
