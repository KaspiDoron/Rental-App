// SPTE single pass - the turn's ONE LLM call. A snapshot-grounded, tool-free
// structured generation: the worker pre-fetches the whole context (blackboard +
// thread digest + verified extraction), injects it, and the model runs exactly
// once returning a TurnArtifact JSON. No ReAct tool loop, no multi-agent debate.
//
// Zero-cost: routed through the existing multi-provider failover (Groq ->
// Gemini Flash -> Cerebras -> OpenRouter). On malformed JSON: one retry, then a
// deterministic fallback artifact (never throws, never silent).

import { chat, extractJson } from "../ai";
import type { MoveKind, ModelRoute, TurnArtifact, TurnContext } from "./types";
import { coerceToLegal } from "./policy";

/** Pick the model tier. Multimodal/high-stakes -> Tier M (Gemini Flash);
 *  everything else -> Tier F (the standard failover chain). Reflex (Tier R) is
 *  decided BEFORE this is called and never reaches an LLM. */
export function pickRoute(ctx: TurnContext): ModelRoute {
  const highStakes =
    ctx.legalMoves.includes("close") ||
    ctx.legalMoves.includes("closing-message") ||
    (ctx.legalMoves.includes("bargain") && (ctx.thread.digest.round ?? 0) === 0);
  return highStakes
    ? { tier: "M", reason: "high-stakes" }
    : { tier: "F", reason: "default" };
}

function buildPrompt(ctx: TurnContext): { system: string; user: string } {
  const s = ctx.session;
  const rivalLines = s.rivals.length
    ? s.rivals.map((r) => `- ${r.shop}: ${r.pricePerDay} ${r.currency}/day`).join("\n")
    : "(no other shop has quoted yet)";
  const bench = s.benchmark
    ? `Grounded market rate: ${s.benchmark.pricePerDay} ${s.benchmark.currency}/day (verified from a real listing).`
    : "No verified market rate yet - do NOT invent one.";
  const prior = s.priors?.medianAchieved
    ? `Past travellers here landed around ${s.priors.medianAchieved} ${s.currency}/day (${s.priors.sampleSize} deals).`
    : "";
  const digest = ctx.thread.digest.facts.length
    ? ctx.thread.digest.facts.map((f) => `- ${f}`).join("\n")
    : "(nothing durable yet)";
  const tail = ctx.tail.map((m) => `${m.dir === "in" ? "SHOP" : "YOU"}: ${m.text}`).join("\n");

  const system =
    "You are one traveller haggling on WhatsApp for the cheapest real rental of a specific vehicle. " +
    "Act EXACTLY like a smart human bargainer: warm, brief, never robotic, one clear ask at a time. " +
    "You will output ONE JSON object and nothing else.\n" +
    "HARD RULES:\n" +
    "- Pick `move` ONLY from the LEGAL MOVES list. Nothing else is allowed.\n" +
    "- NEVER invent a competitor price or a market rate. Use ONLY the verified numbers given here. " +
    "If you cite a rival, cite one from the RIVAL OFFERS list verbatim.\n" +
    "- NEVER agree an exact pickup/delivery time - say the traveller will confirm the time directly.\n" +
    "- LICENSE POLICY: if the shop asks whether you have a (international) driving license, answer firmly: " +
    "you have a valid international driving license for this vehicle category. If the shop asks to SEE or get a " +
    "photo/copy of the license, politely defer: you will share it once the rate and rental details are agreed - " +
    "never refuse outright, never send documents, and steer back to the price.\n" +
    "- Keep the message to 1-2 short sentences in simple, everyday English.\n" +
    "OUTPUT JSON shape: { \"read\": {intent, priceMentioned?, declined?, wrongVehicle?, askedLocation?}, " +
    "\"think\": string (<=1 sentence, private), \"move\": string (from LEGAL MOVES), \"message\"?: string, " +
    "\"counterPricePerDay\"?: number, \"leverageUsed\": string[], \"digestPatch\": string[] (<=3 new facts), " +
    "\"waitMinutes\"?: number }.";

  // Duration is real leverage: a multi-day rental earns a longer-stay discount,
  // and the cheapest session rival is the strongest anchor to cite verbatim.
  const days = s.rfq.durationDays;
  const durationLeverage =
    days >= 5
      ? `LEVERAGE: ${days} days is a long rental - push for a multi-day / weekly discount off the daily rate.\n`
      : days >= 3
        ? `LEVERAGE: ${days} days - mention the multi-day booking when you ask for a better rate.\n`
        : "";
  const rivalLeverage =
    s.rivals.length > 0
      ? `LEVERAGE: the cheapest other shop this search is ${s.rivals[0].shop} at ${s.rivals[0].pricePerDay} ${s.rivals[0].currency}/day - you MAY cite it verbatim to ask this shop to match or beat it.\n`
      : "";

  const user =
    `VEHICLE WANTED: ${vehicleLine(ctx)} for ${s.rfq.durationDays} days.\n` +
    `${bench}\n${prior}\n` +
    `RIVAL OFFERS (other shops, this search):\n${rivalLines}\n\n` +
    durationLeverage +
    rivalLeverage +
    `THIS SHOP so far:\n${digest}\n\n` +
    `RECENT MESSAGES:\n${tail || "(none yet)"}\n\n` +
    `SHOP JUST SAID: ${ctx.inbound.text || "(nothing - a scheduled follow-up)"}\n` +
    (ctx.inbound.verified.found && ctx.inbound.verified.pricePerDay
      ? `VERIFIED: the shop's live quote is ${ctx.inbound.verified.pricePerDay} ${ctx.inbound.verified.currency ?? s.currency}/day.\n`
      : "") +
    (ctx.guards.floorPerDay ? `Do not ask below ${ctx.guards.floorPerDay}/day.\n` : "") +
    `LEGAL MOVES: ${ctx.legalMoves.join(", ")}\n` +
    `Choose the best move and write the message.`;

  return { system, user };
}

