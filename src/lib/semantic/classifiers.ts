import "server-only";
import { z } from "zod";
import { semanticParse, type SemanticOutcome } from "./parse";

// THE TYPED JUDGEMENTS. One schema per question the engine actually asks of a
// shop's message. Each one replaces (or demotes) a phrase list.
//
// Every schema has an explicit "unknown"/null branch, and every field the
// engine will act on carries a confidence, because the alternative is a
// confident wrong answer - which in this system means a message sent in the
// traveller's name about something the shop never said.

// ---------------------------------------------------------------------------
// CALL INTENT (M14) - "can we speak?", "phone?", a missed-call frame.
// ---------------------------------------------------------------------------

export const CallIntent = z.object({
  /** Does the sender want to move this to a voice call? */
  wantsCall: z.boolean(),
  /** Their own words for it, verbatim - so the UI can quote rather than claim. */
  quote: z.string().max(200).nullable(),
  /** URGENT means they are asking to speak NOW, not "call me sometime". */
  urgency: z.enum(["now", "soon", "whenever", "none"]),
  confidence: z.number().min(0).max(1),
});
export type CallIntent = z.infer<typeof CallIntent>;

export function readCallIntent(text: string, context?: string): Promise<SemanticOutcome<CallIntent>> {
  return semanticParse({
    schema: CallIntent,
    shape: '{"wantsCall": boolean, "quote": string|null, "urgency": "now"|"soon"|"whenever"|"none", "confidence": 0..1}',
    instructions:
      "Decide whether the sender is asking to continue this conversation by VOICE CALL rather " +
      "than by text. A phone number offered for WhatsApp messaging is not a call request. " +
      "Sending their number so the traveller can 'ring when you arrive' is not one either - " +
      "that is logistics. Asking to talk, asking to be called, or a missed call, is.",
    text,
    context,
    options: { budgetMs: 6_000, maxTokens: 200 },
  });
}

// ---------------------------------------------------------------------------
// ALTERNATIVE VEHICLE OFFER (M12) - "no 125, but I have a 150 for 220".
// ---------------------------------------------------------------------------

export const AlternativeVehicleOffer = z.object({
  /** Is the shop proposing a DIFFERENT vehicle from the one asked for? */
  offered: z.boolean(),
  /** What they named, in their words ("Yamaha Nmax", "new automatic 150"). */
  vehicle: z.string().max(120).nullable(),
  /** Engine size if they stated one. Never inferred from the model name. */
  engineSizeCc: z.number().int().positive().max(5000).nullable(),
  /** Daily price for the ALTERNATIVE, if they gave one. */
  pricePerDay: z.number().positive().max(1_000_000).nullable(),
  /**
   * Is it a reasonable substitute for what the traveller asked for? The MODEL
   * judges this against the request - not a cc lookup table, which cannot know
   * that a 110 Click and a 125 Vario are the same ride to a tourist while a
   * 400cc sports bike is not.
   */
  closeness: z.enum(["equivalent", "acceptable", "different-class", "unclear"]),
  /** One sentence the traveller can read to decide. Their language, not ours. */
  reason: z.string().max(240).nullable(),
  confidence: z.number().min(0).max(1),
});
export type AlternativeVehicleOffer = z.infer<typeof AlternativeVehicleOffer>;

export function readAlternativeOffer(
  text: string,
  context: string
): Promise<SemanticOutcome<AlternativeVehicleOffer>> {
  return semanticParse({
    schema: AlternativeVehicleOffer,
    shape:
      '{"offered": boolean, "vehicle": string|null, "engineSizeCc": number|null, ' +
      '"pricePerDay": number|null, "closeness": "equivalent"|"acceptable"|"different-class"|"unclear", ' +
      '"reason": string|null, "confidence": 0..1}',
    instructions:
      "The traveller asked for a specific vehicle (see CONTEXT). Decide whether this message " +
      "offers a DIFFERENT one instead. Judge closeness the way a traveller would: an equivalent " +
      "is the same kind of ride at the same kind of price; acceptable means they would probably " +
      "be fine with it; different-class means it is genuinely another category (a car for a " +
      "scooter, a 400cc sports bike for a 125 automatic). Do NOT reason from engine numbers " +
      "alone - the same cc can be a very different vehicle.",
    text,
    context,
    options: { budgetMs: 8_000, maxTokens: 300 },
  });
}

// ---------------------------------------------------------------------------
// ACCESSORY VERDICTS (M16) - every extra the traveller asked for, judged.
// ---------------------------------------------------------------------------

export const AccessoryVerdict = z.object({
  /** The requested item, echoed EXACTLY as the traveller wrote it. */
  item: z.string().max(80),
  /**
   * confirmed - the shop said yes, or said it is included
   * refused   - the shop said no, or said it costs extra and we must decide
   * unmentioned - the shop did not address it at all
   */
  verdict: z.enum(["confirmed", "refused", "unmentioned"]),
  /** Extra charge the shop named for it, if any. */
  extraCost: z.number().nonnegative().max(1_000_000).nullable(),
  /** The shop's own words, so the chip can be traced back to a real sentence. */
  quote: z.string().max(200).nullable(),
  confidence: z.number().min(0).max(1),
});
export type AccessoryVerdict = z.infer<typeof AccessoryVerdict>;

