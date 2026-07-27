// THE ACTION REGISTRY - the things this app can DO, named once.
//
// Will's "Push harder" opened the chat panel. That was the whole action: the
// bridge he was given exposed view-state setters - open this, scroll to that,
// select these - so the only thing an assistant could ever do was move the
// traveller's eyes. Every offer to help ended in the traveller doing the work.
//
// The missing capability was not a better prompt. It was that the app had no
// vocabulary for its own actions: no list of what can be done, what each one
// needs, who is allowed to do it, and which ones actually send something to a
// shop. Without that vocabulary an assistant cannot be given the ability to act
// safely, so it was given the ability to point.
//
// An action here is a NAME plus a contract:
//   - what it needs (typed arguments)
//   - who may run it (plan entitlement)
//   - whether it reaches a shop (and therefore whether it must be confirmed and
//     must pass the same outbound guard every agent message passes)
//
// The registry is the single source both callers read: Will, and the buttons in
// the UI. That is the point - a capability the traveller has and the assistant
// does not is a capability that will drift, and one of the two will be wrong.
//
// PURE: no React, no database, no network. Executors are supplied by whoever
// mounts the registry, so this file stays testable and cannot itself send
// anything.

import type { Feature } from "../entitlements";

export type ActionId =
  | "push-harder"
  | "ask-deposit"
  | "request-photo"
  | "counter-at"
  | "recheck-prices"
  | "mass-bargain"
  | "compare"
  | "filter-rents-cars";

export interface ActionSpec {
  id: ActionId;
  /** What the traveller would call it. */
  label: string;
  /** One line of what actually happens - shown before an outbound confirm. */
  effect: string;
  /**
   * TRUE when running this puts a message in front of a real shop. Those are
   * confirmed before they run and always go through the outbound guard - the
   * same anti-ban pacing, cancellation and takeover vetoes an agent send passes.
   * Nothing an assistant does gets a shortcut around that.
   */
  outbound: boolean;
  /** Entitlement required, when the action is a paid capability. */
  requires?: Feature;
  /** Argument names this action needs. Missing ones are asked for, not guessed. */
  needs: string[];
}

export const ACTIONS: Record<ActionId, ActionSpec> = {
  "push-harder": {
    id: "push-harder",
    label: "Push this shop harder",
    effect: "Sends one more negotiation message to this shop.",
    outbound: true,
    needs: ["vendorId"],
  },
  "ask-deposit": {
    id: "ask-deposit",
    label: "Ask what the deposit is",
    effect: "Asks this shop for its deposit terms.",
    outbound: true,
    needs: ["vendorId"],
  },
  "request-photo": {
    id: "request-photo",
    label: "Ask for a photo of the vehicle",
    effect: "Asks this shop to send a photo of the actual vehicle.",
    outbound: true,
    needs: ["vendorId"],
  },
  "counter-at": {
    id: "counter-at",
    label: "Counter at a price",
    effect: "Sends this shop a counter-offer at the price you name.",
    outbound: true,
    needs: ["vendorId", "pricePerDay"],
  },
  "recheck-prices": {
    id: "recheck-prices",
    label: "Ask if these prices still stand",
    effect: "Re-asks every shop from a past hunt whether its price still holds.",
    outbound: true,
    requires: "trips-history",
    needs: ["startedAt"],
  },
  "mass-bargain": {
    id: "mass-bargain",
    label: "Bargain with every shop",
    effect: "Starts a negotiation with every matching shop at once.",
    outbound: true,
    requires: "mass-bargain",
    needs: [],
  },
  compare: {
    id: "compare",
    label: "Compare these shops",
    effect: "Opens a side-by-side comparison. Nothing is sent.",
    outbound: false,
    needs: ["vendorIds"],
  },
  "filter-rents-cars": {
    id: "filter-rents-cars",
    label: "Show only shops that rent cars",
    effect: "Filters the board to shops that have shown they rent cars. Nothing is sent.",
    outbound: false,
    needs: [],
  },
};

export type ActionArgs = Record<string, unknown>;

export type ActionRefusal =
  | { ok: false; reason: "unknown-action" }
  | { ok: false; reason: "missing-args"; missing: string[] }
  | { ok: false; reason: "not-entitled"; requires: Feature }
  | { ok: false; reason: "needs-confirm"; effect: string };

export type ActionCheck = { ok: true; spec: ActionSpec } | ActionRefusal;

/**
 * May this action run, right now, with these arguments?
 *
 * Deliberately total and deliberately boring: an unknown name is refused, a
 * missing argument is REPORTED rather than invented, an unentitled action names
 * the feature it needs, and anything that reaches a shop demands confirmation
 * first. An assistant that cannot be refused cleanly is an assistant that will
 * do something surprising.
 */
