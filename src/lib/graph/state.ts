// Per-thread negotiation state - the engine's durable checkpoint between
// serverless invocations. Supabase table `negotiation_threads` when available,
// with a process-global in-memory fallback so the engine keeps working before
// the migration ran (golden rule: everything degrades gracefully).

import type { ExtractedOffer } from "../agents";
import type {
  FulfillmentKind,
  NegotiationThreadState,
  ThreadFields,
  ThreadPhase,
} from "./types";

export function threadKeyFor(userEmail: string | undefined, toDigits: string): string {
  return `${userEmail ?? "system"}:${toDigits.replace(/[^\d]/g, "")}`;
}

export function newThreadState(args: {
  threadKey: string;
  userEmail?: string;
  vendorId?: string;
  vendorName?: string;
  toNumber: string;
}): NegotiationThreadState {
  return {
    threadKey: args.threadKey,
    userEmail: args.userEmail ?? "system",
    vendorId: args.vendorId ?? "",
    vendorName: args.vendorName ?? "",
    toNumber: args.toNumber,
    phase: "opening",
    version: 0,
    fields: { firmCount: 0, toneDegraded: false, rounds: 0 },
    nodeRuns: {},
    waitingUntil: null,
    updatedAt: new Date(0).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Deal completeness
// ---------------------------------------------------------------------------

export function priceKnown(f: ThreadFields): boolean {
  return typeof f.pricePerDay === "number" && f.pricePerDay > 0;
}

export function depositKnown(f: ThreadFields): boolean {
  return Boolean(f.depositType) || Boolean(f.depositNote);
}

export function fulfillmentKnown(f: ThreadFields): boolean {
  return f.fulfillment === "pickup" || f.fulfillment === "delivery" || f.fulfillment === "on-shop";
}

/** A deal may be PRESENTED only when all three pillars are known. */
export function dealComplete(f: ThreadFields): boolean {
  return priceKnown(f) && depositKnown(f) && fulfillmentKnown(f);
}

export function missingFields(f: ThreadFields): ("price" | "deposit" | "fulfillment")[] {
  const out: ("price" | "deposit" | "fulfillment")[] = [];
  if (!priceKnown(f)) out.push("price");
  if (!depositKnown(f)) out.push("deposit");
  if (!fulfillmentKnown(f)) out.push("fulfillment");
  return out;
}

/** Phase derived from the fields - a pure projection, never stored stale. */
export function derivePhase(state: NegotiationThreadState): ThreadPhase {
  const f = state.fields;
  if (state.phase === "closed" || state.phase === "dead" || state.phase === "closing") {
    return state.phase; // terminal-ish phases only move via explicit events
  }
  if (f.presented) return "presented";
  if (dealComplete(f)) return "complete";
  if (priceKnown(f) && (depositKnown(f) || fulfillmentKnown(f) || f.rounds > 0)) {
    return depositKnown(f) && fulfillmentKnown(f) ? "complete" : "collecting_terms";
  }
  if (priceKnown(f)) return "negotiating";
  return state.nodeRuns["clarify"] || state.nodeRuns["answer"] ? "awaiting_price" : "opening";
}

/**
 * Lightweight state-machine sanity: is this phase move structurally legal?
 * NEVER blocks (behavior unchanged) - illegal jumps are recorded as
 * `phase-anomaly` events so the "deal settled but still bargaining/queued"
 * class of bug is caught structurally instead of per-symptom.
 */
export function validatePhaseTransition(from: string, to: string): boolean {
  if (from === to) return true;
  // Terminal phases never reopen implicitly (a NEW session starts a new
  // thread lifecycle; that path resets state explicitly).
  if (from === "closed" || from === "dead") return false;
  // Closing may only settle, complete or present - never resume bargaining.
  if (from === "closing") {
    return to === "closed" || to === "complete" || to === "presented";
  }
  return true;
}

// ---------------------------------------------------------------------------
// Applying an extraction to the state (the ONLY place inbound facts land)
// ---------------------------------------------------------------------------

export function applyExtractionToState(
  state: NegotiationThreadState,
  extraction: ExtractedOffer | null,
  usablePrice: number | undefined,
  currency: string
): NegotiationThreadState {
  if (!extraction) return state;
  const f = { ...state.fields };

  if (usablePrice && usablePrice > 0) {
    f.pricePerDay = usablePrice;
    f.currency = currency;
    f.priceVerified = Boolean(
      extraction.found && extraction.matchesSpec && extraction.confidence === "high"
    );
    // A PRINTED price list is a firmer anchor than a spoken quote - remember
    // the listed price so the bargaining ladder keeps its asks credible
    // (deep lowballs against a posted board kill deals).
    if (extraction.imageKind === "price_sheet") f.sheetPricePerDay = usablePrice;
  }
  if (extraction.depositType) {
    f.depositType = extraction.depositType;
    if (typeof extraction.depositAmount === "number") f.depositAmount = extraction.depositAmount;
    f.depositCurrency = extraction.depositCurrency ?? f.currency;
  }
  if (extraction.deposit) f.depositNote = extraction.deposit;

  // Fulfillment: explicit statements only, never guessed. Delivery wins over
  // on-shop when both appear ("no delivery... ok we deliver for 100" edge is
  // resolved by the LAST reply re-running this).
  if (extraction.pickupOffered === true) {
    f.pickupOffered = true;
    if (!f.fulfillment) f.fulfillment = "pickup";
  }
  if (extraction.delivers === true) f.fulfillment = "delivery";
  else if (extraction.onShopOnly === true && f.fulfillment !== "delivery") f.fulfillment = "on-shop";
  else if (extraction.delivers === false && !f.fulfillment && !f.pickupOffered) {
    f.fulfillment = "on-shop";
  }
  if (typeof extraction.deliveryFee === "number") f.deliveryFee = extraction.deliveryFee;

  // Extract-everything media memory: what a photo showed once stays known
  // (mileage and scratches become honest bargaining leverage later).
  if (typeof extraction.mileageKm === "number" && extraction.mileageKm > 0) {
    f.mileageKm = extraction.mileageKm;
  }
  if (extraction.conditionNotes) f.conditionNotes = extraction.conditionNotes.slice(0, 200);
  if (extraction.imageSummary) f.mediaSummary = extraction.imageSummary.slice(0, 500);

  // "Last price / cannot lower" only counts as FIRM when the shop is
  // defending a price we actually know. A firm-sounding line BEFORE any quote
  // ("cannot lower, last price" with no number yet) must not end the bargain
  // before it started - that exact case froze a 300-vs-160-floor negotiation.
  if (extraction.shopFirm === true && f.pricePerDay) f.firmCount = (f.firmCount ?? 0) + 1;
  if (extraction.shopTone === "annoyed") f.toneDegraded = true;
  // The shop walked away ("take it there") - the negotiation is OVER. One warm
  // goodbye at most, then silence; the UI shows the thread as declined.
  if (extraction.shopDeclined === true) f.declined = true;

  const next = { ...state, fields: f };
  next.phase = derivePhase(next);
  return next;
}

// ---------------------------------------------------------------------------
// Storage - Supabase first, process-memory fallback
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __wd_graph_threads__: Map<string, NegotiationThreadState> | undefined;
}

function mem(): Map<string, NegotiationThreadState> {
  if (!globalThis.__wd_graph_threads__) globalThis.__wd_graph_threads__ = new Map();
  return globalThis.__wd_graph_threads__;
}

interface Row {
  thread_key: string;
  user_email: string;
  vendor_id: string | null;
  vendor_name: string | null;
  to_number: string;
  phase: string;
  version: number;
  fields: ThreadFields | null;
  node_runs: Record<string, number> | null;
  waiting_until: string | null;
  last_decision_id: string | null;
  updated_at: string;
}

function fromRow(r: Row): NegotiationThreadState {
  return {
    threadKey: r.thread_key,
    userEmail: r.user_email,
    vendorId: r.vendor_id ?? "",
    vendorName: r.vendor_name ?? "",
    toNumber: r.to_number,
    phase: (r.phase as ThreadPhase) || "opening",
    version: r.version ?? 0,
    fields: { firmCount: 0, toneDegraded: false, rounds: 0, ...(r.fields ?? {}) },
    nodeRuns: r.node_runs ?? {},
    waitingUntil: r.waiting_until,
    lastDecisionId: r.last_decision_id ?? undefined,
    updatedAt: r.updated_at,
  };
}

export async function loadThreadState(
  threadKey: string
): Promise<NegotiationThreadState | null> {
  try {
    const { sbSelect } = await import("../runtime-config");
    const rows = await sbSelect<Row>(
      "negotiation_threads",
      `select=*&thread_key=eq.${encodeURIComponent(threadKey)}&limit=1`
    );
    if (rows[0]) return fromRow(rows[0]);
  } catch {
    /* table missing / Supabase unset - memory fallback below */
  }
  return mem().get(threadKey) ?? null;
}

/**
 * Optimistic save: UPDATE ... WHERE version = n. On a lost race the engine's
 * other protections (wa_processed claim, guardOutbound dedupe) already prevent
 * a double send; we re-read and merge counters so nothing is under-counted.
 */
export async function saveThreadState(state: NegotiationThreadState): Promise<void> {
  const next: NegotiationThreadState = {
    ...state,
    version: state.version + 1,
    updatedAt: new Date().toISOString(),
  };
  mem().set(state.threadKey, next); // memory copy always fresh
  try {
    const { sbSelect, sbInsert, sbUpdate } = await import("../runtime-config");
    const row = {
      thread_key: next.threadKey,
      user_email: next.userEmail,
      vendor_id: next.vendorId,
      vendor_name: next.vendorName,
      to_number: next.toNumber,
      phase: next.phase,
      version: next.version,
      fields: next.fields,
      node_runs: next.nodeRuns,
      waiting_until: next.waitingUntil ?? null,
      last_decision_id: next.lastDecisionId ?? null,
      updated_at: next.updatedAt,
    };
    const existing = await sbSelect<{ version: number; phase: string }>(
      "negotiation_threads",
      `select=version,phase&thread_key=eq.${encodeURIComponent(next.threadKey)}&limit=1`
    );
    if (existing.length === 0) {
      await sbInsert("negotiation_threads", [row]);
      return;
    }
    // Structural sanity (free - piggybacks on the version read): an illegal
    // phase jump is logged, never blocked.
    if (existing[0].phase && !validatePhaseTransition(existing[0].phase, next.phase)) {
      await sbInsert("agent_events", [
        {
          kind: "phase-anomaly",
          vendor_id: next.vendorId,
          vendor_name: next.vendorName,
          detail: `Thread ${next.threadKey} jumped ${existing[0].phase} -> ${next.phase} (structurally illegal - investigate).`,
        },
      ]).catch(() => {});
    }
    // Optimistic write - only wins if nobody else bumped the version.
    await sbUpdate(
      "negotiation_threads",
      `thread_key=eq.${encodeURIComponent(next.threadKey)}&version=eq.${state.version}`,
      row
    );
    // Lost race? Merge counters with the winner (max of each) - counters only
    // ever grow, so max is the safe union; a doubled counter is safer than an
    // under-count (it can only make the agent MORE polite, never pushier).
    const after = await sbSelect<Row>(
      "negotiation_threads",
      `select=*&thread_key=eq.${encodeURIComponent(next.threadKey)}&limit=1`
    );
    if (after[0] && after[0].version !== next.version) {
      const winner = fromRow(after[0]);
      const merged: NegotiationThreadState = {
        ...winner,
        nodeRuns: mergeCounters(winner.nodeRuns, next.nodeRuns),
        fields: {
          ...winner.fields,
          firmCount: Math.max(winner.fields.firmCount ?? 0, next.fields.firmCount ?? 0),
          rounds: Math.max(winner.fields.rounds ?? 0, next.fields.rounds ?? 0),
          toneDegraded: winner.fields.toneDegraded || next.fields.toneDegraded,
        },
        version: winner.version + 1,
      };
      await sbUpdate(
        "negotiation_threads",
        `thread_key=eq.${encodeURIComponent(next.threadKey)}&version=eq.${winner.version}`,
        {
          fields: merged.fields,
          node_runs: merged.nodeRuns,
          version: merged.version,
          phase: merged.phase,
          updated_at: new Date().toISOString(),
        }
      ).catch(() => {});
      mem().set(state.threadKey, merged);
    }
  } catch {
    /* Supabase unavailable - memory copy is already saved */
  }
}

function mergeCounters(
  a: Record<string, number>,
  b: Record<string, number>
): Record<string, number> {
  const out: Record<string, number> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] ?? 0, v);
  return out;
}
