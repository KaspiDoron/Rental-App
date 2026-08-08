// THE FAIL-DARK CONTRACT.
//
// The owner's Command Center made every one of its nine Supabase reads with a
// trailing `.catch(() => [])`. An empty array is indistinguishable from "no
// problems found", so an unreachable database produced ZERO alerts and a green
// panel. The single surface whose whole job is to say "something is wrong"
// reported "nothing is wrong" as its failure mode.
//
// This repo has shipped that exact bug twice already - the banner that read
// "Messaging: All good" while the webhook dropped every reply, and
// classifySafety's positive-evidence-only design. Building a ban-risk dashboard
// on top of the same layer would be a more expensive version of the same lie,
// so the contract lands first and everything else renders through it.
//
// The rule in one line: A METRIC WHOSE SOURCE READ FAILED IS NOT ZERO.

export type TileState =
  /** Read succeeded, value is within tolerance. */
  | "ok"
  /** Read succeeded, value is worrying. */
  | "warn"
  /** Read succeeded, value is bad. */
  | "critical"
  /** THE READ FAILED, or the metric is structurally unavailable. Not zero. */
  | "dark"
  /** Read succeeded and there is genuinely nothing yet (a new account). */
  | "empty";

export interface Tile {
  id: string;
  label: string;
  state: TileState;
  /** Display value. Never a number when state is "dark". */
  value?: string;
  /** Sample size behind a ratio, so E4 can refuse to render one. */
  sample?: number;
  /** True when the underlying list was capped - see E9. */
  truncated?: boolean;
  /** Why it is dark or empty, in words a human can act on. */
  reason?: string;
  /** What the owner should do about it. */
  action?: string;
}

/**
 * SEVERITY ORDER, and the middle two are the interesting ones.
 *
 * `dark` outranks `warn` because an unverifiable fleet is worse than a
 * known-degraded one: with `warn` you know the size of the problem, with `dark`
 * you know nothing at all. It sits below `critical` because a confirmed
 * restriction is still worse than not knowing.
 *
 * `empty` is the LEAST severe - it is a real, successful reading of "nothing
 * has happened yet", which is the correct state for a brand-new account and
 * must never be dressed up as a problem.
 */
const SEVERITY: Record<TileState, number> = {
  empty: 0,
  ok: 1,
  warn: 2,
  dark: 3,
  critical: 4,
};

