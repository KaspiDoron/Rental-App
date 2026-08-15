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
  /**
   * FALSE when the board CROSSED THIS ROW OUT (a red X, a line through it).
   *
   * A struck-through row is a model the shop no longer rents - it is still on
   * the board, so the reading still shows it, but its price is not on offer.
   * Undefined means the board said nothing either way, which is the norm.
   */
  available?: boolean;
}

/**
 * DID WE LOOK, AND WHAT DID WE SEE?
 *
 * - `read`          - the reader saw the media and got something out of it.
 * - `empty`         - the reader saw the media and there was NOTHING IN IT.
 *                     This one is a statement ABOUT THE PHOTO, and it is the
 *                     only one that is.
 * - `unavailable`   - THE READER NEVER RAN. Every provider failed (rejected
 *                     key, quota, timeout, safety block), so this reading is an
 *                     absence of a read, not a read that came up empty.
 * - `parse-failed`  - the model ANSWERED and we could not use its answer (the
 *                     JSON did not parse). Our failure, downstream of the
 *                     picture.
 * - `truncated`     - the model's answer was CUT OFF at the token ceiling
 *                     (a long board), so the JSON ended mid-row. Our ceiling,
 *                     not their board.
 * - `sanity-nulled` - we READ a price and then rejected it as implausible
 *                     (25,000/day). A number WAS seen; we refuse to quote it.
 *
 * THE FIELD FAILURE THIS TAXONOMY EXISTS FOR (owner report 5): a shop sent one
 * crisp photo of a typed 3x3 price menu - every cell machine-readable, the
 * traveller's exact model among them - and the panel said "We could not read
 * anything usable from this one. CONFIDENCE: LOW." Three different failures
 * (unparseable JSON, a MAX_TOKENS cut-off, and a price erased by the sanity
 * net) all collapsed into the ONE artefact reserved for "the photo was blank",
 * so a reader that broke was reported to the traveller as a photo that was bad.
 * Every member below `empty` is a failure OF OURS and must never render as a
 * fact about their picture.
 */
export type ReadingOutcome =
  | "read"
  | "empty"
  | "unavailable"
  | "parse-failed"
  | "truncated"
  | "sanity-nulled";

/**
 * The failures that happened on OUR side of the lens, after the shutter.
 * `unavailable` is here too: it is equally not a statement about the photo.
 */
export const READING_FAILURE_OUTCOMES: ReadonlySet<ReadingOutcome> = new Set<ReadingOutcome>([
  "unavailable",
  "parse-failed",
  "truncated",
  "sanity-nulled",
]);

/** WHAT THE MODEL PASS DID WRONG - the half of the taxonomy the reader stamps. */
export type ModelReadFailure = "parse-failed" | "truncated" | "sanity-nulled";

const MODEL_FAILURES: ReadonlySet<string> = new Set<string>([
  "parse-failed",
  "truncated",
  "sanity-nulled",
]);

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
  /**
   * THE NUMBER WE READ AND THEN REFUSED, when `outcome` is "sanity-nulled".
   *
   * The plausibility net used to erase the price and flip found=false, which
   * made a photo we had read perfectly produce the identical "nothing usable"
   * panel. The traveller is owed the number: it is the difference between "we
   * are blind" and "we read 25,000/day and that cannot be right".
   */
  rejectedPricePerDay?: number;
  rejectedCurrency?: string;
  /**
   * THIS READING CAME FROM THE BURST LEADER'S FRAME.
   *
   * Burst coalescing runs ONE turn for an album and stamped only the newest
   * frame's row, so the second photo in the conversation carried no reading at
   * all (owner report 5, #6). Every frame now carries the burst's reading; this
   * points at the frame it was read from, so the panel never implies the shown
   * photo was read on its own.
   */
  fromBurstLeader?: string;
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
    /** false = the board crossed this row out (see ReadPrice.available). */
    available?: boolean | null;
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
  /** What the vision classifier called the media - present only on image turns. */
  imageKind?: "vehicle" | "price_sheet" | "document" | "other";
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
    /**
     * THE MODEL ANSWERED AND WE STILL HAVE NOTHING - and that is OUR problem.
     *
     * `seen:true` used to be the end of the story, so an unparseable answer, a
     * truncated one and a price the sanity net erased all arrived at the panel
     * looking exactly like a blank board. This names which of them happened.
     */
    modelFailure?: string;
    /** The implausible number the sanity net rejected (`sanity-nulled`). */
    rejectedPricePerDay?: number;
    rejectedCurrency?: string;
  };
}

