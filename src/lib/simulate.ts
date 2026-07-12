// Dry-run pipeline simulator - runs a HYPOTHETICAL shop reply through the exact
// same brain the live loop uses (extract -> decide -> strategist -> draft ->
// validate), returning every stage's input/reasoning/output, WITHOUT touching
// the database or sending a single WhatsApp message. This is the owner's
// enterprise test bench for prompts + branching, in Admin -> Agents.

import "server-only";
import { extractOffer, composeBargain, currencyForRegion } from "./agents";
import { floorPriceFor } from "./market";
import { decide, type DecisionContext } from "./branching";
import {
  getOrchestratorConfig,
  getDecisionGraph,
  runStrategist,
  validateDraft,
  registerRules,
  ownerDirectives,
} from "./orchestrator";
import { chat } from "./ai";
import type { StructuredRFQ } from "./types";

export interface SimTurn {
  role: "shop" | "us";
  text: string;
}
export interface SimInput {
  shopReply: string;
  rfq?: Partial<StructuredRFQ>;
  region?: string;
  priorThread?: SimTurn[];
  imageKind?: "vehicle" | "price_sheet" | "document" | "other";
}
export interface SimStage {
  stage: string;
  input: string;
  reasoning: string;
  output: string;
  verdict?: string;
}
export interface SimResult {
  direction: string;
  finalMessage: string | null;
  currency: string;
  stages: SimStage[];
}

const DEFAULT_RFQ: StructuredRFQ = {
  vehicleClass: "scooter",
  transmission: "automatic",
  durationDays: 3,
  accessories: [],
  fulfillment: "any",
  vendorMessage: "",
  engineSizeCc: 110,
};

// Same question detector the live loop uses.
function shopAskedQuestion(text: string): boolean {
  return (
    /\?/.test(text) ||
    /\b(you mean|do you mean|which (one|type|kind|model)|what (kind|type|size|model|dates?|day|time)|motor ?bike or car|car or (motor ?)?bike|scooter or (motor ?)?bike|how (many|long|much time)|when (do|will|are) you|where (are|do) you|pick ?up or delivery)\b/i.test(
      text
    )
  );
}

// Best-effort counters from a hypothetical prior thread (so "after our one ask"
// or "already clarified" scenarios behave correctly).
function countFrom(thread: SimTurn[]): DecisionContext["counts"] {
  const c = { clarify: 0, bargain: 0, answer: 0, close: 0 };
  for (const t of thread) {
    if (t.role !== "us") continue;
    const s = t.text.toLowerCase();
    if (/think it over|get back to you|no worries|thanks for your time|appreciate it/.test(s)) c.close++;
    else if (/best|discount|how about|can you do|possible|cheaper|lower|per day|\/day/.test(s)) c.bargain++;
    else if (/\?|confirm|could you|which|what|when|where/.test(s)) c.clarify++;
    else c.answer++;
  }
  return c;
}

