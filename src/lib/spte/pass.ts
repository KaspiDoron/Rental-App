// SPTE single pass - the turn's ONE LLM call. A snapshot-grounded, tool-free
// structured generation: the worker pre-fetches the whole context (blackboard +
// thread digest + verified extraction), injects it, and the model runs exactly
// once returning a TurnArtifact JSON. No ReAct tool loop, no multi-agent debate.
//
// Zero-cost: routed through the existing multi-provider failover (Groq ->
// Gemini Flash -> Cerebras -> OpenRouter). On malformed JSON: one retry, then a
// deterministic fallback artifact (never throws, never silent).

import { chat, chatDetailed, extractJson } from "../ai";
import type { MoveKind, ModelRoute, TurnArtifact, TurnContext } from "./types";
import { coerceToLegal, passportCounterDue, atSessionLow } from "./policy";
import { moveGlossary, normalizeMove } from "./moves";
import { composePassportCounter } from "../negotiation/deposit-counter";
import { isRepetitive } from "../wa/similarity";
import { clampWaitMinutes } from "./wait";
import { nextGap } from "../offer-options";
import { planLeverage, leadCard } from "../negotiation/leverage";
import { disclosureBlock } from "../negotiation/traveller-disclosure";
import { describeActs } from "../wa/dialogue-acts";

/** Pick the model tier. Multimodal/high-stakes -> Tier M (Gemini Flash);
 *  everything else -> Tier F (the standard failover chain). Reflex (Tier R) is
 *  decided BEFORE this is called and never reaches an LLM. */
export function pickRoute(ctx: TurnContext): ModelRoute {
  const highStakes =
    ctx.legalMoves.includes("farewell") ||
    ctx.legalMoves.includes("closing-message") ||
    (ctx.legalMoves.includes("bargain") && (ctx.thread.digest.round ?? 0) === 0);
  return highStakes
    ? { tier: "M", reason: "high-stakes" }
    : { tier: "F", reason: "default" };
}

