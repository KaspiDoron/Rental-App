// SPTE post-rails - the DETERMINISTIC, 0-token verification every drafted
// message passes before it can be sent. This is where price integrity and the
// protocol guarantees live: the LLM proposes text, these rails dispose.
//
// Reuses the exact same guards the graph engine used (checkOutboundNumbers,
// correctDuration) so a council-composed message is held to the same standard,
// plus the never-finalize-a-time protocol rule (Step 5).

import { checkOutboundNumbers, correctDuration } from "../graph/guardrails";
import { rivalIdentityTokens, namesRival } from "../negotiation/leverage";
import { inventsADate } from "../negotiation/traveller-disclosure";
import type { RailResult, TurnArtifact, TurnContext } from "./types";

// A drafted message must never AGREE a concrete pickup/delivery time - the
// traveller confirms that directly (Step 5 hard rule). These patterns catch an
// LLM that tried to lock a time.
const TIME_COMMIT_RX =
  /\b(see you|meet you|i'?ll be there|pick ?up at|come by at|let'?s meet|be there at)\b.*\b(\d{1,2}\s?(?:am|pm|:\d{2})|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const TIME_DEFER_LINE = " I'll confirm the exact time with you directly.";

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
    artifact.move === "close" ||
    artifact.move === "present" ||
    artifact.move === "momentum";
  if (priceMove && gate && gate !== "confirmed") {
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