/**
 * DOES THIS TURN HOLD A READING OF MEDIA?
 *
 * The stamp that writes a MediaReading onto the message used to ask a
 * different question - "did the caller hand me image BYTES?" - and on the
 * production path the answer is always no. The vision Flow reads the photo in
 * an isolated worker and the CONTINUATION composes the reply, calling the
 * engine with `images: []` and the finished extraction. So the summary was
 * only ever written on the inline path, and in the field every photo rendered
 * with no agent reading under it.
 *
 * The right question is about the EXTRACTION, which carries its own vision
 * provenance whether or not the bytes travelled with it. Pure, so the exact
 * continuation shape is testable without a queue or a database.
 */
export function holdsMediaReading(
  imageCount: number,
  extraction: ExtractionLike | null | undefined
): boolean {
  if (imageCount > 0) return true;
  const e = extraction ?? {};
  // `imageRead` is set by readImages on EVERY extraction that had images -
  // including the ones where every provider failed, which are exactly the
  // turns a traveller most needs an honest "nobody could look at this" for.
  return Boolean(e.imageRead || e.imageKind || clean(e.imageSummary));
}

/**
 * EVERY FRAME OF A BURST CARRIES THE BURST'S READING.
 *
 * A shop sent two menu photos. Burst coalescing (wa/image-burst) makes the
 * NEWEST frame run one turn holding every frame - and the stamp then wrote the
 * reading onto that one row. The older frame kept its media, so it rendered in
 * the conversation with no reading panel at all: the traveller saw one photo
 * explained and an identical one beside it explained by nothing (owner report
 * 5, #6).
 *
 * The frames that stood down never get a turn of their own, so the leader's
 * reading is the only reading they will ever have. This picks the rows that
 * are owed it: same shop, same burst window, media on them, and NO reading of
 * their own (a row that was read on its own turn is never overwritten).
 *
 * Pure, so the selection is testable without a database.
 */
export function burstFollowerRows<
  T extends {
    id: number;
    received_at?: string | null;
    raw?: { media?: unknown; reading?: unknown } | null;
  }
