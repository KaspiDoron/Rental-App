// SPTE post-rails - the DETERMINISTIC, 0-token verification every drafted
// message passes before it can be sent. This is where price integrity and the
// protocol guarantees live: the LLM proposes text, these rails dispose.
//
// Reuses the exact same guards the graph engine used (checkOutboundNumbers,
// correctDuration) so a council-composed message is held to the same standard,
// plus the never-finalize-a-time protocol rule (Step 5).

import { checkOutboundNumbers, correctDuration, verbatimNumerals } from "../graph/guardrails";
import { rivalIdentityTokens, namesRival } from "../negotiation/leverage";
import { inventsADate } from "../negotiation/traveller-disclosure";
import type { RailResult, TurnArtifact, TurnContext } from "./types";

// A drafted message must never AGREE a concrete pickup/delivery time - the
// traveller confirms that directly (Step 5 hard rule). These patterns catch an
// LLM that tried to lock a time.
const TIME_COMMIT_RX =
  /\b(see you|meet you|i'?ll be there|pick ?up at|come by at|let'?s meet|be there at)\b.*\b(\d{1,2}\s?(?:am|pm|:\d{2})|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const TIME_DEFER_LINE = " I'll confirm the exact time with you directly.";

// ONLY THE TRAVELLER MAY COMMIT, AND ONLY BY TAPPING LOCK THIS DEAL.
//
// The farewell rail below has always refused agreement language, but it only
// ran on three moves. Every other move - bargain, present, momentum, the
// deposit and pickup probes - could say "great, we'll take it" or "book it for
// me" and go straight out, from the traveller's own number, to a shop that then
// holds a vehicle for someone who has not decided. That is a promise the app
// made on a person's behalf.
//
// This list is deliberately NARROW and about ACTION, not approval. "Sounds
// good" while haggling is register, not a booking; "I'll take it" is a booking.
// The soft-approval words stay confined to the farewell rail, where a goodbye
// has no business carrying any of them.
const COMMIT_RX =
  /\b(?:i'?ll|i will|we'?ll|we will)\s+(?:take|book|reserve|have)\s+(?:it|that|the\s+\w+)\b|\b(?:it'?s a deal|we have a deal|deal!)|\bbook (?:it|that|me)\b|\b(?:please )?(?:reserve|hold|keep) (?:it|that|one) for (?:me|us)\b|\bput (?:my|our) name\b|\bi (?:accept|agree|confirm)\b|\bwe (?:accept|agree|confirm)\b|\blet'?s do it\b|\bi'?m (?:coming|on my way)\b|\bi'?ll come (?:pick|and pick|get)\b/i;

// The ONE move that is allowed to commit, because it exists only after the
// traveller tapped Lock This Deal (graph/types.ts: "the traveller locked the
// deal - tell the shop"; it is emitted by /api/negotiate/close-deal and is
// never in the legal set a normal turn chooses from).
const COMMIT_ALLOWED_MOVE = "closing-message";

/**
 * Run all post-rails on a composed artifact. Returns the final wire text, or a
 * rejection the caller turns into a deterministic fallback (never a broken send).
 */
export function runPostRails(ctx: TurnContext, artifact: TurnArtifact): RailResult {
  // Silent / no-message moves have nothing to verify.
  if (artifact.move === "silent" || !artifact.message) {
    return { ok: true, finalText: undefined };
  }

  let text = artifact.message.trim();
  if (!text) return { ok: true, finalText: undefined };

  // 0) VEHICLE IDENTITY - before any number is even looked at.
  //
  // The gate in src/lib/vehicle decides whether the price on the table belongs
  // to the vehicle the traveller declared. While it says otherwise, a bargain
  // or a close is a message about someone else's bike: it pushes for a discount
  // on a 110cc, or agrees a deal for one, in the traveller's own voice and from
  // their own number. Both live failures ended exactly there.
  //
  // This is a rail rather than a prompt instruction because a prompt is advice
  // and a rail is a guarantee. The turn is rewritten into the gate's own
  // question, which is the move the policy made legal anyway.
  const gate = ctx.inbound.verified.vehicleStatus;
  const priceMove =
    artifact.move === "bargain" ||
    artifact.move === "farewell" ||
    artifact.move === "present" ||
    artifact.move === "momentum";
  // ASK ONCE, THEN PROCEED. The rewrite below is what made the agent re-send
  // a near-identical identity question in the field: every price move was
  // force-replaced while the per-message gate stayed "needs-confirmation",
  // even after the shop had answered our question. Once the confirm question
  // has gone out (vehicleAsked - the durable thread fact), price moves run
  // with the honest "assumed" status instead; only a positively WRONG vehicle
  // still blocks them.
  const identityBlocks =
    gate === "wrong-vehicle" ||
    (gate === "needs-confirmation" && !ctx.inbound.verified.vehicleAsked);
  if (priceMove && gate && identityBlocks) {
    const question = ctx.inbound.verified.vehicleQuestion;
    if (question) {
      return {
        ok: true,
        finalText: question,
        rejected: {
          rule: "vehicle-identity",
          detail: `${artifact.move} replaced with the identity question (${gate})`,
        },
      };
    }
    return {
      ok: false,
      rejected: {
        rule: "vehicle-identity",
        detail: `cannot ${artifact.move} a price whose vehicle is ${gate}`,
      },
    };
  }

  // 0.5) DISCLOSURE: never tell a shop WHICH shop undercut it.
  //
  // Cross-shop leverage is the traveller's strongest card, and its value is the
  // price, not the name. The prompt used to interpolate the rival's shop name
  // and instruct the model "you MUST name this" - so the cheaper shop's identity
  // was sent to its direct competitor, from the traveller's own number and in
  // their own voice. Nothing inspected the draft for it.
  //
  // A rail rather than a prompt line, for the same reason as every other rail
  // here: a prompt is advice, a rail is a guarantee. The name is simply not in
  // the prompt any more either (negotiation/leverage builds the card), so this
  // is the belt behind that - including for a model that recognises a shop name
  // from the rival list it can see.
  {
    const tokens = rivalIdentityTokens(ctx.session.rivals.map((r) => r.shop));
    const leaked = tokens.length ? namesRival(text, tokens) : null;
    if (leaked) {
      return {
        ok: false,
        rejected: {
          rule: "rival-disclosure",
          detail: `draft named a rival shop ("${leaked}") - leverage is the price and the vehicle, never the name`,
        },
      };
    }
  }

  // 0.7) DISCLOSURE, the other direction: never invent a fact about the
  // TRAVELLER.
  //
  // The agent writes in their voice, from their number, and they are not in the
  // room. A shop asking "when would you like to start renting?" is owed an
  // honest answer, and on a search with no dates chosen the honest answer is not
  // a day - it is "still comparing prices, I'll fix the dates once I pick".
  // A stated weekday is the one invented fact that costs the traveller
  // something real: the shop holds a bike, chases for confirmation, and reads a
  // later "no" as a cancellation.
  //
  // A rail rather than a prompt line, for the same reason as every rail here.
  if (inventsADate(text, ctx.session.rfq)) {
    return {
      ok: false,
      rejected: {
        rule: "traveller-disclosure",
        detail: "the draft states a rental date the traveller has not chosen",
      },
    };
  }

  // 0.8) A FAREWELL IS A GOODBYE. It may not carry a price or an agreement.
  //
  // Ko Tao, 12:43: the shop had said it had nothing to rent, the engine chose
  // the goodbye move, and the message that went out was "great, 180 baht per
  // day is a good price!" - an acceptance, sent to a shop that had already
  // withdrawn, five minutes after we had told it we found the price too high.
  //
  // The move was renamed (`close` -> `farewell`) and the prompt now states its
  // meaning, but both of those are instructions, and an instruction is advice.
  // This is the guarantee: whatever the model writes, a farewell that names a
  // number or agrees to one does not go out. `restock-probe` is held to the
  // same rule for the same reason - a shop that just ran out is the single
  // most dangerous moment to sound like we are accepting terms.
  if (artifact.move === "farewell" || artifact.move === "redirect-close" || artifact.move === "restock-probe") {
    const AGREE_RX =
      /\b(deal|agreed?|i'?ll take it|we'?ll take it|book(ing|ed)? it|i'?ll book|confirm(ed|ing)?|sounds good|that works|good price|great price|perfect price|i accept|works for me)\b/i;
    const agreed = AGREE_RX.exec(text);
    // Any bare number of price magnitude. Deliberately blunt: a goodbye has no
    // legitimate reason to carry one, so there is nothing here to be precise
    // about. (Times were already refused by the rail below; this runs first.)
    const priced = /\d[\d,.]*\s*(?:\/|per\s|a\s)?\s*(?:day|night|baht|thb|฿|rp|idr|usd|\$|€|£)|(?:฿|\$|€|£|rp)\s*\d/i.exec(text);
    if (agreed || priced) {
      return {
        ok: false,
        rejected: {
          rule: "farewell-integrity",
          detail: agreed
            ? `a goodbye agreed to something ("${agreed[0]}")`
            : `a goodbye carried a price ("${priced?.[0]?.trim()}")`,
        },
      };
    }
  }

  // 0.9) THE COMMITMENT RAIL - now on EVERY move, not three of them.
  //
  // The traveller's decision has exactly one expression in this system: the
  // Lock This Deal button, which produces `closing-message`. Anything else
  // that books, reserves, accepts or announces we are on our way is the app
  // deciding for them - and a shop that holds a bike on that promise is a real
  // person losing a real rental when the traveller picks a cheaper shop.
  //
  // Information gathering is untouched by design (the owner's ruling): asking
  // what deposit they take or whether they deliver is a question, and questions
  // are how the traveller learns enough to decide.
  if (artifact.move !== COMMIT_ALLOWED_MOVE) {
    const committed = COMMIT_RX.exec(text);
    if (committed) {
      return {
        ok: false,
        rejected: {
          rule: "commitment",
          detail: `a ${artifact.move} committed on the traveller's behalf ("${committed[0].trim()}") - only Lock This Deal may do that`,
        },
      };
    }
  }

  // 1) Duration integrity: rewrite any wrong day-count to the RFQ's real value.
  text = correctDuration(text, ctx.session.rfq.durationDays).text;

  // 2) Numeric integrity: fabricated-rival / below-floor / inverted-ask. The
  //    ONE real rival is the cheapest sibling offer; the ceiling is the shop's
  //    own live quote; the floor is the grounded/market floor.
  const rival = ctx.session.rivals[0]?.pricePerDay;
  const ceiling = ctx.inbound.verified.pricePerDay ?? ctx.thread.digest.quotedPricePerDay;
  const check = checkOutboundNumbers({
    text,
    ceiling,
    floor: ctx.guards.floorPerDay,
    rivalPrice: rival,
    // The prompt shows the model every rival in the session; the rail must back
    // every one of them, or citing rival #2 gets the whole draft rejected and
    // replaced by a template that names no rival at all.
    rivalPrices: ctx.session.rivals.map((r) => r.pricePerDay),
    // A price the shop itself posted on a board is a legitimate number to quote
    // back even when it sits above the current quote ("your list says 300, can
    // you do 250?") - without this it reads as an inverted ask and is rejected.
    allowAbove: [
      ctx.inbound.verified.sheetPricePerDay,
      ...(ctx.thread.digest.options ?? []).map((o) => o.pricePerDay),
    ].filter((n): n is number => typeof n === "number" && n > 0),
    excludeExact: [ctx.session.rfq.durationDays, ctx.session.rfq.engineSizeCc ?? 0].filter(Boolean),
    // PROVENANCE: every price-scale numeral must be a number this thread's
    // structured state holds or a closed derivation of one (total/days,
    // daily*days, rounding). Derived rates are legal - "1200 for 6 days"
    // grounds a "200/day" ask - but the field's invented "Your price 300"
    // (against a 250B greeting the extractor had missed) is not.
    // A pickup-location message is owned ENTIRELY by the location rail below
    // (verified address, approved link, no raw coordinates) - a street number
    // in a real address must never read as an ungrounded price.
    grounded: artifact.move === "pickup-location" ? [] : [
      ctx.inbound.verified.pricePerDay,
      ctx.thread.digest.quotedPricePerDay,
      ctx.inbound.verified.sheetPricePerDay,
      // The pass's own counter ask. It is not a free pass: for price moves
      // every text numeral still has to sit inside [floor, ceiling] below,
      // and a within-bounds ask IS the ladder - what provenance adds is that
      // no OTHER number ("Your price 300 is too much") can ride along.
      artifact.counterPricePerDay,
      ctx.session.benchmark?.pricePerDay,
      ...(ctx.thread.digest.options ?? []).map((o) => o.pricePerDay),
      // Every numeral the conversation VERBATIM contains - the shop's own
      // words and ours. A number either party already said is never an
      // invention; what this basis has no path to is the field's "Your
      // price 300 is too much" against a thread that never held a 300.
      ...verbatimNumerals([
        ctx.inbound.text,
        ...ctx.tail.map((m) => m.text),
        ...(ctx.thread.digest.lastOutbound ?? []),
      ]),
    ].filter((n): n is number => typeof n === "number" && n > 0),
    durationDays: ctx.session.rfq.durationDays,
    checkAskBounds: artifact.move === "bargain" || artifact.move === "momentum",
  });
  if (!check.ok) {
    // A number that fails verification is never sent (the anti-hallucination
    // guarantee). The caller falls back to a safe templated move.
    return { ok: false, rejected: { rule: check.violation ?? "numbers", detail: check.detail } };
  }

  // 2b) LOCATION INTEGRITY (graph/nodes.ts:490 parity). A message that shares
  //     where the traveller is must carry the VERIFIED address, and must not
  //     carry any map link other than the one the consent gate approved. A
  //     model that paraphrased the address into a nearby landmark, or minted
  //     its own maps URL, is rejected - the caller then sends the template,
  //     which is composed from the gate and cannot drift.
  if (artifact.move === "pickup-location") {
    const approved = ctx.share?.mapsLink;
    const address = ctx.share?.addressText;
    if (!address || !text.includes(address)) {
      return { ok: false, rejected: { rule: "location", detail: "verified address missing" } };
    }
    const links = text.match(/https?:\/\/\S+/gi) ?? [];
    if (links.some((l) => l.replace(/[).,]+$/, "") !== approved)) {
      return { ok: false, rejected: { rule: "location", detail: "unapproved link" } };
    }
    // Bare coordinates are never ours to write - the gate emits a link or text.
    if (/-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/.test(text.replace(approved ?? "", ""))) {
      return { ok: false, rejected: { rule: "location", detail: "raw coordinates" } };
    }
  }

  // 3) Never finalize a time.
  if (TIME_COMMIT_RX.test(text) && !/confirm.*time/i.test(text)) {
    text = text.replace(TIME_COMMIT_RX, "").replace(/\s{2,}/g, " ").trim();
    text = `${text}${TIME_DEFER_LINE}`;
  }

  return { ok: true, finalText: text };
}
