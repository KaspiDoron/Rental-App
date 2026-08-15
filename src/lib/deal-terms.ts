// WHAT WE ACTUALLY KNOW ABOUT A DEAL - price, deposit, and how the traveller
// gets the vehicle.
//
// This predicate already existed TWICE and was reachable from neither place: a
// local `isComplete` closure inside /api/replies (not exported) and the
// `dealComplete` reasoning behind SPTE's `present` move. So the one surface
// that most needed it - the Trips re-check, which re-asks a past hunt's shops
// whether their price still stands - had no way to ask the question and simply
// messaged EVERY number it had ever sent an opener to, answered or not.
//
// The owner's rule, verbatim: re-ask "ONLY if we have price, deposit and how we
// get the vehicle details". That is this file, and it is the only definition.
//
// PURE: no database, no clock, no React. Callers map their own row shapes onto
// `DealTerms` and get one answer.

import { depositSpokenPhrase, type DepositType } from "./deposit";

/** Every fact that decides whether a deal is complete enough to re-confirm. */
export interface DealTerms {
  /** The shop's own last quote. Never a figure we computed. */
  pricePerDay?: number | null;
  currency?: string | null;
  /** The engine's extracted deposit kind ("cash" / "passport" / "none" / ...). */
  depositType?: string | null;
  /** The engine's free-text note about the deposit. */
  depositNote?: string | null;
  /** The reply row's own deposit label, when the extractor wrote one. */
  depositLabel?: string | null;
  depositAmount?: number | null;
  depositCurrency?: string | null;
  /** The engine's extracted fulfillment decision. */
  fulfillment?: string | null;
  /** The reply row's boolean: the shop said it does / does not deliver. */
  delivers?: boolean | null;
}

export type Fulfillment = "pickup" | "delivery" | "on-shop";

const FULFILLMENTS: readonly string[] = ["pickup", "delivery", "on-shop"];

/** Did the shop give us a price? Zero and negative are not quotes. */
export function priceKnown(t: DealTerms): boolean {
  return typeof t.pricePerDay === "number" && t.pricePerDay > 0;
}

/**
 * Did the shop tell us what the deposit is?
 *
 * "none" IS an answer - a shop that says it takes no deposit has settled the
 * question, and treating that as unknown would exclude exactly the shops with
 * the friendliest terms.
 */
export function depositKnown(t: DealTerms): boolean {
  return Boolean(
    (t.depositType && String(t.depositType).trim()) ||
      (t.depositNote && String(t.depositNote).trim()) ||
      (t.depositLabel && String(t.depositLabel).trim()) ||
      (typeof t.depositAmount === "number" && t.depositAmount > 0)
  );
}

/**
 * How the traveller gets the vehicle, or null when nobody ever said.
 *
 * The engine's extracted `fulfillment` is authoritative. `delivers` is the
 * older per-reply boolean and only ever settles the DELIVERY half: `true` means
 * they bring it, `false` means they do not - which leaves "you come to us",
 * i.e. pickup at the shop. `null`/absent settles nothing.
 */
export function fulfillmentOf(t: DealTerms): Fulfillment | null {
  const f = String(t.fulfillment ?? "").trim();
  if (FULFILLMENTS.includes(f)) return f as Fulfillment;
  if (t.delivers === true) return "delivery";
  if (t.delivers === false) return "pickup";
  return null;
}

export function fulfillmentKnown(t: DealTerms): boolean {
  return fulfillmentOf(t) !== null;
}

/**
 * THE PREDICATE. All three, or it is not a deal we can ask about "on the same
 * conditions" - because we would not be able to state what those conditions
 * were.
 */
export function termsComplete(t: DealTerms): boolean {
  return priceKnown(t) && depositKnown(t) && fulfillmentKnown(t);
}

/** Which of the three are missing - for honest UI copy, never for a message. */
export function missingTerms(t: DealTerms): Array<"price" | "deposit" | "fulfillment"> {
  const out: Array<"price" | "deposit" | "fulfillment"> = [];
  if (!priceKnown(t)) out.push("price");
  if (!depositKnown(t)) out.push("deposit");
  if (!fulfillmentKnown(t)) out.push("fulfillment");
  return out;
}

/**
 * The deposit in the shop's own terms, as a short phrase.
 *
 * `money` is injected so this file stays free of the currency module's locale
 * work and stays trivially testable. Returns null when nothing was said, which
 * `termsComplete` has already ruled out for any message path.
 */
export function depositPhrase(
  t: DealTerms,
  money?: (amount: number, code?: string) => string
): string | null {
  const type = String(t.depositType ?? "").trim().toLowerCase();
  if (type === "none") return "no deposit";
  const note = String(t.depositNote ?? t.depositLabel ?? "").trim();
  // EVERY ALTERNATIVE, OR WE ARE PUTTING WORDS IN THE SHOP'S MOUTH.
  //
  // This function used to be its own three-branch enum switch, and the branch
  // `passport | id | document -> "a passport/ID deposit"` silently discarded the
  // cash route: a shop that wrote "We have deposit passport or money4000" was
  // asked, in the traveller's name, to confirm passport-only terms. That is the
  // owner's report, in the one place where the wrong reading is not merely
  // displayed but SPOKEN BACK - the re-check message (wa/recheck-message).
  //
  // The structure lives in lib/deposit, which parses the shop's own words into
  // alternatives; this is the only renderer left that had a second opinion.
  const spoken = depositSpokenPhrase(
    {
      deposit: note || null,
      depositType: DEPOSIT_TYPE[type] ?? null,
      depositAmount: t.depositAmount ?? null,
      depositCurrency: t.depositCurrency ?? null,
      currency: t.currency ?? null,
    },
    money
  );
  if (spoken) return spoken;
  // Terms nobody could parse: the shop's own sentence, bounded. Better than a
  // category we guessed at.
  if (note) return note.length > 60 ? `${note.slice(0, 57)}...` : note;
  return null;
}

/** What a stored `depositType` means, including the spellings that predate the
 *  enum: rows written by older extractors still say "money" and "document", and
 *  dropping them on the floor would lose the only term the shop stated. */
const DEPOSIT_TYPE: Record<string, DepositType> = {
  cash: "cash",
  money: "cash",
  passport: "passport",
  document: "passport",
  id: "id",
  license: "license",
  licence: "license",
  other: "other",
};

/** How the traveller gets the vehicle, as a short phrase. */
export function fulfillmentPhrase(t: DealTerms): string | null {
  switch (fulfillmentOf(t)) {
    case "delivery":
      return "delivery to me";
    case "pickup":
    case "on-shop":
      return "pick-up at your shop";
    default:
      return null;
  }
}

/** A neutral label for the SCREEN (the Trips card), not for a shop message. */
export function fulfillmentLabel(t: DealTerms): string | null {
  switch (fulfillmentOf(t)) {
    case "delivery":
      return "Delivered to you";
    case "pickup":
    case "on-shop":
      return "Pick-up at the shop";
    default:
      return null;
  }
}