export function checkAction(opts: {
  id: string;
  args?: ActionArgs;
  plan: string | null | undefined;
  /** The traveller has explicitly approved this outbound action. */
  confirmed?: boolean;
  can: (plan: string | null | undefined, feature: Feature) => boolean;
}): ActionCheck {
  const spec = (ACTIONS as Record<string, ActionSpec | undefined>)[opts.id];
  if (!spec) return { ok: false, reason: "unknown-action" };

  const args = opts.args ?? {};
  const missing = spec.needs.filter((k) => {
    const v = args[k];
    return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
  });
  if (missing.length) return { ok: false, reason: "missing-args", missing };

  if (spec.requires && !opts.can(opts.plan, spec.requires)) {
    return { ok: false, reason: "not-entitled", requires: spec.requires };
  }
  if (spec.outbound && !opts.confirmed) {
    return { ok: false, reason: "needs-confirm", effect: spec.effect };
  }
  return { ok: true, spec };
}

/** The actions an assistant may offer on this plan, for its own prompt. */
export function availableActions(
  plan: string | null | undefined,
  can: (plan: string | null | undefined, feature: Feature) => boolean
): ActionSpec[] {
  return Object.values(ACTIONS).filter((a) => !a.requires || can(plan, a.requires));
}

/** A compact catalogue line per action, for the assistant's prompt. */
export function describeActions(specs: ActionSpec[]): string {
  return specs
    .map(
      (a) =>
        `- ${a.id}(${a.needs.join(", ")}) - ${a.label}. ${a.effect}${
          a.outbound ? " Needs the traveller's OK first." : ""
        }`
    )
    .join("\n");
}

// ---------------------------------------------------------------------------
// AN ACTION HAS AN OUTCOME, AND THE TRAVELLER ALWAYS HEARS IT.
//
// C9 gave the assistant real bodies for its actions, and they ran. What it did
// not give them was a VOICE: `runAction` returned a typed result and the UI
// threw it away. So a refused action, a succeeded action and a genuinely dead
// button were indistinguishable on screen - which is exactly what "Push harder
// and Compare 3 do nothing" describes. "Compare the top 3" was the purest case:
// it set the comparison to a single shop, the sheet only renders with two, and
// nothing anywhere said so.
//
// The fix is not a message per call site - that is how call sites drift. It is
// one function that turns any result into a line, so being silent stops being
// something a caller can do by accident.

export interface ActionOutcome {
  tone: "ok" | "info" | "bad";
  text: string;
}

/**
 * What to tell the traveller about what just happened.
 *
 * `note` lets an executor add the one fact only it knows - how many shops were
 * actually compared, which shop was pushed - without inventing its own phrasing
 * for the refusals, which are the part that must never drift.
 */
export function outcomeFor(
  id: string,
  result: { ok: boolean; reason?: string; missing?: string[]; requires?: string },
  note?: string
): ActionOutcome {
  const spec = (ACTIONS as Record<string, ActionSpec | undefined>)[id];
  const name = spec?.label ?? "That";

  if (result.ok) return { tone: "ok", text: note ?? `${name} - done.` };

  switch (result.reason) {
    case "not-entitled":
      return {
        tone: "info",
        text: `${name} is a Pro feature - upgrade and I'll do it right away.`,
      };
    case "needs-confirm":
      return { tone: "info", text: spec?.effect ? `${spec.effect} - confirm and I'll go.` : `Confirm and I'll go.` };
    case "missing-args":
      return {
        tone: "info",
        text: `I need ${(result.missing ?? []).join(" and ")} before I can do that.`,
      };
    case "unknown-action":
      return { tone: "bad", text: "I do not know how to do that yet." };
    default:
      return { tone: "bad", text: note ?? `${name} did not go through - try again in a moment.` };
  }
}

/**
 * How many shops a comparison actually has to work with.
 *
 * Comparing needs two things to compare. Saying so is the whole point: the
 * button used to set a one-shop comparison, the sheet requires two, and the
 * traveller was left tapping a control that looked broken.
 */
export const MIN_COMPARE = 2;

export function compareOutcome(quoted: number): ActionOutcome | null {
  if (quoted >= MIN_COMPARE) return null;
  return {
    tone: "info",
    text:
      quoted === 1
        ? "Only one shop has quoted so far - I'll line them up the moment a second price lands."
        : "No prices have landed yet - as soon as two shops quote, I'll compare them for you.",
  };
}
