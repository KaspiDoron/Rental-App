// A TRIP IS A THING THAT HAPPENED - with an outcome, a cost and a saving.
//
// The Trips tab was a list of search sessions re-derived from timestamps on
// every load. That shape can show what is happening right now, and nothing
// else: a session had no outcome, no cost, no saving and no ending, so a
// finished hunt looked exactly like an abandoned one and a traveller who
// actually rented a scooter for four days had nothing to look back at. The tab
// was, in the owner's words, useless.
//
// The missing capability was the ENTITY. A trip is what a traveller remembers -
// "Krabi, four days, the Click 125, 250 a day, saved about 20%" - and none of
// those five facts existed as anything the app could name. This computes them
// from what the funnel already persists (the session's offers, its booking, its
// first quote), so nothing new is stored and nothing can go stale.
//
// PURE: no clock of its own beyond what is passed, no database, no React.

export type TripOutcome =
  | "booked" // the traveller locked a deal
  | "negotiating" // still live
  | "quoted" // prices came in, nothing locked
  | "no-answer" // shops were contacted, none replied
  | "abandoned"; // nothing came of it

export interface TripInput {
  /** Stable identity - the first search row of the hunt, never a time bucket. */
  id: string;
  startedAt: string;
  query: string | null;
  vehicleClass: string | null;
  /** Shops actually contacted, and how many answered. */
  contacted: number;
  replied: number;
  /** The best live quote, and the first/list price it came down from. */
  best: { pricePerDay: number; ask: number | null; currency: string } | null;
  /** A confirmed booking, when there is one. */
  booking: {
    vendorName: string;
    perDay: number | null;
    total: number | null;
    currency: string;
    scheduledAt: string | null;
  } | null;
  /** Rental length, when the request captured one. */
  durationDays?: number | null;
  /** Is this the hunt currently on screen? */
  isLatest: boolean;
  /** Newest activity in the hunt, for the "did anything happen" decision. */
  lastEventAt?: number;
}

export interface Trip {
  id: string;
  startedAt: string;
  outcome: TripOutcome;
  /** One line a traveller would recognise their own trip by. */
  headline: string;
  vehicle: string;
  currency: string;
  /** What it cost per day, once something was locked or quoted. */
  perDay: number | null;
  /** Total for the whole rental, when both parts are known. */
  total: number | null;
  /**
   * How much the negotiation took off the shop's opening price, PER DAY.
   *
   * This is the number the negotiation actually produces: `ask` and
   * `pricePerDay` are both daily rates.
   */
  savedPerDay: number | null;
  /**
   * The same saving OVER THE WHOLE RENTAL - the per-day gap times the days.
   *
   * SEPARATED BECAUSE ONE OF THEM WAS BEING SHOWN AS THE OTHER. Trips summed
   * the per-day figure across trips and captioned it "Your travel savings" /
   * "saved across N trips", so a six-day rental haggled down 50 a day reported
   * 50 instead of 300. Null when the duration is unknown: a total nobody can
   * compute is not a total to guess at.
   */
  saved: number | null;
  savedPct: number | null;
  contacted: number;
  replied: number;
  isLatest: boolean;
}

const LIVE_MS = 45 * 60_000;

function vehicleLabel(input: TripInput): string {
  const cls = String(input.vehicleClass ?? "").toLowerCase();
  if (cls === "car") return "car";
  if (cls === "motorbike") return "motorbike";
  if (cls === "scooter") return "scooter";
  // The traveller's own words are better than a category when we have them.
  const q = (input.query ?? "").trim();
  return q ? q.slice(0, 40) : "rental";
}

/**
 * What became of this hunt. Ordered by certainty: a booking is the strongest
 * fact there is, and "nothing happened" is only claimed when nothing did.
 */
export function outcomeOf(input: TripInput, nowMs: number): TripOutcome {
  if (input.booking) return "booked";
  const live = input.isLatest && nowMs - (input.lastEventAt ?? 0) < LIVE_MS;
  if (live) return "negotiating";
  if (input.best) return "quoted";
  if (input.contacted > 0) return "no-answer";
  return "abandoned";
}

/**
 * THE SAVING, honestly. Only ever the gap between what the shop first asked and
 * what the traveller actually pays - never a comparison against an invented
 * "typical" price, and never negative.
 */
export function savingOf(input: TripInput): {
  savedPerDay: number | null;
  saved: number | null;
  savedPct: number | null;
} {
  const paid = input.booking?.perDay ?? input.best?.pricePerDay ?? null;
  const asked = input.best?.ask ?? null;
  if (paid == null || asked == null || asked <= 0 || paid >= asked) {
    return { savedPerDay: null, saved: null, savedPct: null };
  }
  const savedPerDay = Math.round(asked - paid);
  const days = input.durationDays ?? null;
  // A TOTAL NEEDS A DURATION. Falling back to the per-day figure here is
  // exactly the bug: it is a smaller, wrong number wearing the label of a
  // bigger, right one. Null says "we cannot total this trip", which the caller
  // can report honestly.
  const saved = days != null && days > 0 ? Math.round(savedPerDay * days) : null;
  // The percentage is scale-free - per-day and per-trip give the same answer -
  // so it is unaffected by the split.
  return { savedPerDay, saved, savedPct: Math.round(((asked - paid) / asked) * 100) };
}

const HEADLINES: Record<TripOutcome, (t: { vehicle: string; n: number }) => string> = {
  booked: (t) => `Booked a ${t.vehicle}`,
  negotiating: (t) => `Negotiating with ${t.n} shop${t.n === 1 ? "" : "s"}`,
  quoted: (t) => `${t.n} shop${t.n === 1 ? "" : "s"} quoted a ${t.vehicle}`,
  "no-answer": (t) => `${t.n} shop${t.n === 1 ? "" : "s"} contacted, no replies yet`,
  abandoned: (t) => `Looked for a ${t.vehicle}`,
};

