// Media Gap Validator - the agent that answers, after EVERY photo or voice
// note: "did the media give us what this negotiation still needs, and what is
// missing?" It looks at the WHOLE thread state + the traveller's request (not
// just the current phase), because a price sheet often carries deposit tiers
// or mileage we did not know we needed yet.
//
// Deterministic core (always runs, no keys needed) + an optional LLM pass that
// writes the one natural follow-up question to send the shop.

import "server-only";
import { chat } from "../ai";
import type { ExtractedOffer } from "../agents";
import type { StructuredRFQ } from "../types";
import type { ThreadFields } from "./types";

export interface MediaGapReport {
  /** What THIS media actually gave us, in plain words. */
  gained: string[];
  /** What the deal/thread still needs after merging the media in. */
  stillMissing: string[];
  /** One natural question to the shop that collects the biggest gap. */
  followUp?: string;
  fromAi: boolean;
}

export async function assessMediaGaps(args: {
  kind: "image" | "audio";
  extraction: ExtractedOffer;
  /** Thread fields AFTER the extraction was applied (or a best-effort merge). */
  fields?: Partial<ThreadFields>;
  rfq: StructuredRFQ;
  history?: string;
  llmAllowed?: boolean;
}): Promise<MediaGapReport> {
  const e = args.extraction;
  const f = args.fields ?? {};

  const gained: string[] = [];
  if (e.found && e.pricePerDay) gained.push(`price ${e.pricePerDay} ${e.currency ?? ""}/day`.trim());
  if (e.deposit) gained.push(`deposit terms ("${e.deposit}")`);
  if (e.delivers === true) gained.push("they deliver");
  if (e.onShopOnly === true) gained.push("on-shop pickup only");
  if (e.pickupOffered === true) gained.push("they offer to pick the traveller up");
  if (typeof e.mileageKm === "number") gained.push(`mileage ${e.mileageKm.toLocaleString()} km`);
  if (e.conditionNotes) gained.push(`visible condition: ${e.conditionNotes}`);
  if (e.imageSummary && !gained.length) gained.push(e.imageSummary.slice(0, 160));
  if (e.vehicleDescription) gained.push(`vehicle: ${e.vehicleDescription}`);

  const priceKnown = Boolean(f.pricePerDay || (e.found && e.pricePerDay));
  const depositKnown = Boolean(f.depositType || f.depositNote || e.deposit);
  const fulfillmentKnown = Boolean(
    f.fulfillment || e.delivers === true || e.onShopOnly === true || e.pickupOffered === true
  );

  const stillMissing: string[] = [];
  if (!priceKnown) stillMissing.push("the per-day price for the requested vehicle");
  if (!depositKnown) stillMissing.push("the deposit (cash amount or passport?)");
  if (!fulfillmentKnown) stillMissing.push("how the traveller gets it (delivery / pickup / on shop)");
  // The traveller explicitly cares about mileage - a vehicle photo without a
  // readable odometer leaves that open.
  if (args.rfq.maxMileageKm && !(typeof e.mileageKm === "number" || f.mileageKm)) {
    stillMissing.push(`the mileage (traveller wants under ${args.rfq.maxMileageKm.toLocaleString()} km)`);
  }
  if (e.imageKind === "vehicle" && !e.conditionNotes) {
    stillMissing.push("a clear look at the condition (ask for more photos if it matters)");
  }
  if (args.kind === "audio" && !e.found && !e.deposit) {
    stillMissing.push("a text confirmation of what the voice note said");
  }

  // Deterministic follow-up: ask for the single biggest gap.
  const deterministicFollowUp = stillMissing.length
    ? stillMissing[0].includes("price")
      ? "Ask the shop for their best per-day price for the exact requested vehicle."
      : stillMissing[0].includes("deposit")
      ? "Ask what deposit they need - cash amount or passport."
      : stillMissing[0].includes("gets it")
      ? "Ask if they deliver to the hotel or the traveller comes to the shop."
      : stillMissing[0].includes("mileage")
      ? "Ask how many km the bike has (or a photo of the odometer)."
      : "Ask the shop to confirm the missing detail in text."
    : undefined;

  if (!args.llmAllowed || stillMissing.length === 0) {
    return { gained, stillMissing, followUp: deterministicFollowUp, fromAi: false };
  }

  const out = await chat(
    [
      {
        role: "system",
        content:
          "You check whether a photo/voice note from a rental shop gave a negotiation what it " +
          "needs. Write ONE short, warm WhatsApp question (max 2 sentences, one emoji ok) that " +
          "collects the MOST important missing item below without repeating anything already " +
          "answered in the thread. Reply with the question only - no quotes, no explanations.",
      },
      {
        role: "user",
        content:
          `Traveller wants: ${args.rfq.engineSizeCc ?? ""}cc ${args.rfq.vehicleClass}, ${args.rfq.durationDays} days.\n` +
          `Thread so far:\n${(args.history ?? "(none)").slice(0, 1500)}\n` +
          `The media gave us: ${gained.join("; ") || "(nothing usable)"}\n` +
          `Still missing: ${stillMissing.join("; ")}`,
      },
    ],
    { maxTokens: 90 }
  );
  const followUp = (out ?? "").trim().replace(/^["']|["']$/g, "").slice(0, 240);
  return {
    gained,
    stillMissing,
    followUp: followUp || deterministicFollowUp,
    fromAi: Boolean(followUp),
  };
}