>(rows: T[], leader: { id: number; received_at?: string | null }, windowMs = 30_000): T[] {
  const leaderAt = Date.parse(String(leader.received_at ?? "")) || 0;
  return rows.filter((r) => {
    if (r.id === leader.id) return false;
    if (!r.raw?.media) return false;
    if (r.raw?.reading) return false; // it was read on its own turn - leave it
    if (!leaderAt) return false;
    const at = Date.parse(String(r.received_at ?? "")) || 0;
    return at > 0 && Math.abs(leaderAt - at) <= windowMs;
  });
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

/**
 * WHICH OF THE FIVE THINGS HAPPENED, from the provenance alone.
 *
 * Pure and exported so the taxonomy is testable without a model, a queue or a
 * database - the classification is the fix, so it is the thing under test.
 *
 * Order matters: a model failure OUTRANKS "nobody looked", because a truncated
 * generation is a `seen:false` ladder result whose cause is our token ceiling,
 * not an outage - telling the traveller "the image reader was unavailable"
 * there would be the same lie in a different costume.
 */
export function classifyReading(
  extraction: ExtractionLike | null | undefined,
  blank: boolean
): ReadingOutcome {
  const r = extraction?.imageRead;
  const stamped = clean(r?.modelFailure);
  if (MODEL_FAILURES.has(stamped)) return stamped as ReadingOutcome;
  // The ladder itself can end on our ceiling rather than on an outage.
  if (clean(r?.failure) === "truncated") return "truncated";
  if (r?.seen === false) return "unavailable";
  return blank ? "empty" : "read";
}

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
      // A crossed-out row stays in the reading (the board really does list it)
      // and is marked, so nothing quotes it and the traveller sees why.
      available: typeof o.available === "boolean" ? o.available : undefined,
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

  // THE STATES THAT DID NOT EXIST. A vision pass that never ran cannot report
  // an empty read - it has nothing to report at all - and neither can a pass
  // whose answer we failed to parse, cut off at our ceiling, or overruled.
  // Saying otherwise is the false negative this whole artefact exists to make
  // impossible.
  const blank =
    prices.length === 0 && vehicles.length === 0 && !deposit && conditions.length === 0 && !text;
  const outcome = classifyReading(e, blank);
  const rejected = Number(e.imageRead?.rejectedPricePerDay);

  return {
    outcome,
    unavailableReason:
      outcome === "unavailable"
        ? UNAVAILABLE_REASON[String(e.imageRead?.failure ?? "")] ?? "the image reader was unavailable"
        : undefined,
    rejectedPricePerDay: outcome === "sanity-nulled" && rejected > 0 ? rejected : undefined,
    rejectedCurrency:
      outcome === "sanity-nulled" ? clean(e.imageRead?.rejectedCurrency) || undefined : undefined,
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
 * DID WE FAIL, RATHER THAN THE PHOTO?
 *
 * The one question the panel has to ask before it says anything at all. Every
 * true answer forbids "nothing readable in this one" AND forbids a confidence
 * chip: "CONFIDENCE: LOW" on a failed read is not a statement about the photo,
 * it is the constant the failure branches happened to hardcode.
 */
export function readingIsFailure(r: MediaReading | null | undefined): boolean {
  return Boolean(r && READING_FAILURE_OUTCOMES.has(r.outcome));
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
  // OUR FAILURES, IN OUR OWN NAME. None of these three may borrow the sentence
  // below: that one says the picture held nothing, and here the picture is
  // fine - a typed 3x3 price menu, in the reported case - while our reader,
  // our token ceiling or our own plausibility check is what came up short.
  if (r.outcome === "parse-failed") {
    return "Your agent could not read this one yet - our reader answered with something we could not use. That is our side failing, not your photo, and it is being retried.";
  }
  if (r.outcome === "truncated") {
    return "This board is longer than our reader was allowed to answer, so its reading was cut off part-way. That is our limit, not your photo - your agent is reading it again with more room.";
  }
  if (r.outcome === "sanity-nulled") {
    const amount = r.rejectedPricePerDay
      ? `${r.rejectedPricePerDay}${r.rejectedCurrency ? " " + r.rejectedCurrency : ""}`
      : "";
    return amount
      ? `We read ${amount}/day off this one, which cannot be right for this area - so your agent is asking the shop to confirm it instead of quoting a number we do not trust.`
      : "We read a price off this one that cannot be right for this area - so your agent is asking the shop to confirm it instead of quoting a number we do not trust.";
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
  // A COLLAPSED ROW LIES FASTEST. These three used to fall through to "Nothing
  // readable in this one" - the single line most travellers ever see - about
  // photos we had, in two of the three cases, already read.
  if (r?.outcome === "parse-failed") return "Your agent is re-reading this one";
  if (r?.outcome === "truncated") return "Too long to read in one go - re-reading";
  if (r?.outcome === "sanity-nulled") return "One price here looks wrong - checking";
  if (readingIsEmpty(r)) return "Nothing readable in this one";
  const parts: string[] = [];
  if (r!.prices.length === 1) parts.push("1 price");
  else if (r!.prices.length > 1) parts.push(`${r!.prices.length} prices`);
  if (r!.vehicles.length) parts.push(`${r!.vehicles.length} vehicle${r!.vehicles.length > 1 ? "s" : ""}`);
  if (r!.deposit) parts.push("deposit terms");
  if (r!.conditions.length) parts.push(`${r!.conditions.length} condition${r!.conditions.length > 1 ? "s" : ""}`);
  return parts.length ? `Read ${parts.join(", ")}` : "Read this image";
}
