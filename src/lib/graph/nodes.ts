// Node handlers - the specialized agents behind every act node in the digraph.
// Thin, composable wrappers over the existing agent library (agents.ts,
// orchestrator.ts): each returns a NodeResult with the draft, its reasoning
// and any state mutations. Every handler has a deterministic no-LLM fallback.

import "server-only";
import { composeBargain, currencyForRegion, money } from "../agents";
import { chat } from "../ai";
import { computeRoundTarget } from "./math";
import { ownerDirectives, registerRules, type OrchestratorConfig } from "../orchestrator";
import type { StructuredRFQ, Vendor } from "../types";
import type {
  FulfillmentKind,
  GraphSpec,
  GraphTurnInput,
  NegotiationThreadState,
  NodeResult,
  NodeSpec,
} from "./types";

// Same question detector the legacy loop + simulator use (kept local to avoid
// a circular import with agent-loop).
export function shopAskedQuestion(text: string): boolean {
  return (
    /\?/.test(text) ||
    /\b(you mean|do you mean|which (one|type|kind|model)|what (kind|type|size|model|dates?|day|time)|motor ?bike or car|car or (motor ?)?bike|scooter or (motor ?)?bike|how (many|long|much time)|when (do|will|are) you|where (are|do) you|pick ?up or delivery)\b/i.test(
      text
    )
  );
}

/** Deterministic spec restatement when the LLM is unavailable. */
export function fallbackAnswer(rfq: StructuredRFQ): string {
  const days = `${rfq.durationDays} day${rfq.durationDays === 1 ? "" : "s"}`;
  if (rfq.vehicleClass === "car") {
    const parts = [
      rfq.carType && rfq.carType !== "any" ? rfq.carType : "",
      rfq.transmission !== "any" ? rfq.transmission : "",
      "car",
      rfq.seats ? `${rfq.seats} seats` : "",
    ].filter(Boolean);
    return `A ${parts.join(" ")}, for ${days}. What would the daily price be?`;
  }
  const cc = rfq.engineSizeCc ? `${rfq.engineSizeCc}cc ` : "";
  const kind = rfq.vehicleClass === "scooter" ? "automatic scooter" : "manual motorbike";
  return `The ${cc}${kind} (not a car), for ${days}. What would the daily price be?`;
}

// Gracious one-time closers (varied further by the anti-ban content variator).
// CRITICAL: never imply a deal is accepted - only the traveller closes deals.
const CLOSE_OK = [
  "Thanks so much for the info! Let me think it over and I'll message you again. 🙏",
  "Really appreciate it, thank you! I'll check my plans and get back to you. 🙂",
  "Perfect, thank you! Give me a little time to decide and I'll write you. 🤙",
];
const CLOSE_NO = [
  "No worries at all, thanks for letting me know! I'll think it over and get back to you. 🙂",
  "All good, I understand! Thanks for your time - I'll be in touch. 🙏",
  "Okay no problem! Thanks anyway, I'll see and message you. 🤝",
];

// Probe message pools - the deterministic fallbacks. The LLM path rephrases
// with full context so no two shops ever receive the same sentence.
const DEPOSIT_PROBES = [
  "Okay sounds good! What deposit do you need for it? 🙂",
  "And what do you take as deposit?",
  "What about deposit - how much or what you need? 🙏",
  "Nice. For deposit, what do you need from me?",
];
const DEPOSIT_AND_FULFILLMENT_PROBES = [
  "Okay! What deposit you need? And can you deliver to my hotel or I come to the shop? 🙂",
  "Sounds good - what about deposit? And do you deliver or I pick up at shop? 🙏",
  "Great. What deposit do you need, and how do I get it - delivery or I come to you?",
];
const CASH_PUSH_PROBES = [
  "I cannot leave my passport, I really need it with me. Can I leave cash deposit instead? 😊",
  "Passport is hard for me, I need it for hotel and travel. Cash deposit okay instead? 🙏",
  "Is cash deposit possible instead of passport? I can leave cash, no problem. 🙂",
];
const FULFILLMENT_PROBES = [
  "Can you deliver it to my hotel? Or better I come to the shop? 🙂",
  "Do you deliver to hotel, or do I come pick it up? 🙏",
  "How do I get it - you deliver, or I come to you?",
];

const PICKUP_SHARE_LINES = [
  "Great, here is my location: {link} - what time can you come? 🙂",
  "Perfect! I'm here: {link} - let me know when you can pick me up 🙏",
  "Here is where I am: {link} - message me when you're close! 🙂",
];

