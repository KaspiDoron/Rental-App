// DID WE READ THE PHOTO RIGHT?
//
// Most rental shops answer with a picture of their price board, not with text.
// The live thread that motivated this (+66 65 353 6775): four photo boards -
// a model x duration grid, deposit options, insurance terms, delivery area -
// and the agent replied "Could you send the price per day as text? 🙂". The shop
// then typed "If you rent a Click 125 for 5 days, it costs 1,250฿" - which
// AGREES with the board (250/day) and could have proved the read was right.
// Nothing compared them, so the OCR was never verified and never scored.
//
// The loop this file closes:
//   1. read the board  -> sheetPricePerDay
//   2. ask a confirming yes/no that STATES what we read (spte/pass.ts)
//   3. the shop answers in text -> textPricePerDay
//   4. compare -> confirmed | conflict | unconfirmed
//
// Pure and unit-tested. The verdict is a KPI (visionAccuracy) AND a negotiation
// signal: a conflict means the number in the app is not safe to bargain from.

/** Same 5% band the rival-citation rail uses - a rounded restatement agrees. */
export const PRICE_AGREEMENT_TOLERANCE = 0.05;

export type VisionAgreement = "confirmed" | "conflict" | "unconfirmed";

export interface ReconcileInput {
  /** What we read off the shop's photo/price board. */
  sheetPricePerDay?: number;
  /** What the shop later typed, per day. */
  textPricePerDay?: number;
  /** A whole-rental total the shop typed ("1,250฿ for 5 days") + the duration,
   *  so a trip quote can verify a per-day board reading. */
  textTotal?: number;
  durationDays?: number;
}

export interface ReconcileResult {
  agreement: VisionAgreement;
  /** Signed difference as a fraction of the photo price (text vs photo). */
  deltaPct?: number;
  /** The per-day number the text actually asserted, after dividing a total. */
  textPerDay?: number;
  /** Plain-language reason - shown in the Ops transcript, never sent to a shop. */
  detail: string;
}

/**
 * Compare a photo-derived price with a text-stated one. Returns "unconfirmed"
 * (never a guess) when either side is missing - the honest default, because an
 * unverified read must not be scored as a success.
 */
export function reconcileVisionPrice(input: ReconcileInput): ReconcileResult {
  const sheet = num(input.sheetPricePerDay);
  const days = input.durationDays && input.durationDays > 0 ? input.durationDays : undefined;
  // A typed trip total verifies a per-day board reading just as well as a typed
  // daily rate - "1,250 for 5 days" IS "250/day".
  const fromTotal =
    num(input.textTotal) !== undefined && days ? Math.round(num(input.textTotal)! / days) : undefined;
  const text = num(input.textPricePerDay) ?? fromTotal;

  if (sheet === undefined && text === undefined) {
    return { agreement: "unconfirmed", detail: "no price from either the photo or the text" };
  }
  if (sheet === undefined) {
    return { agreement: "unconfirmed", textPerDay: text, detail: "text price only - no photo reading to check" };
  }
  if (text === undefined) {
    return { agreement: "unconfirmed", detail: "photo reading not confirmed in text yet" };
  }

  const deltaPct = (text - sheet) / sheet;
  const agrees = Math.abs(text - sheet) <= Math.max(1, sheet * PRICE_AGREEMENT_TOLERANCE);
  return {
    agreement: agrees ? "confirmed" : "conflict",
    deltaPct,
    textPerDay: text,
    detail: agrees
      ? `photo read ${sheet}/day, shop typed ${text}/day - agrees`
      : `photo read ${sheet}/day but the shop typed ${text}/day (${signed(deltaPct)}) - trust the typed price`,
  };
}

/**
 * Which number to negotiate from. On a conflict the TYPED price wins: a shop's
 * own words beat our reading of their photo, and bargaining from a misread board
 * is how an agent asks for a discount the shop never offered.
 */
export function trustedPrice(input: ReconcileInput): number | undefined {
  const r = reconcileVisionPrice(input);
  if (r.textPerDay !== undefined) return r.textPerDay;
  return num(input.sheetPricePerDay);
}

export interface VisionAccuracy {
  confirmed: number;
  conflict: number;
  unconfirmed: number;
  photoTurns: number;
  /** confirmed / (confirmed + conflict), or null while nothing is verified. */
  accuracyPct: number | null;
  /** Share of photo turns we ever managed to verify at all. */
  verifiedPct: number | null;
}

/**
 * Roll turn verdicts into the admin KPI. Pure, so the number on the dashboard is
 * unit-tested rather than trusted.
 */
export function visionAccuracy(
  turns: Array<{ hadImage?: boolean; agreement?: VisionAgreement | null }>
): VisionAccuracy {
  let confirmed = 0;
  let conflict = 0;
  let unconfirmed = 0;
  let photoTurns = 0;
  for (const t of turns) {
    if (!t.hadImage) continue;
    photoTurns++;
    if (t.agreement === "confirmed") confirmed++;
    else if (t.agreement === "conflict") conflict++;
    else unconfirmed++;
  }
  const judged = confirmed + conflict;
  return {
    confirmed,
    conflict,
    unconfirmed,
    photoTurns,
    accuracyPct: judged > 0 ? Math.round((confirmed / judged) * 100) : null,
    verifiedPct: photoTurns > 0 ? Math.round((judged / photoTurns) * 100) : null,
  };
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}
function signed(pct: number): string {
  const p = Math.round(pct * 100);
  return `${p > 0 ? "+" : ""}${p}%`;
}