function buildPrompt(ctx: TurnContext): { system: string; user: string } {
  const s = ctx.session;
  // RIVAL QUOTES WITHOUT RIVAL NAMES. The model never needs to know WHICH shop
  // quoted what - only that a real, live, cheaper quote exists in this search.
  // Handing it the names is how a name ends up in a message to a competitor;
  // not handing them over is the structural half of the disclosure rule.
  const rivalLines = s.rivals.length
    ? s.rivals.map((r) => `- another shop this search: ${r.pricePerDay} ${r.currency}/day`).join("\n")
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
    // The rail behind this refuses the draft outright, which costs a turn. Say
    // it here so the model rarely reaches it.
    "- NEVER commit on the traveller's behalf. You may ask anything and accept a price as GOOD, " +
    "but you may not say we'll take it, book it, reserve it, hold it, that you accept/agree/confirm, " +
    "or that you are on your way. The traveller books it themselves, later, in the app.\n" +
    "- If the shop has said its price is final/last more than once, DO NOT ask for a lower price again - accept warmly or move to logistics.\n" +
    "- LICENSE POLICY: if the shop asks whether you have a (international) driving license, answer firmly: " +
    "you have a valid international driving license for this vehicle category. If the shop asks to SEE or get a " +
    "photo/copy of the license, politely defer: you will share it once the rate and rental details are agreed - " +
    "never refuse outright, never send documents, and steer back to the price.\n" +
    "- Keep the message to 1-2 short sentences in simple, everyday English.\n" +
    // THE WORD THAT COST A REAL BOOKING.
    //
    // "Is that one of the bikes you have free?" meant vacant. The shop - which
    // had quoted 180 baht a minute earlier - read it as asking for a bike at no
    // charge and told us to try somewhere else. A regex rail catches the shapes
    // we have seen; only the model can avoid the ones we have not, so it is
    // taught the distinction rather than merely corrected afterwards.
    "- NEVER use the word \"free\" to mean available/vacant/in stock. To a shop " +
    "owner reading quickly, \"free\" means AT NO COST, and asking for a free " +
    "motorbike ends the conversation. Say available, spare, or in stock. " +
    "\"Free\" is only ever correct for something genuinely included at no charge " +
    "(free delivery, free helmet).\n" +
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

  // FIRM state - the two-firms-stop rule made explicit to the model too.
  const firmNote =
    (dg.firmCount ?? 0) >= 2
      ? `The shop has said this is their LAST/BEST price ${dg.firmCount} times. STOP asking for a lower price - do not haggle again. Instead move on to logistics (deposit, delivery/pickup) or accept warmly.\n`
      : (dg.firmCount ?? 0) === 1
        ? `The shop called this their best price once. Only push again if you have real leverage (a cheaper rival or a price well above market); otherwise switch to logistics.\n`
        : "";

  // QUESTION obligation - answer what the shop asked, first.
  //
  // Now says WHAT was asked. Told only "the shop asked you something" on the
  // strength of a question mark, the model opened with filler praise ("Good
  // question!") for turns that contained no question at all.
  const acts = ctx.inbound.verified.acts;
  const askedSomething =
    (acts ? acts.ask !== "none" : ctx.inbound.verified.askedQuestion) ||
    ctx.inbound.verified.askedLocation;
  const questionNote = askedSomething
    ? `The shop ASKED YOU about ${acts && acts.ask !== "none" ? acts.ask.replace(/-/g, " ") : "something"} in their last message. Your reply MUST answer that first, in a natural way, before anything else.\n`
    : `The shop did NOT ask you anything. Do not thank them for a question and do not open with filler - acknowledge what they actually sent, then make your move.\n`;

  // ONE-SHOT PASSPORT-DEPOSIT COUNTER: when the shop's stated terms demand the
  // original passport with no cash route (and we have never asked), the legal
  // deposit-probe IS the polite alternative ask - coach the composed message
  // to match the deterministic template's strategy.
  const depositCounterNote = passportCounterDue(ctx)
    ? "DEPOSIT TERMS: the shop requires leaving the ORIGINAL passport, with no cash option offered. If you pick deposit-probe, make ONE ultra-polite counter: say we'd prefer a cash deposit plus a PHOTO of the passport, framed as a preference (never a refusal, never a safety lecture). If they decline, we accept their terms graciously - this is asked once and never again.\n"
    : "";

  // ANTI-REPETITION - the real fix for "same sentence every turn". The model
  // never saw its own prior sends; now it does, with a hard rule.
  const priorSends = (dg.lastOutbound ?? []).filter(Boolean);
  const repetitionNote = priorSends.length
    ? `YOUR PREVIOUS MESSAGES in this chat (NEVER reuse their sentence structure or a lever you already played - a repeated line reads as a bot):\n${priorSends
        .map((m) => `  • ${m}`)
        .join("\n")}\n`
    : "";

  // THE LEDGER, in the model's own words. The legal move set already makes a
  // repeated fact-question impossible (spte/policy), but a move that IS legal
  // can still carry a redundant question inside its text - "and what's the
  // deposit?" tacked onto a bargain the shop already answered. Stating what is
  // established and what is still outstanding removes the reason to ask.
  // WHAT WE MAY SAY ABOUT THE TRAVELLER. Empty on an ordinary price turn; it
  // appears only when the shop asked something personal, which is exactly when
  // an agent writing in someone else's voice is most likely to invent a fact.
  const aboutYouBlock = (() => {
    // The town is the only place fact we may state, and only when the
    // traveller has already consented to sharing it.
    const b = disclosureBlock({ rfq: s.rfq, town: ctx.share?.addressText }, ctx.inbound.text || "");
    return b ? `${b}\n\n` : "";
  })();

  const ledger = dg.ledger;
  const ledgerBlock = ledger
    ? [
        ledger.known.length
          ? `ALREADY ESTABLISHED by this shop (never ask again): ${ledger.known.join(", ")}.`
          : "",
        ledger.outstanding.length
          ? `ALREADY ASKED and still unanswered (do NOT repeat the question): ${ledger.outstanding.join(", ")}.`
          : "",
        ledger.owed.length
          ? `STILL OWED to the traveller before this thread can close: ${ledger.owed.join(", ")}.`
          : "",
      ]
        .filter(Boolean)
        .join("\n") + "\n"
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

  // THE LEVERAGE PLAN, RANKED BY EVIDENCE (lib/negotiation/leverage).
  //
  // The round directive above still shapes the ANGLE, but it no longer decides
  // WHICH card to play. It used to: "use the N-day rental as your reason" was
  // hard-coded onto the first push, so the strongest card in the negotiation -
  // another real shop in this same search quoting less for the same vehicle -
  // was played late or never, because many threads never got a later push.
  // Duration is the weakest lever we have; a live competing quote is the
  // strongest. Now the engine computes the order from the evidence and the model
  // leads with whatever actually is strongest.
  //
  // AND IT CARRIES NO SHOP NAME. The line this replaces interpolated
  // `${cheaperRival.shop}` and ordered the model to name it, which sent the
  // cheaper shop's identity to its direct competitor from the traveller's own
  // number. The price and the vehicle are the leverage; the name is not ours to
  // give away. spte/rails enforces it on the finished draft as well.
  const quoteNow = ctx.inbound.verified.pricePerDay ?? ctx.thread.digest.quotedPricePerDay;
  const plan = ctx.legalMoves.includes("bargain")
    ? planLeverage({
        rivals: s.rivals,
        quotePerDay: quoteNow,
        currency: s.currency,
        durationDays: days,
        round,
        vehicleLabel: vehicleLine(ctx),
        // The same fact the policy uses to retire `bargain`, read from the
        // same place. Two modules disagreeing about who the cheapest shop is
        // would be worse than either answer.
        isSessionLow: atSessionLow(ctx),
      })
    : [];
  const lead = leadCard(plan);
  // WE WERE HANDING BACK THE CARD leverage.ts HAD JUST TAKEN AWAY.
  //
  // planLeverage returns an EMPTY list when this shop is the session's cheapest
  // and no round has been played, and says why at length: being the floor is
  // "a position with no argument in it", so returning nothing "lets the caller
  // do the right thing (terms, not price) instead of the least-wrong thing".
  //
  // Both fallbacks below key on `!lead` - which is PRECISELY the state that
  // suppression creates. So the prompt turned around and told the model to
  // "give the N-day rental as your reason" and that "Duration is your lever
  // this first push": the exact message leverage.ts exists to prevent, argued
  // against a floor we set ourselves. One nudge at the session low is still
  // legal by design; what it must not be is a price argument.
  const atLow = atSessionLow(ctx);
  const rivalLeverage = lead
    ? `LEVERAGE, STRONGEST FIRST - lead with the first one:\n` +
      plan.map((c, i) => `  ${i + 1}. ${c.line}`).join("\n") +
      `\nNEVER write the name of another rental shop in a message. Not the one that quoted less, not any other - say "a better offer" and give the price and the vehicle.\n`
    : "";
  // THE ANGLE IS A SHAPE; THE REASON COMES FROM THE EVIDENCE.
  //
  // This used to hard-code "use the {days}-day rental as your reason" on the
  // first push - the duration lever, always, no matter what the session knew.
  // So when a rival shop had already quoted less for the same vehicle, the
  // ranked plan put that card first and the prompt simultaneously instructed
  // the model to argue from duration instead. The strongest card in the deck
  // was computed, printed, and then talked over. Now the angle describes only
  // the SHAPE of the push and defers the reason to `lead` whenever one exists,
  // which is exactly what leverage.ts was built to decide.
  const roundPlay = ctx.legalMoves.includes("bargain")
    ? round <= 0
      ? atLow
        ? `BARGAIN ANGLE (first push, and they are ALREADY the best price you have): do NOT argue the number - you have nothing to argue with, and saying it is high against your own floor reads as haggling for its own sake. Warmly ask for something thrown in instead - a helmet, fuel, or free delivery - or a small round-number gesture if they would rather. Vary the exact wording.\n`
        : `BARGAIN ANGLE (first push): warmly say the quote is a bit high for you, give ${lead ? "the leverage above as your reason" : `the ${days}-day rental as your reason`}, and ask for a friendly better daily rate. Vary the exact wording.\n`
      : round === 1
        ? `BARGAIN ANGLE (second push): DO NOT reuse the reason you already gave - switch lever. ${lead ? "Use the next card in the leverage list." : "Ask for a small round-number discount, or a free extra (helmet/fuel/delivery), or mention you're ready to book right now."}\n`
        : `BARGAIN ANGLE (final gentle nudge): one last soft ask, then you will accept. Use a DIFFERENT phrasing and lever from your earlier messages.\n`
    : "";

  // Kept as its own line only when there is nothing stronger to lead with.
  const durationLeverage =
    !lead && !atLow && round <= 0 && days >= 3 && ctx.legalMoves.includes("bargain")
      ? `Duration is your lever this first push: ${days} days is a long rental.\n`
      : "";

  const user =
    `VEHICLE WANTED: ${vehicleLine(ctx)} for ${s.rfq.durationDays} days.\n` +
    `${bench}\n${prior}\n` +
    `RIVAL OFFERS (other shops, this search):\n${rivalLines}\n\n` +
    menuBlock +
    roundPlay +
    firmNote +
    depositCounterNote +
    questionNote +
    vehiclePlay +
    optionPlay +
    locationBlock +
    durationLeverage +
    rivalLeverage +
    repetitionNote +
    ledgerBlock +
    aboutYouBlock +
    `THIS SHOP so far:\n${digest}\n\n` +
    `RECENT MESSAGES:\n${tail || "(none yet)"}\n\n` +
    `SHOP JUST SAID: ${ctx.inbound.text || "(nothing - a scheduled follow-up)"}\n` +
    // WHAT THEY SENT, not only what they typed. `imageSummary` has always been
    // computed and never reached the model, so a shop that answered with four
    // price boards looked to the LLM like a shop that said nothing.
    (ctx.inbound.verified.acts
      ? `SHOP'S TURN: ${describeActs(ctx.inbound.verified.acts)}\n`
      : "") +
    (ctx.inbound.verified.imageSummary
      ? `FROM THEIR PHOTO we read: ${ctx.inbound.verified.imageSummary}\n`
      : "") +
    // OUR READER FAILED, THEIR PHOTO IS FINE. Without this the model has an
    // image it was never shown and no way to know it, so it composes as though
    // it had looked - "which line is mine?" at a board nobody read.
    (ctx.inbound.verified.imageUnread
      ? "THEIR PHOTO COULD NOT BE OPENED on our side - we have NOT seen it. Never " +
        "imply you read it, never describe it, never ask which line is yours. " +
        "Thank them and ask for the number in plain text.\n"
      : "") +
    (ctx.inbound.verified.found && ctx.inbound.verified.pricePerDay
      ? `VERIFIED: the shop's live quote is ${ctx.inbound.verified.pricePerDay} ${ctx.inbound.verified.currency ?? s.currency}/day.\n`
      : "") +
    (ctx.guards.floorPerDay ? `Do not ask below ${ctx.guards.floorPerDay}/day.\n` : "") +
    // WITH THEIR MEANINGS. A bare token list left the model to infer what each
    // word meant, and on Ko Tao it inferred that `close` meant close the deal.
    // A closed vocabulary is closed for the code, not for the reader.
    `LEGAL MOVES (pick exactly one):\n${moveGlossary(ctx.legalMoves)}\n` +
    `Choose the best move and write the message.`;

  return { system, user };
}

