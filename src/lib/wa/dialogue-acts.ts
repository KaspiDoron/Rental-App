// WHAT DID THE SHOP ACTUALLY DO?
//
// A shop sent its price board, its opening hours and its deposit terms. The
// agent replied: "Good question! Let's sort the main thing first - what's your
// best price per day?" It thanked the shop for a question nobody asked, and
// asked for a price the shop had just sent.
//
// The cause was that the app had no concept of a dialogue ACT. An inbound turn
// was a bag of unrelated booleans, and the one that decided everything -
// `askedQuestion` - was `/\?/.test(text)`: ANY question mark, anywhere. A price
// list ending "...which model would you like?" is a shop SHARING FACTS with a
// courtesy question attached, not a shop waiting on an answer; an auto-reply
// full of rhetorical questions is not a question at all. Both made "answer" the
// highest-priority legal move, and the answer template then fired blind.
//
// So: classify the turn before choosing how to respond to it. This module is
// pure and derives per turn from the message and what the extractor already
// read - no storage, no new tables. It says what happened; policy decides what
// is legal; the model still decides what to say.

/** What the shop is waiting on us for, if anything. */
export type AskKind =
  | "none"
  | "location" // where are you / where should we deliver
  | "license" // do you have a licence
  | "license-photo" // send a photo of your licence
  | "vehicle-choice" // which model/type do you want
  | "dates" // when / how many days
  | "substantive"; // a real question we have no finer name for

/** What the shop volunteered, independent of any question. */
export type ShareKind = "price" | "price-board" | "deposit" | "hours" | "options" | "location";

export interface DialogueActs {
  ask: AskKind;
  shared: ShareKind[];
  /** True when the shop's turn is an automated greeting rather than a person. */
  autoReply: boolean;
}

export interface ActInput {
  text?: string | null;
  hadImage?: boolean;
  imageKind?: string | null;
  /** A price the extractor could actually read from this turn. */
  pricePerDay?: number | null;
  /** More than one tier quoted. */
  optionCount?: number | null;
}

// An automated first responder announces itself. Its rhetorical questions are
// a form letter, not a turn waiting on us - answering them one by one is how
// the agent used to look like a bot talking to a bot.
const AUTO_REPLY =
  /\b(this is an automat(ic|ed) (message|reply)|auto[- ]?reply|automated response|we will (get back|message you back)|thank you for (contacting|your message))\b/i;

const HOURS =
  /\b(open|opening|closed?|hours?)\b[^.!?]{0,30}\b(\d{1,2}\s*[:.]\s*\d{2}|\d{1,2}\s*(am|pm))|\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s*[-:]\s*\d/i;

const DEPOSIT = /\b(deposits?|down ?payments?|collaterals?|security bonds?)\b/i;

const ASKS: Array<{ kind: AskKind; rx: RegExp }> = [
  {
    kind: "license-photo",
    rx: /\b(photo|picture|copy|scan)\b[^.!?]{0,25}\blicen[cs]e\b|\blicen[cs]e\b[^.!?]{0,25}\b(photo|picture|copy|scan)\b/i,
  },
  {
    kind: "license",
    rx: /\b(do|have)\s+you\s+(have\s+)?[^.!?]{0,20}\blicen[cs]e\b|\blicen[cs]e\b[^.!?]{0,15}\?/i,
  },
  {
    kind: "location",
    rx: /\bwhere (are|do|will|should|would)\b|\byour (hotel|location|address)\b|\bwhich (area|hotel)\b|\bsend (me )?(your )?location\b/i,
  },
  {
    kind: "vehicle-choice",
    rx: /\bwhich (one|type|kind|model|bike|scooter|car)\b|\bwhat (kind|type|model)\b|\bmotor ?bike or car\b|\bcar or (motor ?)?bike\b|\bscooter or (motor ?)?bike\b|\bwhich model would you like\b/i,
  },
  {
    kind: "dates",
    rx: /\bwhat dates?\b|\bwhen (do|will|are) you\b|\bhow (many|long)\b[^.!?]{0,20}\b(days?|weeks?)\b|\bhow many days\b/i,
  },
];

/**
 * A question needs INTERROGATIVE CONTENT, not a question mark.
 *
 * `?` alone was the old test and it is the single reason this whole class of
 * bug existed. A sentence qualifies here when it opens with an interrogative
 * word or inverts an auxiliary - the grammar of asking - and still carries a
 * `?`. That admits "which model would you like?" and rejects both "250 baht per
 * day 🙏?" and a form letter's "How many days rental?" when it is part of a
 * declared automatic message (handled by the caller via `autoReply`).
 */
const INTERROGATIVE_LEAD =
  /^(?:so|and|but|ok(?:ay)?|well|please|sorry|hi|hello|sir|ma'?am|ka|krub|krab)?[\s,]*\b(what|which|when|where|who|why|how|do|does|did|are|is|can|could|would|will|shall|have|has|may|any)\b/i;

function hasRealQuestion(text: string): boolean {
  for (const sentence of text.split(/(?<=[?!.])\s+|\n+/)) {
    if (!sentence.includes("?")) continue;
    // English forms a question by putting the interrogative FIRST. A statement
    // that merely contains one ("Click-125cc IS 250 baht per day 🙏?") has its
    // subject first, which is exactly what the old any-word test could not see.
    // Commas split it further, so "250 per day, what do you think?" still
    // counts.
    for (const clause of sentence.split(/,/)) {
      if (INTERROGATIVE_LEAD.test(clause.trim())) return true;
    }
  }
  return false;
}

/** Classify one inbound turn. Pure; safe to call anywhere. */
export function classifyActs(input: ActInput): DialogueActs {
  const text = String(input.text ?? "");
  const autoReply = AUTO_REPLY.test(text);

  const shared: ShareKind[] = [];
  if (input.hadImage || input.imageKind) {
    shared.push(input.imageKind === "price_sheet" ? "price-board" : "price-board");
  }
  if (typeof input.pricePerDay === "number" && input.pricePerDay > 0) shared.push("price");
  if ((input.optionCount ?? 0) > 1) shared.push("options");
  if (DEPOSIT.test(text)) shared.push("deposit");
  if (HOURS.test(text)) shared.push("hours");

  // An automated form letter is not a turn waiting on an answer. It shares
  // whatever it shares; its questions are boilerplate.
  let ask: AskKind = "none";
  if (!autoReply) {
    for (const { kind, rx } of ASKS) {
      if (rx.test(text)) {
        ask = kind;
        break;
      }
    }
    if (ask === "none" && hasRealQuestion(text)) ask = "substantive";
  }

  return { ask, shared: [...new Set(shared)], autoReply };
}

/** Did the shop ask us anything we owe an answer to? */
export function isAsking(acts: DialogueActs): boolean {
  return acts.ask !== "none";
}

/** A human-readable line for the prompt: what the shop just did, in plain words.
 *  The model was previously told "the shop ASKED YOU something" on the strength
 *  of a question mark, with no statement of what. */
export function describeActs(acts: DialogueActs): string {
  const bits: string[] = [];
  if (acts.shared.length) {
    const names: Record<ShareKind, string> = {
      price: "a price",
      "price-board": "a price board photo",
      deposit: "their deposit terms",
      hours: "their opening hours",
      options: "several options",
      location: "their location",
    };
    bits.push(`shared ${acts.shared.map((s) => names[s]).join(", ")}`);
  }
  bits.push(
    acts.ask === "none" ? "asked nothing" : `asked about ${acts.ask.replace(/-/g, " ")}`
  );
  if (acts.autoReply) bits.push("(automated message)");
  return `The shop ${bits.join("; ")}.`;
}
