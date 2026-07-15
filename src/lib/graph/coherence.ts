// Media Coherence Validator - runs after EVERY image or voice interpretation
// and answers one question: does the machine's reading actually fit this
// conversation? A transcript that says "35,000" when the thread is about a
// 150/day scooter, a price-sheet read in the wrong currency scale, a vehicle
// that does not match the request - all get flagged BEFORE the director acts,
// and the default graph routes an incoherent reading to a gentle text-confirm
// clarify instead of a confident wrong move.

import "server-only";
import { chat, extractJson } from "../ai";
import type { ExtractedOffer } from "../agents";
import type { StructuredRFQ } from "../types";

export interface CoherenceVerdict {
  coherent: boolean;
  issues: string[];
  correctedPricePerDay?: number;
  fromAi: boolean;
}

/**
 * Deterministic arithmetic backstop (always runs): the generalized
 * total-vs-per-day net + floor-bounds sanity. The LLM pass (when available)
 * layers semantic checks on top - vehicle mismatch, numbers contradicting
 * earlier turns, currency confusion.
 */
export function deterministicCoherence(args: {
  pricePerDay?: number;
  durationDays: number;
  floorPrice?: number;
  floorTypical?: number;
}): CoherenceVerdict {
  const issues: string[] = [];
  let corrected: number | undefined;
  const { pricePerDay, durationDays, floorPrice, floorTypical } = args;
  if (pricePerDay && floorPrice) {
    const typical = floorTypical ?? Math.round(floorPrice * 1.6);
    // A "per-day" price several times the typical rate that divides cleanly
    // into a plausible daily figure was almost certainly the rental TOTAL.
    if (durationDays > 1 && pricePerDay >= typical * 2) {
      const perDayIfTotal = Math.round(pricePerDay / durationDays);
      if (perDayIfTotal >= floorPrice * 0.55) {
        issues.push(
          `price ${pricePerDay} looks like the ${durationDays}-day TOTAL (typical daily here is ~${typical}) - corrected to ${perDayIfTotal}/day`
        );
        corrected = perDayIfTotal;
      }
    }
    // A price far BELOW the floor is usually a mis-read (wrong scale/currency).
    if (!corrected && pricePerDay < floorPrice * 0.25) {
      issues.push(
        `price ${pricePerDay} is far below the local floor ${floorPrice} - likely a mis-read scale or currency`
      );
    }
  }
  return { coherent: issues.length === 0, issues, correctedPricePerDay: corrected, fromAi: false };
}

export async function validateMediaCoherence(args: {
  kind: "image" | "audio";
  interpretation: string; // transcript text OR the extraction summary
  extraction: ExtractedOffer | null;
  history: string;
  rfq: StructuredRFQ;
  floorPrice?: number;
  floorTypical?: number;
  region?: string;
  llmAllowed: boolean;
}): Promise<CoherenceVerdict> {
  const det = deterministicCoherence({
    pricePerDay: args.extraction?.pricePerDay,
    durationDays: args.rfq.durationDays,
    floorPrice: args.floorPrice,
    floorTypical: args.floorTypical,
  });
  if (!args.llmAllowed) return det;

  const out = await chat([
    {
      role: "system",
      content:
        "You verify a machine interpretation of media (a voice-note transcript or an " +
        "image reading) from a vehicle rental shop against the WHOLE conversation. " +
        "Flag ONLY real inconsistencies: prices whose scale/currency contradicts the " +
        "thread (a total read as per-day), a vehicle that does not match what the " +
        "traveller asked for, numbers that contradict what the shop said earlier, or " +
        "content clearly unrelated to this negotiation (a mis-transcription). Mileage " +
        "numbers on an odometer photo are NOT prices - never confuse the two. " +
        'Reply ONLY as JSON: { "coherent": boolean, "issues": string[], ' +
        '"correctedPricePerDay": number|null }.',
    },
    {
      role: "user",
      content:
        `Traveller asked for: ${JSON.stringify({
          vehicleClass: args.rfq.vehicleClass,
          engineSizeCc: args.rfq.engineSizeCc,
          durationDays: args.rfq.durationDays,
        })}\n` +
        (args.floorPrice ? `Typical local daily price: around ${args.floorTypical ?? args.floorPrice}.\n` : "") +
        `Conversation so far:\n${args.history}\n\n` +
        `Media kind: ${args.kind}\n` +
        `Machine interpretation: ${args.interpretation.slice(0, 1200)}\n` +
        `Structured read: ${JSON.stringify({
          pricePerDay: args.extraction?.pricePerDay ?? null,
          currency: args.extraction?.currency ?? null,
          matchesSpec: args.extraction?.matchesSpec ?? null,
          imageKind: args.extraction?.imageKind ?? null,
        })}`,
    },
  ]);
  if (!out) return det;
  const parsed = extractJson<{
    coherent?: boolean;
    issues?: string[];
    correctedPricePerDay?: number | null;
  }>(out);
  if (!parsed || typeof parsed.coherent !== "boolean") return det;

  const issues = [
    ...det.issues,
    ...(Array.isArray(parsed.issues)
      ? parsed.issues.filter((x) => typeof x === "string").slice(0, 5)
      : []),
  ];
  const corrected =
    det.correctedPricePerDay ??
    (typeof parsed.correctedPricePerDay === "number" && parsed.correctedPricePerDay > 0
      ? Math.round(parsed.correctedPricePerDay)
      : undefined);
  return {
    coherent: parsed.coherent && det.coherent,
    issues,
    correctedPricePerDay: corrected,
    fromAi: true,
  };
}