/** "a", "a and b", "a, b and c" - so an acknowledgment reads like a person. */
function listOf(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
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
      // ...UNLESS WE NEVER OPENED IT. "Which line is the one for me?" claims a
      // read that did not happen, and the shop cannot act on it. This is the one
      // case where asking for text IS the honest move.
      if (v.hadImage && v.imageUnread) {
        return `Thanks for sending that! It didn't open properly on my phone - could you type the price per day for ${days} days? 🙂`;
      }
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
    case "farewell":
      return `All good, thank you so much for your time!`;
    case "answer":
      // NEVER-SILENT (the live "agent never replied to my question" failure):
      // license asks get the exact policy lines; any other question gets an
      // honest, safe redirect to the one thing we always want - the daily rate.
      if (v.askedLicensePhoto)
        return `Sure - I'll share a photo of my license once we finalize the rate and rental details 👍 What's your best price per day?`;
      if (v.askedLicense)
        return `Yes, I have a valid international driving license for this. What would your best price per day be?`;
      // ACKNOWLEDGE WHAT THEY ACTUALLY DID.
      //
      // This branch used to open "Good question!" unconditionally and then ask
      // for a price - so a shop that had just sent its price board, its hours
      // and its deposit terms got thanked for a question it never asked, and
      // asked for the number it had already given. Both halves are now
      // conditioned on the turn's acts and on what we already read.
      const shared = v.acts?.shared ?? [];
      const got: string[] = [];
      if (v.pricePerDay || v.sheetPricePerDay) got.push("the price");
      else if (shared.includes("price-board")) got.push("the price list");
      if (shared.includes("deposit")) got.push("the deposit info");
      if (shared.includes("hours")) got.push("your hours");
      const thanks = got.length ? `Thanks - got ${listOf(got)}.` : "";
      // Never re-ask for a price we can already see.
      const known = v.pricePerDay ?? v.sheetPricePerDay;
      if (known) {
        return `${thanks} Just to confirm - is ${known}${v.currency ? " " + v.currency : ""}/day the best you can do for ${days} days? 🙂`.trim();
      }
      return `${thanks} What would your best price per day be for ${days} days?`.trim();
    case "deposit-probe":
      // THE ONE-SHOT PASSPORT COUNTER: when the shop's stated terms demand the
      // original passport with no cash route, this probe IS the polite
      // alternative ask (seeded wording, one attempt ever - see
      // negotiation/deposit-counter). Otherwise it is the ordinary terms probe.
      if (passportCounterDue(ctx)) return composePassportCounter(ctx.thread.threadKey);
      // Non-commitment guardrail (issue 5): learn the terms while making clear
      // we are still comparing shops - never imply a guaranteed booking.
      return `Thanks! We're finalizing our pick between a few shops today - could you let me know your deposit? Cash amount or passport?`;
    case "restock-probe": {
      // OUT OF STOCK IS NORMAL. No disappointment, no pressure, no goodbye -
      // just the one question worth asking. Seeded per thread so shops do not
      // all receive the same sentence, and stable for golden replays.
      const FAMILY = [
        `No worries at all, thanks for letting me know! Any idea when you'll have one available again?`,
        `Ah okay, thanks for telling me! When do you expect to have one back?`,
        `That's alright - thanks for the honesty! Do you know when you'll have one back in stock?`,
      ];
      let h = 5381;
      const seed = ctx.thread.threadKey;
      for (let i = 0; i < seed.length; i++) h = ((h << 5) + h + seed.charCodeAt(i)) | 0;
      return FAMILY[Math.abs(h) % FAMILY.length];
    }
    case "fulfillment-probe":
      // TWO DIFFERENT QUESTIONS WEAR THIS ONE MOVE.
      //
      // The first asks HOW the traveller gets the vehicle. The second - legal
      // only once the shop has offered to bring it and has not said what that
      // costs - asks HOW MUCH, and offers collection as the alternative in the
      // same breath, so the shop can answer with either number. A single
      // template here would have re-sent "do you deliver?" to a shop that had
      // just said it delivers, which is the repeat this move is gated against.
      return ctx.thread.digest.deliveryOffered === true &&
        ctx.thread.digest.fulfillmentCostKnown !== true
        ? `Great, thanks! Is there a charge for delivery to the hotel - and would it be cheaper if I collect it from the shop instead?`
        : `One more thing while we compare options - do you deliver to the hotel, or is it pickup at your shop?`;
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
    // chatDetailed, not chat, for ONE reason: it returns which provider
    // answered, and `chat()` was throwing that away. `route.provider` has been
    // declared since the engine shipped and assigned by nobody, so Ops showed
    // its `mock/local` fallback chip on every turn - including the ones a real
    // model composed - while the help text explained that meant no live key
    // was used. A cosmetic omission that read as a broken deployment.
    const { text: raw, provider, error } = await chatDetailed(
      [
        { role: "system", content: system },
        { role: "user", content: userMsg },
      ],
      { maxTokens: 500, budgetMs: 9000 }
    );
    if (provider) route.provider = provider;
    if (!raw) {
      // WHY THE MODEL DID NOT ANSWER, KEPT.
      //
      // chatDetailed returns the last provider's actual failure - a bad key, a
      // 429, a timeout - and this line dropped it. Downstream, "no key
      // configured" and "eight keys configured and every one of them is
      // failing" produced the identical outcome: a deterministic template and
      // provider:null on the turn. The Ops panel rendered both as its
      // mock/local chip, so a live outage was indistinguishable from a demo
      // deployment. It is one string; carry it.
      route.error = error ?? "no provider available";
      break; // fall through to the deterministic composer
    }
    const parsed = extractJson<Partial<TurnArtifact>>(raw);
    if (parsed && typeof parsed.move === "string") {
      const artifact: TurnArtifact = {
        read: parsed.read ?? { intent: "" },
        think: typeof parsed.think === "string" ? parsed.think.slice(0, 200) : "",
        // Old vocabulary in, current vocabulary out. A model coached by an
        // exemplar written before the rename still says "close"; coercing that
        // to legal[0] would throw away a choice that was actually right.
        move: normalizeMove(parsed.move) as MoveKind,
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
