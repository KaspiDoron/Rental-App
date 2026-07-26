// MISREAD CORRECTIONS - teaching the agents what a shop actually MEANT.
//
// Every review field that existed before this judged OUR MOVE: was the branch
// right, was the reply good, did the outcome improve. But the failures the
// owner keeps hitting are one layer earlier - the agent misunderstood the shop.
// "Some models 200 and some new 250/day" is a MENU; the engine read it as the
// shop not having the vehicle, and the whole thread died on a goodbye. No
// amount of "rate this reply" reaches that.
//
// So a correction pins the exact shop message and labels what it actually was,
// from a CLOSED vocabulary that mirrors the domain model. Closed is the whole
// point: free prose becomes a note nobody can compile, whereas `option-menu`
// is a concept the engine already has (VehicleOption[]), so a correction can
// be retrieved on exactly the turns where it applies.

import type { MoveKind } from "../spte/types";

/** What the shop's message really was. Mirrors the concepts the engine models. */
export type MisreadKind =
  | "option-menu" // a CHOICE of tiers, not a refusal
  | "list-price" // their headline rate, not the offer to us
  | "photo-price-board" // the prices are in the image
  | "location-request" // they asked where we are
  | "clarifying-question" // they asked us something and are waiting
  | "decline" // they really are saying no
  | "firm"; // they will not move on the price

export const MISREAD_KINDS: MisreadKind[] = [
  "option-menu",
  "list-price",
  "photo-price-board",
  "location-request",
  "clarifying-question",
  "decline",
  "firm",
];

export function isMisreadKind(v: unknown): v is MisreadKind {
  return typeof v === "string" && (MISREAD_KINDS as string[]).includes(v);
}

/** Human wording used in both the Ops UI and the compiled lesson. */
export const MISREAD_LABEL: Record<MisreadKind, string> = {
  "option-menu": "a menu of options to choose between",
  "list-price": "their list price, not an offer to us",
  "photo-price-board": "a price board sent as a photo",
  "location-request": "a request for our location",
  "clarifying-question": "a question waiting on our answer",
  decline: "a genuine decline",
  firm: "a refusal to move on the price",
};

/** What the engine should do when it sees this again - the teachable part. */
const GUIDANCE: Record<MisreadKind, string> = {
  "option-menu":
    "Resolve the menu before haggling: ask what separates the tiers (age, mileage, model) and ask for a photo of each. Never treat a choice as the shop not having the vehicle.",
  "list-price":
    "Treat it as their headline rate, not as our quote. It is an anchor to bargain DOWN from, and it must not replace a better price they already gave us.",
  "photo-price-board":
    "Read the board and say what we read, then ask a yes/no to confirm it. Never ask a shop to retype prices they already sent as an image.",
  "location-request":
    "Answer with the traveller's verified stay if we have one; otherwise ask the traveller. Never guess a location and never leave the question unanswered.",
  "clarifying-question":
    "Answer their question FIRST, in the same message, before any push on price.",
  decline: "Thank them warmly once and stop. Do not keep pushing a shop that said no.",
  firm: "Stop pushing the price. Move to deposit, delivery or closing instead.",
};

/** The writable correction, as the console POSTs it. */
export interface MisreadCorrection {
  /** The exact shop message the agent got wrong (pinned from the transcript). */
  shopMessage: string;
  actualMeaning: MisreadKind;
  /** Optionally, the move it should have made instead. */
  shouldHaveMoved?: MoveKind;
}

/** Tag written onto the review row - what makes a correction queryable. */
export function misreadTag(kind: MisreadKind): string {
  return `misread:${kind}`;
}

/**
 * The `agent_training.note` value. An exact-match column beats searching prose:
 * retrieval filters `note=in.(lesson:option-menu,...)` with no LIKE wildcards,
 * which is also why an unescaped `_` can never widen the match here.
 */
export function lessonNote(kind: MisreadKind): string {
  return `lesson:${kind}`;
}

/** Parse the vocabulary back out of a stored note. */
export function kindFromNote(note: string | null | undefined): MisreadKind | null {
  const k = (note ?? "").startsWith("lesson:") ? (note as string).slice(7) : "";
  return isMisreadKind(k) ? k : null;
}

/**
 * Compile one correction into the lesson the live prompt will carry. Written
 * once at review time so the hot path costs a single indexed read.
 *
 * Deliberately contains NO numbers from the thread: the lesson teaches how to
 * READ a message, and the post-rails reject any figure the model did not get
 * from the deterministic extractor anyway.
 */
export function compileMisreadLesson(
  c: MisreadCorrection,
  opts: { vendorName?: string; day?: string; why?: string } = {}
): string {
  const day = opts.day ?? new Date().toISOString().slice(0, 10);
  const who = opts.vendorName?.trim() || "a rental shop";
  const quoted = c.shopMessage.replace(/\s+/g, " ").trim().slice(0, 300);
  const move = c.shouldHaveMoved ? ` The right move was: ${c.shouldHaveMoved}.` : "";
  const why = opts.why?.trim() ? ` Owner's note: ${opts.why.trim().slice(0, 200)}` : "";
  return (
    `[LESSON ${day} | ${c.actualMeaning}] When ${who} said: "${quoted}" - ` +
    `that was ${MISREAD_LABEL[c.actualMeaning]}. ${GUIDANCE[c.actualMeaning]}${move}${why}`
  ).slice(0, 900);
}

/**
 * Which lessons apply to THIS turn. The whole reason corrections use a closed
 * vocabulary: a lesson about menus surfaces when a menu is on screen, instead
 * of every lesson being blended into one global tone block on every turn.
 *
 * Derived from verified facts only - never from the shop's wording, so this is
 * not a hidden if/else on phrasing.
 */
export function situationKinds(sit: {
  optionCount?: number;
  variance?: boolean;
  hadImage?: boolean;
  imageKind?: string;
  askedLocation?: boolean;
  askedQuestion?: boolean;
  declined?: boolean;
  firm?: boolean;
  listPriceSeen?: boolean;
}): MisreadKind[] {
  const out: MisreadKind[] = [];
  if ((sit.optionCount ?? 0) >= 2 || sit.variance) out.push("option-menu");
  if (sit.hadImage || sit.imageKind === "price_sheet") out.push("photo-price-board");
  if (sit.askedLocation) out.push("location-request");
  if (sit.askedQuestion) out.push("clarifying-question");
  if (sit.declined) out.push("decline");
  if (sit.firm) out.push("firm");
  if (sit.listPriceSeen) out.push("list-price");
  return out;
}
