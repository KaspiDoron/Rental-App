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

export interface MediaReading {
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
  opts: { usedPricePerDay?: number; notUsedReason?: string } = {}
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

  return {
    prices: prices.slice(0, 8),
    vehicles: vehicles.slice(0, 6),
    deposit: clean(e.deposit) || undefined,
    conditions,
    text: (clean(e.imageSummary) || clean(e.visionText) || clean(e.vehicleDescription))
      .slice(0, 600) || undefined,
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

/** A one-line headline for the collapsed state - what the traveller sees first. */
export function readingHeadline(r: MediaReading | null | undefined): string {
  if (readingIsEmpty(r)) return "Nothing readable in this one";
  const parts: string[] = [];
  if (r!.prices.length === 1) parts.push("1 price");
  else if (r!.prices.length > 1) parts.push(`${r!.prices.length} prices`);
  if (r!.vehicles.length) parts.push(`${r!.vehicles.length} vehicle${r!.vehicles.length > 1 ? "s" : ""}`);
  if (r!.deposit) parts.push("deposit terms");
  if (r!.conditions.length) parts.push(`${r!.conditions.length} condition${r!.conditions.length > 1 ? "s" : ""}`);
  return parts.length ? `Read ${parts.join(", ")}` : "Read this image";
}
