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
import { isRepetitive } from "../wa/similarity";
import { clampWaitMinutes } from "./wait";
import { nextGap } from "../offer-options";

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
    "- When asking about deposit or delivery/pickup, make it clear we are still deciding between a few shops - never imply a guaranteed booking.\n" +
    "- If the shop has said its price is final/last more than once, DO NOT ask for a lower price again - accept warmly or move to logistics.\n" +
    "- LICENSE POLICY: if the shop asks whether you have a (international) driving license, answer firmly: " +
    "you have a valid international driving license for this vehicle category. If the shop asks to SEE or get a " +
    "photo/copy of the license, politely defer: you will share it once the rate and rental details are agreed - " +
    "never refuse outright, never send documents, and steer back to the price.\n" +
    "- Keep the message to 1-2 short sentences in simple, everyday English.\n" +
    (ctx.session.coaching && ctx.session.coaching.trim()
      ? `${ctx.session.coaching.trim()}\n`
      : "") +
    "OUTPUT JSON shape: { \"read\": {intent, priceMentioned?, declined?, wrongVehicle?, askedLocation?}, " +
    "\"think\": string (<=1 sentence, private), \"move\": string (from LEGAL MOVES), \"message\"?: string, " +
    "\"counterPricePerDay\"?: number, \"leverageUsed\": string[], \"digestPatch\": string[] (<=3 new facts), " +
    "\"waitMinutes\"?: number }.";

  // Duration is real leverage: a multi-day rental earns a longer-stay discount,
  // and the cheapest session rival is the strongest anchor to cite verbatim.
  const days = s.rfq.durationDays;
  const dg = ctx.thread.digest;
  const round = dg.round ?? 0;

  // ROUND-AWARE directive (ported from composeBargain): each push has a distinct
  // shape so four turns never read as one template. The model varies the words;
  // this varies the ANGLE.
  const roundPlay = ctx.legalMoves.includes("bargain")
    ? round <= 0
      ? `BARGAIN ANGLE (first push): warmly say the quote is a bit high for you, use the ${days}-day rental as your reason, and ask for a friendly better daily rate. Vary the exact wording.\n`
      : round === 1
        ? `BARGAIN ANGLE (second push): DO NOT repeat the "since I'm booking for ${days} days" line - you already used it. Switch lever: ask for a small round-number discount, or a free extra (helmet/fuel/delivery), or mention you're ready to book right now.\n`
        : `BARGAIN ANGLE (final gentle nudge): one last soft ask, then you will accept. Use a DIFFERENT phrasing and lever from your earlier messages.\n`
    : "";

  // FIRM state - the two-firms-stop rule made explicit to the model too.
  const firmNote =
    (dg.firmCount ?? 0) >= 2
      ? `The shop has said this is their LAST/BEST price ${dg.firmCount} times. STOP asking for a lower price - do not haggle again. Instead move on to logistics (deposit, delivery/pickup) or accept warmly.\n`
      : (dg.firmCount ?? 0) === 1
        ? `The shop called this their best price once. Only push again if you have real leverage (a cheaper rival or a price well above market); otherwise switch to logistics.\n`
        : "";

  // QUESTION obligation - answer what the shop asked, first.
  const questionNote =
    ctx.inbound.verified.askedQuestion || ctx.inbound.verified.askedLocation
      ? `The shop ASKED YOU something in their last message. Your reply MUST answer their question first, in a natural way, before anything else.\n`
      : "";

  // ANTI-REPETITION - the real fix for "same sentence every turn". The model
  // never saw its own prior sends; now it does, with a hard rule.
  const priorSends = (dg.lastOutbound ?? []).filter(Boolean);
  const repetitionNote = priorSends.length
    ? `YOUR PREVIOUS MESSAGES in this chat (NEVER reuse their sentence structure or a lever you already played - a repeated line reads as a bot):\n${priorSends
        .map((m) => `  • ${m}`)
        .join("\n")}\n`
    : "";

  // THE MENU. When the shop has offered a choice, the turn's job is to make the
  // tiers comparable - what separates them and a photo of each - and the gaps
  // below say exactly what is still unknown, so we never re-ask what they told
  // us. Stated as the situation, not as a script: the model writes the question.
  const options = dg.options ?? [];
  const menuBlock = options.length
    ? `THIS SHOP'S OPTIONS (they offered a CHOICE - do NOT collapse it to one price):\n` +
      options
        .map(
          (o) =>
            `- ${o.label}: ${o.pricePerDay} ${o.currency ?? s.currency}/day` +
            (o.mileageKm ? `, ${o.mileageKm} km` : "") +
            (o.gaps.length ? ` [still unknown: ${o.gaps.join(", ")}]` : " [fully known]")
        )
        .join("\n") +
      `\n`
    : "";
  // THE VEHICLE GATE'S FINDING, handed to the model as a fact rather than left
  // for it to re-derive. Two live threads ended with a 110cc on the traveller's
  // screen as BEST PRICE because the model was asked to infer what a nameplate
  // is; here it is simply told what is unresolved and what to ask.
  const vehiclePlay = ctx.legalMoves.includes("confirm-vehicle")
    ? `YOUR JOB THIS TURN: the price on the table cannot be tied to the vehicle the traveller declared - ${
        ctx.inbound.verified.vehicleQuestion || "confirm exactly which vehicle it is"
      } Ask that, warmly, in ONE short message. Do NOT bargain, do NOT confirm a deal and do NOT repeat the price as if it were theirs: a number for the wrong vehicle is worse than no number, because the traveller's licence covers only what they searched for.\n`
    : "";
  const optionPlay = ctx.legalMoves.includes("option-probe")
    ? `YOUR JOB THIS TURN: the traveller cannot choose between these yet. In ONE short message, ask what actually separates them - ${
        nextGap(options) === "mileage"
          ? "how old each one is and roughly how many km"
          : nextGap(options) === "photo"
            ? "for a quick photo of each"
            : nextGap(options) === "condition"
              ? "which is the newer one"
              : "the deposit for each"
      } - and ask for a photo of each if you have not already. Do NOT bargain yet: haggling a price the traveller has not picked wastes the one discount this shop will give.\n`
    : "";

  // THE ONLY LOCATION THE MODEL MAY WRITE. Everything else - a guessed area, a
  // coordinate, a maps link we did not build - is a privacy incident, so it is
  // stated as a verbatim fact rather than left to the model's judgement.
  const locationBlock = ctx.legalMoves.includes("pickup-location")
    ? `THE TRAVELLER'S LOCATION (server-verified, the ONLY one you may write): ${ctx.share?.addressText}${
        ctx.share?.mapsLink
          ? `\nAPPROVED MAPS LINK - reproduce it EXACTLY, character for character: ${ctx.share.mapsLink}`
          : `\nThere is NO approved maps link. Never invent one and never write coordinates.`
      }\n`
    : "";

  const durationLeverage =
    round <= 0 && days >= 3 && ctx.legalMoves.includes("bargain")
      ? `Duration is your lever this first push: ${days} days is a long rental.\n`
      : "";

  // Rival leverage is a HARD rule when a verified cheaper rival exists (ported
  // from composeBargain) - "you MAY cite" let the model ignore Shop A's 300.
  // Only a GENUINELY cheaper rival is leverage. The old `?? rivals[0]` fallback
  // meant that with no cheaper rival we still ordered the model to name a MORE
  // expensive shop and "ask this shop to match or beat it" - handing the shop an
  // argument for its own price.
  const quoteNow = ctx.inbound.verified.pricePerDay ?? ctx.thread.digest.quotedPricePerDay;
  const cheaperRival =
    typeof quoteNow === "number"
      ? s.rivals.find((r) => r.pricePerDay < quoteNow) ?? null
      : s.rivals[0] ?? null;
  const rivalLeverage =
    cheaperRival && ctx.legalMoves.includes("bargain")
      ? `HARD LEVERAGE: another real shop THIS SEARCH quoted ${cheaperRival.pricePerDay} ${cheaperRival.currency}/day (${cheaperRival.shop}). If you bargain, you MUST name this ${cheaperRival.pricePerDay}/day and ask this shop to match or beat it - do not omit or soften it.\n`
      : "";

  const user =
    `VEHICLE WANTED: ${vehicleLine(ctx)} for ${s.rfq.durationDays} days.\n` +
    `${bench}\n${prior}\n` +
    `RIVAL OFFERS (other shops, this search):\n${rivalLines}\n\n` +
    menuBlock +
    roundPlay +
    firmNote +
    questionNote +
    vehiclePlay +
    optionPlay +
    locationBlock +
    durationLeverage +
    rivalLeverage +
    repetitionNote +
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
    case "confirm-vehicle":
      // The gate already phrased the question from the traveller's own declared
      // spec; the fallback simply sends it. Never invents a price.
      return (
        ctx.inbound.verified.vehicleQuestion ||
        `Quick check - is that for the exact ${
          ctx.session.rfq.engineSizeCc ? `${ctx.session.rfq.engineSizeCc}cc ` : ""
        }${ctx.session.rfq.vehicleClass} I asked about? Want to be sure before we go further 🙂`
      );
    case "option-probe": {
      // Names the tiers we already read, so even the LLM-down path proves we
      // were listening and asks the ONE thing still missing.
      const opts = ctx.thread.digest.options ?? [];
      const gap = nextGap(opts);
      const list = opts
        .slice(0, 3)
        .map((o) => `${o.pricePerDay}`)
        .join(" and ");
      const ask =
        gap === "photo"
          ? "could you send a quick photo of each"
          : gap === "mileage"
            ? "how old are they and roughly how many km"
            : gap === "deposit"
              ? "what's the deposit for each"
              : "which one is the newer one";
      return list
        ? `Thanks! You mentioned ${list} - ${ask}? Want to make sure I pick the right one 🙂`
        : `Thanks! Which options do you have, and what's the difference between them?`;
    }
    case "clarify":
      // NEVER ask a shop to retype a board we can read. If a photo came in, say
      // what we got from it and ask a yes/no - that answer is what verifies the
      // read. Asking "send it as text" after four price boards is what made the
      // app look like it had not looked at them at all.
      if (v.hadImage) {
        return v.pricePerDay
          ? `Thanks for the price list! I read ${v.pricePerDay}${v.currency ? " " + v.currency : ""}/day for the ${days} days - is that right for me? 🙂`
          : `Thanks for the price list! Which line is the one for me, for ${days} days? 🙂`;
      }
      return `Could you share your best price per day for the ${days} days? 🙂`;
    case "pickup-location": {
      // The address comes from the disclosure gate, never from the shop's
      // message or the model. No verified stay = not a legal move at all
      // (policy.ts), so reaching here means we have one.
      const where = ctx.share?.addressText;
      if (!where) return undefined;
      const pin = ctx.share?.mapsLink ? ` (${ctx.share.mapsLink})` : "";
      return `I'm staying at ${where}${pin} - can you deliver there, and when would suit you?`;
    }
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
      // Non-commitment guardrail (issue 5): learn the terms while making clear
      // we are still comparing shops - never imply a guaranteed booking.
      return `Thanks! We're finalizing our pick between a few shops today - could you let me know your deposit? Cash amount or passport?`;
    case "fulfillment-probe":
      return `One more thing while we compare options - do you deliver to the hotel, or is it pickup at your shop?`;
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
  const recent = (ctx.thread.digest.lastOutbound ?? []).filter(Boolean);

  for (let attempt = 0; attempt < 2; attempt++) {
    // On the retry, add a hard anti-repetition nudge (the keyless backstop for
    // the Redis signature guard that is dark on Cloud Run).
    const userMsg =
      attempt === 0
        ? user
        : `${user}\n\nYour previous draft repeated an earlier message almost word for word. Rewrite it from scratch with a DIFFERENT sentence structure and a DIFFERENT lever.`;
    const raw = await chat(
      [
        { role: "system", content: system },
        { role: "user", content: userMsg },
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
        // NEVER trust a raw wait either: an unclamped waitMinutes once parked a
        // live thread until 08:28 the next morning. See spte/wait.ts.
        waitMinutes: clampWaitMinutes(parsed.waitMinutes),
      };
      // NEVER trust an out-of-set move (the B7 lesson, generalized).
      artifact.move = coerceToLegal(artifact, ctx.legalMoves);
      // Anti-repetition: a near-duplicate of a recent send is rejected ONCE (so
      // the retry above fires); on the second pass we accept it rather than go
      // silent - a slightly repetitive reply still beats no reply.
      if (
        attempt === 0 &&
        artifact.message &&
        recent.length > 0 &&
        isRepetitive(artifact.message, recent)
      ) {
        continue;
      }
      return { artifact, route };
    }
    // malformed JSON -> retry once, then fall through.
  }
  return { artifact: fallbackArtifact(ctx), route: { tier: "R", reason: "quota-overflow" } };
}