export async function simulatePipeline(input: SimInput): Promise<SimResult> {
  const rfq: StructuredRFQ = { ...DEFAULT_RFQ, ...(input.rfq ?? {}) };
  const region = (input.region ?? "").trim() || undefined;
  const thread = input.priorThread ?? [];
  const history = [
    ...thread.map((t) => `${t.role === "us" ? "Us" : "Shop"}: ${t.text}`),
    `Shop: ${input.shopReply}`,
  ].join("\n");
  const stages: SimStage[] = [];

  // 1) Extract (real agent). For a photo scenario we can't run vision without a
  // real image, so the owner-chosen imageKind is honoured directly.
  const extraction = await extractOffer(rfq, input.shopReply || "(price-list photo)", [], history, region);
  if (input.imageKind) extraction.imageKind = input.imageKind;
  const cur = extraction.currency || currencyForRegion(region) || "USD";
  let usablePrice = extraction.found && extraction.pricePerDay ? extraction.pricePerDay : undefined;

  const floor = await floorPriceFor(region, rfq).catch(() => null);
  const floorSameCur = floor && floor.currency === cur ? floor : null;
  if (usablePrice && rfq.durationDays > 1 && floorSameCur) {
    const typical = floorSameCur.typical ?? Math.round(floorSameCur.floor * 1.6);
    const perDayIfTotal = Math.round(usablePrice / rfq.durationDays);
    if (usablePrice >= typical * 2 && perDayIfTotal >= floorSameCur.floor * 0.55) usablePrice = perDayIfTotal;
  }
  stages.push({
    stage: "extract",
    input: input.shopReply || "(photo)",
    reasoning: `found=${extraction.found} matchesSpec=${extraction.matchesSpec} confidence=${extraction.confidence} imageKind=${extraction.imageKind ?? "none"}`,
    output: usablePrice ? `${usablePrice} ${cur}/day` : "(no usable price)",
  });

  // 2) Numbers + decision (the real pure engine).
  const floorPrice = floorSameCur?.floor;
  const priceAtOrBelowFloor = Boolean(usablePrice && floorPrice && usablePrice <= floorPrice * 1.05);
  let target: number | undefined;
  if (usablePrice && !priceAtOrBelowFloor) {
    target = floorPrice ? Math.max(floorPrice, Math.round(usablePrice * 0.6)) : Math.round(usablePrice * 0.85);
  }
  const targetIsRealSaving = Boolean(usablePrice && target && target < usablePrice * 0.95);
  const counts = countFrom(thread);
  const ctx: DecisionContext = {
    sessionClosed: false,
    shopAskedQuestion: shopAskedQuestion(input.shopReply),
    shopSentVehiclePhoto: extraction.imageKind === "vehicle",
    hasUsablePrice: Boolean(usablePrice),
    verified: extraction.found && extraction.matchesSpec && extraction.confidence === "high",
    hasClarifyMessage: Boolean(extraction.clarifyMessage),
    matchesSpecNotFalse: extraction.matchesSpec !== false,
    priceAtOrBelowFloor,
    targetIsRealSaving,
    rivalCheaper: false,
    counts,
  };
  const graph = await getDecisionGraph();
  const decision = decide(ctx, graph);
  const direction = decision.direction;
  stages.push({
    stage: "discipline",
    input: `counters: clarify=${counts.clarify} bargain=${counts.bargain} answer=${counts.answer} close=${counts.close}`,
    reasoning: `rule: ${decision.ruleId ?? "default"} - ${decision.why}`,
    output: direction,
  });

  const cfg = await getOrchestratorConfig();

  // 3) Strategist (real).
  const strat = await runStrategist({
    cfg,
    history,
    sessionDigest: "(simulation - single shop)",
    shopMessage: input.shopReply,
    ladderDirection: direction,
    quotedPerDay: usablePrice,
    targetPerDay: target,
    currency: cur,
  }).catch(() => ({ action: "reply-now", reasoning: "strategist unavailable", fromAi: false } as any));
  stages.push({
    stage: "strategist",
    input: "(single shop in this simulation)",
    reasoning: strat.reasoning,
    output: strat.action + (strat.waitSeconds ? ` ${strat.waitSeconds}s` : ""),
    verdict: strat.fromAi ? undefined : "deterministic",
  });
  if (direction === "silent" || strat.action === "silent") {
    return { direction: "silent", finalMessage: null, currency: cur, stages };
  }

  // 4) Draft (real agents).
  const register = registerRules(cfg, cur, region);
  let draft: string | null = null;
  if (direction === "clarify") {
    draft = extraction.clarifyMessage ?? null;
  } else if (direction === "close") {
    draft = "Thanks so much for the info! Let me think it over and I'll message you again.";
  } else if (direction === "answer") {
    const veh = rfq.vehicleClass === "car" ? "car" : rfq.vehicleClass === "scooter" ? "scooter" : "bike";
    const vehiclePhoto = extraction.imageKind === "vehicle" && !ctx.shopAskedQuestion;
    const sys = vehiclePhoto
      ? "You are the traveller. The shop sent a PHOTO of the actual vehicle. Reply in ONE warm, short sentence: thank them and, only if we have no price yet, ask their best daily price. Never greet again, never accept a deal. " + register + " " + ownerDirectives(cfg, "reply") + " Message text only."
      : "You are the traveller in a WhatsApp chat with a rental shop. The shop asked a question. Answer ONLY it in ONE short casual sentence, never invent facts, never greet again, never accept a deal. " + register + " " + ownerDirectives(cfg, "reply") + " Message text only.";
    draft = (await chat([
      { role: "system", content: sys },
      { role: "user", content: `Conversation so far:\n${history}` },
    ]))?.trim() ?? (vehiclePhoto ? `Thanks for the photo, the ${veh} looks great! What is your best daily price?` : "Could you confirm the daily price for our vehicle?");
  } else if (direction === "bargain" && usablePrice && target) {
    const b = await composeBargain({
      rfq,
      vendor: { name: "the shop" } as never,
      currentPricePerDay: usablePrice,
      region,
      round: 1,
      currency: cur,
      targetPricePerDay: target,
      floorPricePerDay: floorPrice,
      history,
      extraDirectives: [register, ownerDirectives(cfg, "price")].filter(Boolean).join("\n"),
    });
    draft = b.message;
  }
  stages.push({
    stage: direction === "bargain" ? "price-agent" : "reply-agent",
    input: `direction=${direction}${target ? ` target=${target} ${cur}` : ""}`,
    reasoning: decision.why,
    output: draft ?? "(no draft)",
  });
  if (!draft) return { direction, finalMessage: null, currency: cur, stages };

  // 5) Validator (real).
  const priorOutbound = thread.filter((t) => t.role === "us").map((t) => t.text);
  const validation = await validateDraft({
    cfg,
    history,
    draft,
    shopMessage: input.shopReply,
    priorOutbound,
    currency: cur,
  }).catch(() => ({ verdict: "ok", text: draft, reasons: [], fromAi: false } as any));
  stages.push({
    stage: "validator",
    input: draft,
    reasoning: validation.reasons.join("; ") || "clean",
    output: validation.verdict === "veto" ? "(vetoed)" : validation.text,
    verdict: validation.verdict,
  });

  const finalMessage = validation.verdict === "veto" ? null : validation.text;
  return { direction, finalMessage, currency: cur, stages };
}

