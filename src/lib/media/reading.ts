// WHAT THE AGENTS ACTUALLY READ IN THAT PHOTO.
//
// Most shops answer with a picture. A price board, a photo of the bike, a
// screenshot of their rate card. The vision agent reads it, the numbers become
// an offer - and then the reading itself evaporates. The image and the
// understanding of the image lived in two different places, and only one of
// them was ever shown.
//
// That is why the app could never prove it had understood anything. A traveller
// looking at "฿250/day" under a photo of a board has no way to know whether the
// agent read the board or guessed, and when it gets one wrong (a "6 days" read
// as a price) there is nothing to point at.
//
// A MediaReading is that missing artefact: the structured result of looking at
// one piece of media, stored beside the message it came from, in the shop's own
// terms. It is what the "agentic summary" under each photo renders, and it is
// the same object the negotiation already acts on - not a description written
// afterwards to look convincing.
//
// Pure, so the shape is testable without a model in the loop.

export interface ReadPrice {
  pricePerDay: number;
  currency?: string;
  /** The shop's own line, so a traveller can check the reading against the photo. */
  line?: string;
  /** Which vehicle this row was for, when the board said. */
  vehicle?: string;
  /** The stay this row applies to ("3-7 days"), for a duration ladder. */
  tierLabel?: string;
}

/**
 * DID WE LOOK, AND WHAT DID WE SEE?
 *
 * - `read`        - the reader saw the media and got something out of it.
 * - `empty`       - the reader saw the media and there was nothing usable.
 * - `unavailable` - THE READER NEVER RAN. Every provider failed (rejected key,
 *                   quota, timeout, safety block), so this reading is an
 *                   absence of a read, not a read that came up empty.
 *
 * The third state is the one that did not exist. Without it an outage and a
 * blank picture produced the identical artefact, and the traveller was told
 * "nothing readable in this one" about a photo nobody had ever looked at.
 */
export type ReadingOutcome = "read" | "empty" | "unavailable";

/**
 * WHAT THE AGENT ACTUALLY DID ABOUT IT, recorded by the turn that did it.
 *
 * The proof panel used to assert "your agent is asking the shop to type it
 * instead" from nothing but an empty reading - a promise no code had made and
 * nothing had observed. This is the observation; the UI renders it and claims
 * nothing when it is absent.
 */
export interface ReadingFollowUp {
  /** The move the engine chose on the turn this media arrived (a MoveKind). */
  move: string;
  /** Whether a message actually left, as the send path reported it. */
  delivered: "sent" | "queued" | "held" | "blocked" | "failed" | "silent";
  at: string;
}

export interface MediaReading {
  /** Did the reader run, and did it find anything? See ReadingOutcome. */
  outcome: ReadingOutcome;
  /** Why the reader could not run, when `outcome` is "unavailable". */
  unavailableReason?: string;
  /** The follow-up the turn recorded - never a claim the UI invents. */
  followUp?: ReadingFollowUp;
  /** Every per-day rate the media contained, cheapest first. */
  prices: ReadPrice[];
  /** Vehicles or models the media named. */
  vehicles: string[];
  /** Deposit terms stated in the media, in the shop's words. */
  deposit?: string;
  /** Conditions, restrictions, inclusions - anything else that binds the deal. */
  conditions: string[];
  /** Raw text the reader recovered, trimmed. Proof, and a fallback to eyeball. */
  text?: string;
  /** How sure the reader is. Shown, never hidden. */
  confidence: "high" | "medium" | "low";
  /** The price this reading contributed to the traveller's offer, if any. */
  usedPricePerDay?: number;
  /** Why it did not contribute, when it did not. */
  notUsedReason?: string;
}

/** The shape the vision/extraction step produces. Deliberately loose - this is
 *  a boundary with a model, and a missing field is normal, not exceptional. */