export const AccessoryVerdicts = z.object({ items: z.array(AccessoryVerdict).max(12) });
export type AccessoryVerdicts = z.infer<typeof AccessoryVerdicts>;

export function readAccessoryVerdicts(
  text: string,
  requested: string[],
  context?: string
): Promise<SemanticOutcome<AccessoryVerdicts>> {
  return semanticParse({
    schema: AccessoryVerdicts,
    shape:
      '{"items": [{"item": string, "verdict": "confirmed"|"refused"|"unmentioned", ' +
      '"extraCost": number|null, "quote": string|null, "confidence": 0..1}]}',
    instructions:
      "The traveller asked for these extras: " +
      requested.map((r) => `"${r}"`).join(", ") +
      ". For EACH one, decide what this message says about it. Return one entry per requested " +
      "item, echoing the item text exactly as given above. A shop that lists what is included " +
      "and omits an item has NOT refused it - that is unmentioned. A shop that names a price " +
      "for it has confirmed it WITH a cost.",
    text,
    context,
    options: { budgetMs: 8_000, maxTokens: 600 },
  });
}

// ---------------------------------------------------------------------------
// AVAILABILITY MEANING (R10) - the "free" problem, read rather than matched.
// ---------------------------------------------------------------------------

export const AvailabilityMeaning = z.object({
  /**
   * has     - they have one available now
   * none    - they have none right now (a stock-out, not a refusal)
   * later   - they will have one, and may have said when
   * unclear - the message does not settle it
   */
  state: z.enum(["has", "none", "later", "unclear"]),
  /** When it comes back, in the shop's own words ("tomorrow", "next week"). */
  backWhen: z.string().max(80).nullable(),
  /**
   * True when the sender used "free" (or a translation of it) to mean AT NO
   * COST rather than available. The two senses collide in every market this
   * app serves and reading them backwards has cost a real booking.
   */
  freeMeansNoCost: z.boolean().nullable(),
  confidence: z.number().min(0).max(1),
});
export type AvailabilityMeaning = z.infer<typeof AvailabilityMeaning>;

export function readAvailability(text: string, context?: string): Promise<SemanticOutcome<AvailabilityMeaning>> {
  return semanticParse({
    schema: AvailabilityMeaning,
    shape:
      '{"state": "has"|"none"|"later"|"unclear", "backWhen": string|null, ' +
      '"freeMeansNoCost": boolean|null, "confidence": 0..1}',
    instructions:
      "Decide what this message says about whether the shop HAS the vehicle available to rent " +
      "right now. Having none right now is a stock-out, not a refusal to deal. If the sender " +
      "used the word 'free', decide which sense they meant: at no cost, or not currently rented " +
      "out. Set freeMeansNoCost to null when they did not use the word at all.",
    text,
    context,
    options: { budgetMs: 6_000, maxTokens: 250 },
  });
}

// ---------------------------------------------------------------------------
// DEPOSIT TERMS - what they want held, and whether it is a document.
// ---------------------------------------------------------------------------

export const DepositTerms = z.object({
  /** Did the message state deposit terms at all? */
  stated: z.boolean(),
  /** Cash amount they want held, if they named one. */
  amount: z.number().nonnegative().max(10_000_000).nullable(),
  currency: z.string().max(8).nullable(),
  /**
   * What they want to hold. `document` covers passport/ID/licence retention -
   * the one the safety screen exists for.
   */
  kind: z.enum(["cash", "document", "cash-or-document", "card", "none", "unclear"]),
  /** Which document, in their words ("passport", "driving licence", "ID card"). */
  document: z.string().max(60).nullable(),
  quote: z.string().max(200).nullable(),
  confidence: z.number().min(0).max(1),
});
export type DepositTerms = z.infer<typeof DepositTerms>;

export function readDepositTerms(text: string, context?: string): Promise<SemanticOutcome<DepositTerms>> {
  return semanticParse({
    schema: DepositTerms,
    shape:
      '{"stated": boolean, "amount": number|null, "currency": string|null, ' +
      '"kind": "cash"|"document"|"cash-or-document"|"card"|"none"|"unclear", ' +
      '"document": string|null, "quote": string|null, "confidence": 0..1}',
    instructions:
      "Decide what deposit or security this message asks for. Keeping a passport, ID or " +
      "driving licence during the rental is a DOCUMENT deposit even when they do not use the " +
      "word deposit. A shop saying no deposit is needed is kind 'none' with stated true. " +
      "Never convert currencies; report the number and currency exactly as written.",
    text,
    context,
    options: { budgetMs: 6_000, maxTokens: 300 },
  });
}