// Named preset scenarios the owner can one-tap, covering every branch + photo.
export const SIM_SCENARIOS: { id: string; label: string; input: SimInput }[] = [
  { id: "thai-total", label: "Thai '3 day 900' (total vs per-day)", input: { shopReply: "scooter 900 for 3 day", region: "Chiang Mai, Thailand", rfq: { engineSizeCc: 125 } } },
  { id: "question", label: "Shop asks a question", input: { shopReply: "you want scooter or motorbike?", region: "Bali, Indonesia" } },
  { id: "great-price", label: "Great price (at floor) - close", input: { shopReply: "150 baht per day", region: "Chiang Mai, Thailand" } },
  { id: "bargain", label: "High quote - one bargain ask", input: { shopReply: "500 baht per day", region: "Phuket, Thailand" } },
  { id: "deposit-passport", label: "Passport deposit", input: { shopReply: "250 per day, passport as deposit", region: "Bali, Indonesia" } },
  { id: "deposit-cash", label: "Cash deposit amount", input: { shopReply: "300 baht/day, deposit 3000 baht cash", region: "Bangkok, Thailand" } },
  { id: "vague", label: "Vague 'come to the shop'", input: { shopReply: "come to the shop and we will talk", region: "Hanoi, Vietnam" } },
  { id: "wrong-vehicle", label: "Wrong vehicle offered", input: { shopReply: "we only have big 250cc motorbike, 600 a day", region: "Bali, Indonesia", rfq: { vehicleClass: "scooter", engineSizeCc: 110 } } },
  { id: "vehicle-photo", label: "Vehicle photo (thank the shop)", input: { shopReply: "", imageKind: "vehicle", region: "Bali, Indonesia" } },
  { id: "price-sheet", label: "Price-sheet photo", input: { shopReply: "", imageKind: "price_sheet", region: "Bali, Indonesia" } },
  { id: "after-ask", label: "After our one ask (must stop)", input: { shopReply: "sorry cannot, 400 is best", region: "Phuket, Thailand", priorThread: [{ role: "shop", text: "500 per day" }, { role: "us", text: "any chance for 350 per day? that would be perfect" }] } },
];