export interface ExtractionLike {
  found?: boolean;
  pricePerDay?: number;
  currency?: string;
  confidence?: string;
  deposit?: string;
  options?: Array<{
    pricePerDay?: number;
    currency?: string;
    label?: string;
    model?: string;
    tierLabel?: string;
  }>;
  vehicleAssessment?: { model?: string; status?: string; reason?: string };
  // THESE ARE THE NAMES THE EXTRACTOR ACTUALLY PRODUCES.
  //
  // This shape used to declare `conditions: string[]` and `visionText: string`,
  // and ExtractedOffer has never had either field - it emits `conditionNotes`
  // and `imageSummary`. Both reads were therefore permanently `undefined`, and
  // because `readingIsEmpty` requires prices AND vehicles AND deposit AND
  // conditions AND text to all be empty, a photo the model read perfectly well
  // was reported to the traveller as "Nothing readable in this one" whenever it
  // carried no parsed price - a proof panel telling them the agents were blind
  // while the agents were, in fact, reading it.
  //
  // The old names are kept as optional aliases so any caller still passing them
  // (the studio/simulator mirrors) keeps working.
  conditionNotes?: string | null;
  imageSummary?: string | null;
  vehicleDescription?: string | null;
  conditions?: string[];
  visionText?: string;
  /** The vision pass's own provenance (src/lib/ai readImages). `seen:false`
   *  means no provider ever looked at this media. */
  imageRead?: {
    seen?: boolean;
    failure?: string;
    detail?: string;
    retryable?: boolean;
  };
}

/** Plain-English reason per failure kind, for the traveller (never a status code). */
const UNAVAILABLE_REASON: Record<string, string> = {
  unconfigured: "no image reader is configured",
  auth: "the image reader rejected our key",
  "rate-limit": "the image reader was over its quota",
  "bad-model": "the image reader was unavailable",
  blocked: "the image reader declined to describe this one",
  timeout: "the image reader did not answer in time",
  network: "we could not reach the image reader",
  upstream: "the image reader was having problems",
};