export function worseOf(a: TileState, b: TileState): TileState {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

export function worstOf(tiles: readonly Tile[]): TileState {
  return tiles.reduce<TileState>((acc, t) => worseOf(acc, t.state), "empty");
}

export interface HeaderVerdict {
  state: TileState;
  darkCount: number;
  total: number;
  /** True when enough of the panel is unreadable that no figure can be trusted. */
  metersUnverified: boolean;
}

/**
 * The panel header. Two rules, and the second is the one that matters:
 *
 *   E6 - the header is the WORST tile, never an average. An average lets one
 *        critical tile hide behind nine healthy ones.
 *   E1 - once 30% or more of the tiles are dark, the header itself goes dark
 *        regardless of what the readable ones say. At that point the panel is
 *        not reporting on the fleet, it is reporting on the subset it could
 *        reach, and presenting that as fleet health is the original lie.
 */
export const DARK_HEADER_FRACTION = 0.3;

export function headerVerdict(tiles: readonly Tile[]): HeaderVerdict {
  const total = tiles.length;
  const darkCount = tiles.filter((t) => t.state === "dark").length;
  const metersUnverified = total > 0 && darkCount / total >= DARK_HEADER_FRACTION;
  return {
    state: metersUnverified ? worseOf(worstOf(tiles), "dark") : worstOf(tiles),
    darkCount,
    total,
    metersUnverified,
  };
}

// ---------------------------------------------------------------------------
// The empty-state rules. Each exists because a specific way of lying was found
// in this codebase, so each is named rather than left to a component's judgement.
// ---------------------------------------------------------------------------

/** E1 - a failed read is dark, never zero. `null` means the read failed. */
export function fromRead<T>(
  id: string,
  label: string,
  rows: readonly T[] | null,
  render: (rows: readonly T[]) => Omit<Tile, "id" | "label">
): Tile {
  if (rows === null) {
    return {
      id,
      label,
      state: "dark",
      reason: "could not be read",
      action: "check the database connection",
    };
  }
  return { id, label, ...render(rows) };
}

/** E2 - genuinely new. A real reading of nothing, and not a problem. */
export function emptyTile(id: string, label: string, reason: string): Tile {
  return { id, label, state: "empty", reason };
}

/** E5 - the metric cannot exist on this stack. Named, never green, never a number. */
export function unavailableTile(id: string, label: string, reason: string): Tile {
  return { id, label, state: "dark", reason, action: "not available on this client version" };
}

/**
 * E4 - the sample floor.
 *
 * Below the floor this returns the FRACTION ("3 replies / 5 intros"), never the
 * ratio. A 60% reply rate computed from n=5 is theatre, and this dashboard
 * exists to stop theatre - the whole reason the 0.6 delivery breaker was
 * trusted is that someone rendered a ratio and nobody asked how many samples
 * were behind it.
 */
export const MIN_RATIO_SAMPLE = 8;

export function ratioValue(numerator: number, denominator: number, unit = ""): string {
  if (denominator < MIN_RATIO_SAMPLE) {
    return `${numerator} / ${denominator}${unit ? ` ${unit}` : ""}`;
  }
  return `${Math.round((numerator / denominator) * 100)}%`;
}

export function hasEnoughSample(denominator: number): boolean {
  return denominator >= MIN_RATIO_SAMPLE;
}

/**
 * E3 - dark receipts.
 *
 * `delivered_total` is a monotonic scalar with no timestamp, so zero conflates
 * "the MESSAGES_UPDATE webhook is dead" with "this account is idle". A meter
 * that cannot go dark will report healthy through the exact outage it exists to
 * catch. Given a last-seen timestamp, silence beyond the window is DARK.
 */
export function receiptLiveness(
  lastReceiptAt: string | null | undefined,
  sentRecently: boolean,
  now = Date.now(),
  windowMs = 6 * 3600_000
): TileState {
  if (!sentRecently) return "empty"; // nothing was sent, so no receipt is due
  if (!lastReceiptAt) return "dark";
  const ts = Date.parse(lastReceiptAt);
  if (!Number.isFinite(ts)) return "dark";
  return now - ts > windowMs ? "dark" : "ok";
}

/**
 * E8 - a stale rollup darkens the WHOLE panel, not one tile.
 *
 * If the snapshot writer stopped, every figure on the page is from an unknown
 * point in the past. Showing them with their normal colours would be the
 * freshest-looking lie the system could tell.
 */
export function rollupStale(
  newestBucketAt: string | null | undefined,
  periodMs: number,
  now = Date.now()
): { stale: boolean; ageMs: number | null } {
  if (!newestBucketAt) return { stale: true, ageMs: null };
  const ts = Date.parse(newestBucketAt);
  if (!Number.isFinite(ts)) return { stale: true, ageMs: null };
  const ageMs = now - ts;
  return { stale: ageMs > periodMs * 2, ageMs };
}

/** E9 - a capped list must say so, or "12 shops" reads as "all of them". */
export function truncationNote(returned: number, limit: number): string | undefined {
  return returned >= limit ? `showing first ${limit}` : undefined;
}

/**
 * E7 - an empty fleet is EMPTY, not healthy.
 *
 * With zero linked accounts every rate is 0/0. Rendering that as "0% blocked,
 * all good" is how a dashboard reports perfect health on a system with no users
 * - which is exactly the state this product is in today.
 */
export function fleetTile(id: string, label: string, accounts: number, body: () => Omit<Tile, "id" | "label">): Tile {
  if (accounts === 0) {
    return { id, label, state: "empty", reason: "no linked accounts yet" };
  }
  return { id, label, ...body() };
}
