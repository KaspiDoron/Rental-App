// The Negotiation Director - the chief agent at the center of the digraph.
//
// It sees BOTH this shop's whole thread AND every other shop in the same
// search session, then picks exactly ONE of the LEGAL moves the deterministic
// edge filter computed - or holds the reply (patience is leverage), defers the
// whole decision to a later wakeup, or stays silent. It can NEVER unlock a
// move the discipline forbids: the legal-edge list is computed in code, the
// LLM only chooses among it, and every output is clamped.
//
// Deterministic fallback = the first legal edge by priority, which is
// byte-for-byte the semantics of the legacy decide() ladder - that is what
// makes the migration behavior-preserving with no AI key.

import "server-only";
import { chat, extractJson } from "../ai";
import type {
  DirectorChoice,
  GraphFacts,
  GraphSettings,
  GraphTurnInput,
  LegalEdge,
  NegotiationThreadState,
  SessionShopRow,
} from "./types";

/**
 * The Director's EXACT live system prompt (exported so the Studio's Backend
 * inspector shows precisely what runs - never a paraphrase).
 */
export function directorSystemPrompt(instructions: string): string {
  return (
    "You are the Negotiation Director for a traveller renting a vehicle. You see EVERY shop " +
    "in this search session and this shop's full thread. Hard discipline already computed the " +
    "LEGAL moves below - you may ONLY pick one of them by edgeId, or WAIT, or stay SILENT. " +
    "You can never unlock a move that is not listed.\n" +
    "PRINCIPLES:\n" +
    "- Patience is leverage: nobody owes a shop an instant reply, and letting the shop send " +
    "the last message is strength. Use wait-hold to send the chosen reply after a delay; use " +
    "wait-defer to postpone the WHOLE decision (other shops may answer meanwhile and change " +
    "the leverage).\n" +
    "- Use a lower rival offer honestly; NEVER invent one.\n" +
    "- The LEGAL moves are listed in the launch playbook's priority order - take the FIRST one " +
    "unless you have a strong strategic reason to deviate (say it in reasoning).\n" +
    "- PRICE FIRST, ALWAYS: while a cheaper rival exists or the quote is far above the floor " +
    "and rounds remain, a bargain move listed in LEGAL MOVES is the ONLY acceptable pick - " +
    "never a probe, present, cash-push or acknowledgement. Deposit and fulfillment questions " +
    "come AFTER the price is pushed. Accepting an opening quote near double the floor is the " +
    "one unforgivable mistake.\n" +
    "- Once the price is settled (or no bargain move is legal), complete the deal: we must " +
    "know price, deposit (prefer cash over passport) and fulfillment before the traveller " +
    "sees the offer - THEN prioritize probe moves.\n" +
    "- One 'last price' is not the end when real room remains (quote far above the floor, or a " +
    "cheaper rival in this session): one more gentle move or a package sweetener (helmets, " +
    "delivery, full tank) at their price is allowed. A SECOND firm signal, or any annoyance, " +
    "ends the push immediately - close warmly instead.\n" +
    "- A brief agreeable reply ('Yes.', 'ok') is the START of qualification: keep collecting " +
    "the missing deal fields, never let the thread die on a confirmation.\n" +
    "- If the shop WALKS AWAY ('that's OK, take it there', 'not interested'), thank them " +
    "warmly ONCE and stop completely - chasing a shop that declined burns the relationship.\n" +
    "- A POSTED price list is firmer than a spoken quote: keep asks credible against the " +
    "printed number for the chosen model - a deep lowball against a board kills the deal.\n" +
    "- High mileage or visible scratches/damage from photos are honest, polite leverage.\n" +
    (instructions ? `OWNER GUIDANCE: ${instructions}\n` : "") +
    'Reply ONLY as JSON: { "edgeId": string|null, "action": "act"|"wait-hold"|"wait-defer"|"silent", ' +
    '"waitMinutes": number, "leverageNote": string, "reasoning": string }. ' +
    "leverageNote: if a LOWER real offer from another session shop should be mentioned to this " +
    'shop, describe it in a few words (e.g. "another shop offered 300/day"), else empty. ' +
    "reasoning: two short sentences max."
  );
}