function clean(v: unknown): string {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

function confidenceOf(v: unknown): MediaReading["confidence"] {
  const c = clean(v).toLowerCase();
  return c === "high" ? "high" : c === "low" ? "low" : "medium";
}

/**
 * Turn an extraction into the artefact a traveller can check.
 *
 * Every field is something the reader genuinely produced. Nothing is invented
 * to fill the panel out: an empty reading renders as "we could not read this",
 * which is a true and useful thing to say.
 */
export function readingFrom(
  extraction: ExtractionLike | null | undefined,
  opts: {
    usedPricePerDay?: number;
    notUsedReason?: string;
    /** Only ever set by the turn that actually took the follow-up move. */
    followUp?: ReadingFollowUp;
  } = {}
): MediaReading {
  const e = extraction ?? {};
  const prices: ReadPrice[] = [];
  const seen = new Set<number>();

  for (const o of e.options ?? []) {
    const p = Number(o?.pricePerDay);
    if (!(p > 0) || seen.has(p)) continue;
    seen.add(p);
    prices.push({
      pricePerDay: p,
      currency: clean(o.currency) || clean(e.currency) || undefined,
      line: clean(o.label) || undefined,
      vehicle: clean(o.model) || undefined,
      tierLabel: clean(o.tierLabel) || undefined,
    });
  }
  const headline = Number(e.pricePerDay);
  if (headline > 0 && !seen.has(headline)) {
    prices.push({ pricePerDay: headline, currency: clean(e.currency) || undefined });
    seen.add(headline);
  }
  prices.sort((a, b) => a.pricePerDay - b.pricePerDay);

  const vehicles: string[] = [];
  for (const v of [e.vehicleAssessment?.model, ...(e.options ?? []).map((o) => o?.model)]) {
    const name = clean(v);
    if (name && !vehicles.includes(name)) vehicles.push(name);
  }

  // `conditionNotes` is one free-text line; `conditions` is the legacy array.
  const conditions = (
    e.conditions?.length
      ? e.conditions
      : String(e.conditionNotes ?? "")
          .split(/[;\n•]+/)
  )
    .map(clean)
    .filter(Boolean)
    .slice(0, 6);

  const deposit = clean(e.deposit) || undefined;
  const text =
    (clean(e.imageSummary) || clean(e.visionText) || clean(e.vehicleDescription)).slice(0, 600) ||
    undefined;

  // THE THIRD STATE. A vision pass that never ran cannot report an empty read -
  // it has nothing to report at all, and saying otherwise is the false negative
  // this whole artefact exists to make impossible.
  const blank =
    prices.length === 0 && vehicles.length === 0 && !deposit && conditions.length === 0 && !text;
  const neverRan = e.imageRead?.seen === false;
  const outcome: ReadingOutcome = neverRan ? "unavailable" : blank ? "empty" : "read";

  return {
    outcome,
    unavailableReason:
      neverRan
        ? UNAVAILABLE_REASON[String(e.imageRead?.failure ?? "")] ?? "the image reader was unavailable"
        : undefined,
    followUp: opts.followUp,
    prices: prices.slice(0, 8),
    vehicles: vehicles.slice(0, 6),
    deposit,
    conditions,
    text,
    confidence: confidenceOf(e.confidence),
    usedPricePerDay: opts.usedPricePerDay,
    notUsedReason: opts.notUsedReason,
  };
}

/** Did the reader get anything at all out of this? Drives the empty state. */
export function readingIsEmpty(r: MediaReading | null | undefined): boolean {
  if (!r) return true;
  return (
    r.prices.length === 0 &&
    r.vehicles.length === 0 &&
    !r.deposit &&
    r.conditions.length === 0 &&
    !r.text
  );
}

/** The reader never ran on this one - distinct from running and finding nothing. */
export function readingUnavailable(r: MediaReading | null | undefined): boolean {
  return r?.outcome === "unavailable";
}

/**
 * WHAT ACTUALLY HAPPENED WITH THIS ONE, in one line, for the empty state.
 *
 * Every branch says only what is recorded. The panel used to state flatly that
 * "your agent is asking the shop to type it instead" whenever a reading came up
 * blank - on the live engine nothing had been asked at the moment that rendered,
 * and when the thread had already asked about the price the engine's legal move
 * set had deliberately removed the question, so the sentence was doubly untrue.
 */
export function readingEmptyLine(r: MediaReading | null | undefined): string {
  if (!r) return "Nothing to show for this one.";
  if (r.outcome === "unavailable") {
    return `We did not get to read this one - ${r.unavailableReason ?? "the image reader was unavailable"}. Nothing here was guessed, and your agent reads it again on the next message.`;
  }
  const base = "We could not read anything usable from this one";
  const f = r.followUp;
  if (!f) return `${base}.`;
  if (f.move === "silent") {
    return `${base} - your agent had already asked for this, so it is waiting rather than asking twice.`;
  }
  const pair = MOVE_ACTION[f.move];
  if (!pair) return `${base}.`;
  if (f.delivered === "sent") return `${base} - your agent ${pair[1]}.`;
  if (f.delivered === "queued") return `${base} - your agent is ${pair[0]}.`;
  // held / blocked / failed: something stopped the message. Claim nothing.
  return `${base}.`;
}

/** [in flight, already done] per move. Only moves that can follow media appear. */
const MOVE_ACTION: Record<string, [string, string]> = {
  clarify: ["asking the shop to type the price out", "asked the shop to type the price out"],
  "deposit-probe": ["asking the shop about the deposit", "asked the shop about the deposit"],
  "fulfillment-probe": [
    "asking how you collect the vehicle",
    "asked how you collect the vehicle",
  ],
  "option-probe": [
    "asking what separates their options",
    "asked what separates their options",
  ],
  "confirm-vehicle": [
    "asking the shop to confirm the vehicle",
    "asked the shop to confirm the vehicle",
  ],
  answer: ["answering the shop's question", "answered the shop's question"],
  bargain: ["pushing for a better price", "pushed for a better price"],
  present: ["bringing you the offer", "brought you the offer"],
  "pickup-location": ["sending the pickup details", "sent the pickup details"],
  momentum: ["nudging the shop", "nudged the shop"],
  close: ["wrapping the conversation up", "wrapped the conversation up"],
  "redirect-close": ["wrapping the conversation up", "wrapped the conversation up"],
  "closing-message": ["wrapping the conversation up", "wrapped the conversation up"],
};

/** A one-line headline for the collapsed state - what the traveller sees first. */
export function readingHeadline(r: MediaReading | null | undefined): string {
  if (readingUnavailable(r)) return "Could not read this one yet";
  if (readingIsEmpty(r)) return "Nothing readable in this one";
  const parts: string[] = [];
  if (r!.prices.length === 1) parts.push("1 price");
  else if (r!.prices.length > 1) parts.push(`${r!.prices.length} prices`);
  if (r!.vehicles.length) parts.push(`${r!.vehicles.length} vehicle${r!.vehicles.length > 1 ? "s" : ""}`);
  if (r!.deposit) parts.push("deposit terms");
  if (r!.conditions.length) parts.push(`${r!.conditions.length} condition${r!.conditions.length > 1 ? "s" : ""}`);
  return parts.length ? `Read ${parts.join(", ")}` : "Read this image";
}