function vehicleLine(ctx: TurnContext): string {
  const r = ctx.session.rfq;
  if (r.vehicleClass === "car") return `${r.carType ?? "economy"} car`;
  const cc = r.engineSizeCc ? ` ${r.engineSizeCc}cc` : "";
  const tr = r.transmission !== "any" ? `${r.transmission} ` : "";
  return `${tr}${r.vehicleClass}${cc}`;
}

/** The safe templated message for a move, or undefined when a template would
 *  have to invent facts (present/closing need real data; pickup-location needs
 *  the consented stay resolver). */
function templateFor(ctx: TurnContext, move: MoveKind): string | undefined {
  const v = ctx.inbound.verified;
  const days = ctx.session.rfq.durationDays;
  switch (move) {
    case "bargain":
      return v.pricePerDay
        ? `Thanks! Any chance you can do a bit better for ${days} days?`
        : `Could you share your best price for ${days} days?`;
    case "clarify":
      return `Could you send the price per day as text? 🙂`;
    case "redirect-close":
      return `No worries, thanks for letting me know - have a great day!`;
    case "close":
      return `All good, thank you so much for your time!`;
    case "answer":
      // NEVER-SILENT (the live "agent never replied to my question" failure):
      // license asks get the exact policy lines; any other question gets an
      // honest, safe redirect to the one thing we always want - the daily rate.
      if (v.askedLicensePhoto)
        return `Sure - I'll share a photo of my license once we finalize the rate and rental details 👍 What's your best price per day?`;
      if (v.askedLicense)
        return `Yes, I have a valid international driving license for this. What would your best price per day be?`;
      return `Good question! Let's sort the main thing first - what's your best price per day for the ${days} days? Then we can go over the details.`;
    case "deposit-probe":
      return `Great - and what deposit do you need? Cash or passport?`;
    case "fulfillment-probe":
      return `Could you deliver it, or do I pick it up at your shop?`;
    case "momentum":
      return `Hi again! Just checking in - any chance on that better rate for ${days} days?`;
    default:
      return undefined; // present / closing-message / pickup-location / silent
  }
}

/** A deterministic, never-silent fallback when the LLM is unavailable or its
 *  output is unusable. Walks the LEGAL ladder and takes the FIRST move that has
 *  a safe template - so a turn that owes the shop a reply never goes silent
 *  just because the top-priority move needed composed content. */
export function fallbackArtifact(ctx: TurnContext): TurnArtifact {
  let move: MoveKind = "silent";
  let message: string | undefined;
  for (const m of ctx.legalMoves) {
    const t = templateFor(ctx, m);
    if (t) {
      move = m;
      message = t;
      break;
    }
  }
  return {
    read: { intent: "fallback" },
    think: "deterministic fallback (no usable LLM output)",
    move: message ? move : "silent",
    message,
    leverageUsed: [],
    digestPatch: [],
  };
}

/** Run the single pass. Returns a validated TurnArtifact (never throws). */
export async function runSinglePass(ctx: TurnContext): Promise<{ artifact: TurnArtifact; route: ModelRoute }> {
  const route = pickRoute(ctx);
  const { system, user } = buildPrompt(ctx);

  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await chat(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { maxTokens: 500, budgetMs: 9000 }
    );
    if (!raw) break; // no provider available -> fallback
    const parsed = extractJson<Partial<TurnArtifact>>(raw);
    if (parsed && typeof parsed.move === "string") {
      const artifact: TurnArtifact = {
        read: parsed.read ?? { intent: "" },
        think: typeof parsed.think === "string" ? parsed.think.slice(0, 200) : "",
        move: parsed.move as MoveKind,
        message: typeof parsed.message === "string" ? parsed.message : undefined,
        counterPricePerDay:
          typeof parsed.counterPricePerDay === "number" ? parsed.counterPricePerDay : undefined,
        leverageUsed: Array.isArray(parsed.leverageUsed) ? (parsed.leverageUsed as TurnArtifact["leverageUsed"]) : [],
        digestPatch: Array.isArray(parsed.digestPatch) ? parsed.digestPatch.slice(0, 3).map(String) : [],
        waitMinutes: typeof parsed.waitMinutes === "number" ? parsed.waitMinutes : undefined,
      };
      // NEVER trust an out-of-set move (the B7 lesson, generalized).
      artifact.move = coerceToLegal(artifact, ctx.legalMoves);
      return { artifact, route };
    }
    // malformed JSON -> retry once, then fall through.
  }
  return { artifact: fallbackArtifact(ctx), route: { tier: "R", reason: "quota-overflow" } };
}