const CLOSING_LINES = [
  "Great news - I want to take it! {details} I'll continue with you here on WhatsApp. 🙂",
  "Okay deal! {details} Let's arrange the rest here on WhatsApp. 🙏",
  "Perfect, let's do it! {details} I'll message you here to arrange. 🤝",
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export interface ComposeArgs {
  node: NodeSpec;
  edgeLabel: string;
  input: GraphTurnInput;
  state: NegotiationThreadState;
  spec: GraphSpec;
  cfg: OrchestratorConfig;
  target?: number;
  rivalPrice?: number;
  leverageNote?: string;
  llmBudget: () => boolean; // false = out of LLM calls, use fallbacks
}

/**
 * One short, contextual rephrase pass so hundreds of users never send the
 * same probe twice. Falls back to the template when the LLM is out of reach.
 */
async function vary(
  base: string,
  args: ComposeArgs,
  what: string
): Promise<{ text: string; fromAi: boolean }> {
  if (!args.llmBudget()) return { text: base, fromAi: false };
  const register = registerRules(args.cfg, args.input.currency, args.input.ctx.region);
  const out = await chat([
    {
      role: "system",
      content:
        "You are the traveller in a WhatsApp chat with a vehicle rental shop, mid-conversation. " +
        `Write ONE short casual message that ${what}. ` +
        "Max 25 words, friendly, exactly one emoji, never greet again, never accept a deal, " +
        "never repeat earlier messages word-for-word. " +
        (register ? register + " " : "") +
        (args.node.instructions ? `Owner guidance: ${args.node.instructions} ` : "") +
        ownerDirectives(args.cfg, "reply") +
        " Reply with the message text only.",
    },
    {
      role: "user",
      content: `Conversation so far:\n${args.input.history}\n\nBase message to rephrase naturally: ${base}`,
    },
  ]);
  const text = (out ?? "").trim().slice(0, 300);
  return text ? { text, fromAi: true } : { text: base, fromAi: false };
}

// ---------------------------------------------------------------------------
// Handlers per act-node kind
// ---------------------------------------------------------------------------

export async function composeForNode(args: ComposeArgs): Promise<NodeResult> {
  const { node, input, state } = args;
  const f = state.fields;
  const text = input.event.shopMessage;
  const extraction = input.extraction;

  switch (node.kind) {
    case "silent":
      return { reasoning: args.edgeLabel || "deliberate silence", terminal: true };

    case "present": {
      return {
        reasoning: `price ${f.pricePerDay} ${f.currency ?? ""}/day + deposit + ${f.fulfillment} known - deal is presentable`,
        fieldsPatch: { presented: true },
        kind: "present",
      };
    }

    case "answer": {
      const vehiclePhoto =
        extraction?.imageKind === "vehicle" && !shopAskedQuestion(text);
      const spec = fallbackAnswer(input.rfq);
      if (!args.llmBudget()) {
        return {
          message: vehiclePhoto
            ? "Thanks for the photo, looks great! What is your best daily price for it? 🙂"
            : spec,
          kind: "auto-answer",
          reasoning: "deterministic answer (no LLM budget)",
          verdict: "deterministic",
        };
      }
      const register = registerRules(args.cfg, input.currency, input.ctx.region);
      const sys = vehiclePhoto
        ? "You are the traveller in a WhatsApp chat with a vehicle rental shop. " +
          "The shop just sent a PHOTO of the actual vehicle (not a price list). " +
          "Reply in ONE short, warm, casual sentence (max 25 words): thank them for the photo " +
          "and, only if we do not already have a price for our exact vehicle, gently ask their " +
          "best daily price. You are MID-CONVERSATION: never greet again. NEVER accept a deal - " +
          "only the traveller decides. Include exactly one emoji. " +
          (register ? register + " " : "") +
          (node.instructions ? `Owner guidance: ${node.instructions} ` : "") +
          ownerDirectives(args.cfg, "reply") +
          " Reply with the message text only."
        : "You are the traveller in a WhatsApp chat with a vehicle rental shop. " +
          "The shop just asked a question. Answer ONLY that question in ONE short, casual, " +
          `friendly sentence (max 25 words), strictly using these facts - never invent anything: ${spec} ` +
          "You are MID-CONVERSATION: never greet again. Do not re-ask for the price if the shop " +
          "already gave one for our exact vehicle. HARD RULE: NEVER accept a deal, never confirm " +
          "a booking, never say a price 'works' - only the traveller decides. If the shop asks " +
          "whether we take their offer, say you will think it over. Include exactly one emoji. " +
          (register ? register + " " : "") +
          (node.instructions ? `Owner guidance: ${node.instructions} ` : "") +
          ownerDirectives(args.cfg, "reply") +
          " Reply with the message text only.",
        user = vehiclePhoto
          ? `Conversation so far:\n${input.history}\n\nThe shop sent a photo of the vehicle.`
          : `Conversation so far:\n${input.history}\n\nShop's question: ${text}`;
      const llm = await chat([
        { role: "system", content: sys },
        { role: "user", content: user },
      ]);
      return {
        message:
          (llm ?? "").trim().slice(0, 300) ||
          (vehiclePhoto
            ? "Thanks for the photo, looks great! What is your best daily price for it? 🙂"
            : spec),
        kind: "auto-answer",
        reasoning: vehiclePhoto ? "thanking for the vehicle photo" : "answering the shop's question",
      };
    }

    case "clarify": {
      // Media-confirm variant: the coherence validator flagged the reading.
      if (input.transcript && args.edgeLabel.includes("media")) {
        const base = `Sorry, just to be sure I understood your voice message - ${extraction?.clarifyMessage ?? "could you type the price and details?"} 🙏`;
        return {
          message: base.slice(0, 300),
          kind: "auto-clarify",
          reasoning: "confirming an uncertain media interpretation in text",
        };
      }
      const msg = extraction?.clarifyMessage;
      if (!msg) return { reasoning: "no clarify question available - staying quiet", terminal: true };
      return { message: msg, kind: "auto-clarify", reasoning: args.edgeLabel };
    }

    case "close": {
      const saidYes =
        (f.pricePerDay ?? 0) > 0 ||
        /\b(ok|okay|yes|sure|deal|can do|no problem)\b/i.test(text);
      const variants = saidYes ? CLOSE_OK : CLOSE_NO;
      return {
        message: pick(variants),
        kind: "auto-close",
        reasoning: saidYes ? "warm close - shop cooperative" : "polite close - shop declined",
        nextRound: (input.ctx.round ?? 0) + 1,
      };
    }

    case "bargain": {
      if (!f.pricePerDay || !args.target) {
        return { reasoning: "no usable price/target - bargain skipped", terminal: true };
      }
      const rounds = f.rounds ?? 0;
      const roundDirective =
        rounds === 0
          ? ""
          : rounds === 1
          ? "This is our SECOND ask in this chat: they already moved once, so be softer, " +
            "acknowledge their effort, and ask for a smaller step down. "
          : "This is our FINAL ask: tiny nudge only, make it effortless to say yes, " +
            "and make clear we are ready to decide. ";
      const draft = await composeBargain({
        rfq: input.rfq,
        vendor: { name: input.ctx.vendorName ?? "the shop" } as Vendor,
        currentPricePerDay: f.pricePerDay,
        rivalPricePerDay: args.rivalPrice,
        region: input.ctx.region || undefined,
        round: rounds + 1,
        currency: input.currency,
        localLanguage: Boolean(input.ctx.localLang) && input.ctx.plan === "ultra",
        targetPricePerDay: args.target,
        floorPricePerDay: input.floorPrice,
        history: input.history,
        voiceKey: input.ctx.sender ?? undefined,
        extraDirectives: [
          registerRules(args.cfg, input.currency, input.ctx.region),
          ownerDirectives(args.cfg, "price"),
          roundDirective,
          node.instructions ? `Owner guidance: ${node.instructions}` : "",
          args.leverageNote ? `Real leverage you may mention: ${args.leverageNote}.` : "",
          "Include exactly one warm emoji.",
        ]
          .filter(Boolean)
          .join("\n"),
      });
      return {
        message: draft.message,
        englishGloss: draft.english,
        kind: "auto-bargain",
        tacticId: draft.tacticId,
        reasoning: `round ${rounds + 1} ask at ${args.target} ${input.currency} (${draft.tacticLabel})`,
        fieldsPatch: { rounds: rounds + 1, lastTarget: args.target, lastLeverage: args.leverageNote },
        nextRound: rounds + 1,
      };
    }

    case "deposit-probe": {
      const passportOnly = f.depositType === "passport" && !f.cashAlternativeAsked;
      const needFulfillment = !f.fulfillment;
      let base: string;
      let patch: NodeResult["fieldsPatch"];
      let what: string;
      if (passportOnly) {
        base = pick(CASH_PUSH_PROBES);
        patch = { cashAlternativeAsked: true };
        what = "politely explains we cannot leave a passport and asks if a cash deposit works instead";
      } else if (needFulfillment) {
        base = pick(DEPOSIT_AND_FULFILLMENT_PROBES);
        what = "asks what deposit they need AND whether they deliver to the hotel or we come to the shop";
      } else {
        base = pick(DEPOSIT_PROBES);
        what = "asks what deposit the shop needs";
      }
      const v = await vary(base, args, what);
      return {
        message: v.text,
        kind: "auto-deposit-probe",
        reasoning: passportOnly
          ? "passport-only deposit - pushing once for a cash alternative"
          : "learning the deposit before the deal is shown",
        verdict: v.fromAi ? undefined : "deterministic",
        fieldsPatch: patch,
      };
    }

    case "fulfillment-probe": {
      const v = await vary(
        pick(FULFILLMENT_PROBES),
        args,
        "asks how the traveller gets the vehicle - hotel delivery, shop pickup service, or coming to the shop"
      );
      return {
        message: v.text,
        kind: "auto-fulfillment-probe",
        reasoning: "learning delivery / pickup / on-shop before the deal is shown",
        verdict: v.fromAi ? undefined : "deterministic",
      };
    }

    case "pickup-location": {
      const p = input.event.payload ?? {};
      const lat = Number(p.lat);
      const lng = Number(p.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return { reasoning: "no coordinates in the consent payload - nothing to share", terminal: true };
      }
      const link = `https://maps.google.com/?q=${lat.toFixed(6)},${lng.toFixed(6)}`;
      const base = pick(PICKUP_SHARE_LINES).replace("{link}", link);
      const v = await vary(base, args, `shares the traveller's location link (${link}) for the shop's pickup service and asks when they can come - KEEP THE LINK EXACTLY AS IS`);
      const finalText = v.text.includes(link) ? v.text : base; // the link must survive
      return {
        message: finalText,
        kind: "auto-pickup-location",
        reasoning: "traveller approved sharing their exact location for pickup",
        fieldsPatch: { pickupConsent: true, fulfillment: "pickup" as FulfillmentKind },
      };
    }

    case "closing-message": {
      const p = input.event.payload ?? {};
      const price = Number(p.pricePerDay) || f.pricePerDay;
      const cur = String(p.currency ?? f.currency ?? currencyForRegion(input.ctx.region) ?? "");
      const when = typeof p.when === "string" ? p.when : "";
      const fulfillment = (p.fulfillment as string) || f.fulfillment || "";
      const arrange =
        fulfillment === "delivery"
          ? typeof p.address === "string" && p.address
            ? `Could you deliver it to ${p.address}${when ? ` around ${when}` : ""}?`
            : `Could you deliver it to my hotel${when ? ` around ${when}` : ""}?`
          : fulfillment === "pickup"
          ? `You said you can pick me up - ${when ? `does ${when} work?` : "when works for you?"}`
          : `I'll come by the shop${when ? ` around ${when}` : ""}.`;
      const details = [
        price ? `${money(price, cur)}/day as we agreed.` : "",
        arrange,
      ]
        .filter(Boolean)
        .join(" ");
      return {
        message: pick(CLOSING_LINES).replace("{details}", details).slice(0, 400),
        kind: "deal-close",
        reasoning: "the traveller locked this deal - telling the shop and handing the chat back",
      };
    }

    case "custom-llm": {
      if (!args.llmBudget()) {
        return { reasoning: "custom node skipped (no LLM budget)", terminal: true };
      }
      const template = node.promptTemplate?.trim();
      if (!template) return { reasoning: "custom node has no prompt template", terminal: true };
      const numbers = [
        f.pricePerDay ? `quoted ${f.pricePerDay} ${f.currency ?? ""}/day` : "no price yet",
        args.target ? `target ${args.target}` : "",
        args.rivalPrice ? `best rival ${args.rivalPrice}` : "",
        input.floorPrice ? `market floor ${input.floorPrice}` : "",
      ]
        .filter(Boolean)
        .join(", ");
      const prompt = template
        .replaceAll("{history}", input.history)
        .replaceAll("{shopMessage}", text)
        .replaceAll("{state}", JSON.stringify(f))
        .replaceAll("{rfq}", JSON.stringify(input.rfq))
        .replaceAll("{numbers}", numbers);
      const out = await chat([
        {
          role: "system",
          content:
            "You are a custom agent inside a WhatsApp rental negotiation. Follow the owner's " +
            "template exactly. Never accept a deal (only the traveller decides), never greet " +
            "mid-conversation, max 40 words, include one emoji. Reply with the message text only.",
        },
        { role: "user", content: prompt },
      ]);
      const msg = (out ?? "").trim().slice(0, 400);
      if (!msg) return { reasoning: "custom node produced nothing", terminal: true };
      return { message: msg, kind: `auto-${node.id}`, reasoning: `custom node "${node.label}"` };
    }

    default:
      return { reasoning: `no handler for node kind ${node.kind}`, terminal: true };
  }
}

// Re-exported for the engine (the pure math lives in ./math so tests + the
// client Studio preview can import it without the server-only guard).
export { computeRoundTarget } from "./math";