export function toTrip(input: TripInput, nowMs: number): Trip {
  const outcome = outcomeOf(input, nowMs);
  const vehicle = vehicleLabel(input);
  const { savedPerDay, saved, savedPct } = savingOf(input);
  const perDay = input.booking?.perDay ?? input.best?.pricePerDay ?? null;
  const days = input.durationDays ?? null;
  const total =
    input.booking?.total ?? (perDay != null && days != null && days > 0 ? Math.round(perDay * days) : null);
  const n = outcome === "negotiating" || outcome === "no-answer" ? input.contacted : input.replied;
  return {
    id: input.id,
    startedAt: input.startedAt,
    outcome,
    headline: HEADLINES[outcome]({ vehicle, n }),
    vehicle,
    currency: input.booking?.currency ?? input.best?.currency ?? "USD",
    perDay,
    total,
    savedPerDay,
    saved,
    savedPct,
    contacted: input.contacted,
    replied: input.replied,
    isLatest: input.isLatest,
  };
}

// WHAT A FREE TRAVELLER SEES - AND WHERE THAT DECISION NOW LIVES (W6.1).
//
// `previewTrip` / `visibleTrips` used to redact a past trip's numbers so the
// row could stay on screen as a "locked preview". Two things were wrong with
// it. The owner asked for the opposite product (report 5 #17: "the trips
// section should be open only for pro and ultra users, for free we are putting
// upgrade cards tiers"), and the redaction ran in the BROWSER, so the prices,
// the shop names and the whole history shipped to a free plan regardless - a
// curtain, not a gate.
//
// The gate is now in /api/deals: a free plan is answered with `locked: true`
// and a hunt COUNT, and the tab renders real Pro/Ultra tier cards. There is
// nothing left here to redact, so there is no redactor.

// ---------------------------------------------------------------------------
// ACTIVE vs ARCHIVE (W-2b)
//
// Trips rendered ONE card shape for everything: a hunt with shops answering
// right now and a hunt that died three weeks ago got the same 480-line
// dashboard, the same expand chevron, the same "what happens next" panel. So
// the screen grew linearly with use and the one thing a traveller opens it for
// - what is happening with my rental - sank further down the page every week.
//
// The split is not cosmetic and it is not "newest first". It asks one question
// per hunt: CAN ANYTHING STILL CHANGE HERE? Everything else is a record, and a
// record belongs in a list, not in a dashboard.
// ---------------------------------------------------------------------------

/** Whatever the caller calls a hunt - only these four fields are read. */
export interface HuntStamp {
  startedAt: string;
  status: "booked" | "live" | "waiting" | "wrapped";
  /** ISO pick-up time, when the traveller agreed one. */
  scheduledAt?: string | null;
  /** Rental length, so a multi-day rental stays current for its whole run. */
  durationDays?: number | null;
}

/**
 * How long a booked rental keeps its place at the top when we know the pick-up
 * but NOT the length. One day, not a week: claiming a rental is still running
 * when it may have ended yesterday is the same class of lie as showing a
 * week-old hunt as live, just quieter.
 */
export const UNKNOWN_RENTAL_MS = 24 * 3600_000;

/**
 * Can anything still change in this hunt?
 *
 * Deliberately NOT keyed on `isLatest`. "Latest" only means no newer search
 * exists - a hunt from last month is still the latest one if the traveller has
 * not searched since, and treating that as live is precisely the defect
 * `session-life.ts` exists to kill. Age is the honest test.
 */
export function huntIsActive(h: HuntStamp, nowMs: number, ttlMs: number): boolean {
  // A rental that has not been collected yet, or is being ridden right now, is
  // the most current thing on the screen whatever the hunt's age - the search
  // finished a week ago precisely BECAUSE it succeeded.
  const pickup = h.scheduledAt ? Date.parse(h.scheduledAt) : NaN;
  if (Number.isFinite(pickup)) {
    const days = h.durationDays;
    const runsFor = days != null && days > 0 ? days * 24 * 3600_000 : UNKNOWN_RENTAL_MS;
    if (nowMs < pickup + runsFor) return true;
  }

  // Past that, only an unfinished hunt inside the session window is live work.
  //
  // NOTE that a BOOKED hunt with no agreed pick-up falls through to the age
  // rule rather than being archived on the spot. "Pick-up time agreed in chat"
  // is a real and common state, and a deal locked twenty minutes ago is the
  // most current thing the traveller owns - filing it under "earlier hunts"
  // because we happen not to know the hour would hide exactly the card they
  // opened the screen to see.
  if (h.status === "wrapped") return false;
  const started = Date.parse(h.startedAt);
  // An unparseable stamp is filed as history rather than promoted to live: a
  // broken timestamp must never be able to claim the agents are still working.
  if (!Number.isFinite(started)) return false;
  return nowMs - started < ttlMs;
}

export interface HuntSplit<T> {
  active: T[];
  archive: T[];
}

/** Partition hunts into live work and history, preserving the caller's order. */
export function partitionHunts<T extends HuntStamp>(
  hunts: readonly T[],
  nowMs: number,
  ttlMs: number
): HuntSplit<T> {
  const active: T[] = [];
  const archive: T[] = [];
  for (const h of hunts) (huntIsActive(h, nowMs, ttlMs) ? active : archive).push(h);
  return { active, archive };
}