export function deterministicChoice(legal: LegalEdge[], why: string): DirectorChoice {
  if (legal.length === 0) {
    return {
      action: "silent",
      edgeId: null,
      reasoning: "nothing owed - silence is the most human move",
      fromAi: false,
    };
  }
  return {
    action: legal[0].toKind === "silent" ? "silent" : "act",
    edgeId: legal[0].edgeId,
    reasoning: why || `first legal move: ${legal[0].label}`,
    fromAi: false,
  };
}

export async function runDirector(args: {
  input: GraphTurnInput;
  state: NegotiationThreadState;
  facts: GraphFacts;
  legal: LegalEdge[];
  session: SessionShopRow[];
  settings: GraphSettings;
  instructions: string; // owner text on the director node
  target?: number;
  rivalPrice?: number;
  llmAllowed: boolean;
}): Promise<DirectorChoice> {
  const { input, state, facts, legal, session, settings } = args;
  const fallback = deterministicChoice(legal, "deterministic first-match (no AI)");
  if (!args.llmAllowed || legal.length === 0) return fallback;
  // User-action events are direct commands - no strategic second-guessing.
  if (facts.event === "user-close-deal" || facts.event === "user-consent-pickup") {
    return { ...deterministicChoice(legal, "direct traveller action"), fromAi: false };
  }

  const f = state.fields;
  const sessionLines = session.length
    ? session
        .map(
          (s) =>
            `- ${s.vendorName || s.vendorId}${s.isThisShop ? " (THIS shop)" : ""}: ` +
            `${s.pricePerDay ? `${s.pricePerDay} ${s.currency ?? ""}/day` : "no price yet"}` +
            `${s.complete ? ", deal complete" : ""}${s.phase ? `, ${s.phase}` : ""}`
        )
        .join("\n")
    : "(only this shop so far)";
  const numbers = [
    f.pricePerDay ? `quoted ${f.pricePerDay} ${f.currency ?? ""}/day` : "no price yet",
    args.target ? `our next target ${args.target}` : "",
    args.rivalPrice ? `best rival offer ${args.rivalPrice}` : "",
    input.floorPrice ? `real market floor ${input.floorPrice}` : "",
    `bargain rounds used ${f.rounds}/${settings.maxRoundsPerShop}`,
    f.firmCount ? `shop held firm ${f.firmCount}x` : "",
    f.toneDegraded ? "shop tone: annoyed - stop pushing" : "",
    f.mileageKm ? `photo showed mileage ${f.mileageKm} km` : "",
    f.conditionNotes ? `photo condition: ${f.conditionNotes}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
  const missing = [
    facts.priceKnown ? "" : "price",
    facts.depositKnown ? "" : "deposit",
    facts.fulfillmentKnown ? "" : "fulfillment (delivery/pickup/on-shop)",
  ]
    .filter(Boolean)
    .join(", ");

  const system = directorSystemPrompt(args.instructions);

  // Owner-audited learning (edge priors + approved exemplars), compiled into
  // config at review time - one cached read, empty string when nothing is
  // learned or OPS_LEARNING=off, so the base prompt stays byte-identical.
  let learningBlock = "";
  try {
    const { getOpsLearning, formatDirectorLearning } = await import("../ops/learning");
    learningBlock = formatDirectorLearning(await getOpsLearning());
  } catch {
    /* learning is optional context, never a dependency */
  }

  const user =
    `THIS SEARCH SESSION (all shops):\n${sessionLines}\n\n` +
    `THIS SHOP's thread:\n${input.history}\n\n` +
    `Shop's new message: ${input.event.shopMessage || "(media only)"}\n\n` +
    `Numbers: ${numbers}\n` +
    `Deal fields still missing: ${missing || "none - the deal is complete"}\n\n` +
    `LEGAL MOVES (pick edgeId or wait/silent):\n` +
    legal.map((l) => `- ${l.edgeId}: ${l.label} -> ${l.toKind}`).join("\n") +
    (facts.event === "tick"
      ? "\n\nNOTE: this is a WAKEUP after a deliberate wait - decide now; deferring again is not allowed."
      : "") +
    learningBlock;

  const out = await chat([
    { role: "system", content: system },
    { role: "user", content: user },
  ]);
  if (!out) return fallback;
  const parsed = extractJson<{
    edgeId?: string | null;
    action?: string;
    waitMinutes?: number;
    leverageNote?: string;
    reasoning?: string;
  }>(out);
  if (!parsed) return fallback;

  const action =
    parsed.action === "wait-hold"
      ? "wait-hold"
      : parsed.action === "wait-defer"
      ? "wait-defer"
      : parsed.action === "silent"
      ? "silent"
      : "act";

  // ---- clamps: the model proposes, the code disposes ----
  if (action === "silent") {
    return {
      action: "silent",
      edgeId: null,
      reasoning: clip(parsed.reasoning) || "director chose silence",
      fromAi: true,
    };
  }
  if (action === "wait-defer") {
    // Defer only once per inbound; ticks must decide.
    if (facts.event === "tick") return { ...fallback, reasoning: "tick must decide - " + fallback.reasoning };
    // NEVER STALL ON FRESH SUBSTANCE: when the shop just asked us something,
    // gave price info, offered options ("I have different 125cc available")
    // or sent a photo, they are engaged and expect a prompt reply - a
    // strategic wait here reads as rude and stalls a live deal for minutes.
    // Waits stay legitimate after a pure refusal ("cannot lower") where
    // silence is real leverage.
    const freshSubstance =
      facts.shopAskedQuestion ||
      facts.hasClarifyMessage ||
      facts.shopSentVehiclePhoto ||
      Boolean(input.extraction?.found);
    if (freshSubstance) {
      return {
        ...fallback,
        reasoning: "the shop just engaged with substance - answering promptly beats waiting",
      };
    }
    // Mid-qualification waits stay SHORT (a deal in flight goes cold fast);
    // only a complete deal earns the long endgame patience.
    const capMin = facts.dealComplete
      ? settings.strategicWaitMaxMin
      : Math.min(8, settings.strategicWaitMaxMin);
    const mins = clampNum(parsed.waitMinutes, 2, capMin, 5);
    return {
      action: "wait-defer",
      edgeId: null,
      waitSeconds: Math.round(mins * 60),
      leverageNote: clipShort(parsed.leverageNote),
      reasoning: clip(parsed.reasoning) || "deferring for a stronger position",
      fromAi: true,
    };
  }
  // act / wait-hold need a legal edge.
  const edge = legal.find((l) => l.edgeId === parsed.edgeId) ?? legal[0];
  if (action === "wait-hold") {
    const s = clampNum(
      (parsed.waitMinutes ?? 0) * 60,
      settings.waitWindow.minS,
      settings.waitWindow.maxS,
      settings.waitWindow.minS
    );
    return {
      action: "wait-hold",
      edgeId: edge.edgeId,
      waitSeconds: Math.round(s),
      leverageNote: clipShort(parsed.leverageNote),
      reasoning: clip(parsed.reasoning) || `holding "${edge.label}" - patience reads human`,
      fromAi: true,
    };
  }
  return {
    action: edge.toKind === "silent" ? "silent" : "act",
    edgeId: edge.edgeId,
    leverageNote: clipShort(parsed.leverageNote),
    reasoning: clip(parsed.reasoning) || `chose "${edge.label}"`,
    fromAi: true,
  };
}

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const x = Number(v);
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : fallback;
}
function clip(s?: string): string {
  return (s ?? "").trim().slice(0, 500);
}
function clipShort(s?: string): string | undefined {
  const t = (s ?? "").trim().slice(0, 160);
  return t || undefined;
}
