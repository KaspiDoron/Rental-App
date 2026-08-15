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
// THREAD COMPREHENSION (W4.3 + W4.4) - the two questions the engine has to ask
// of every shop turn, and could not: is this shop still dealing with us, and
// is there anything here we are not sure we read right?
//
// A shop replied "You should try asking other shops; maybe they'll give you
// one." The agent answered "Could you let me know your daily rate for the
// automatic 125cc scooter?" - because nothing in the system had a category for
// being sent away. Dialogue acts carry ASK kinds and SHARE kinds and no refusal
// member; the one terminal-refusal reader is a regex whose alternatives are
// "not interested", "good luck", "take it there". A polite brush-off is none of
// those and never will be, in any of the languages this app runs in. A phrase
// list is always yesterday's vocabulary.
//
// UNCERTAINTY IS THE SECOND HALF, and it is the owner's rule verbatim: "if the
// ai agents not sure about something - they should ask the shop 'wait, you mean
// that I can deposit a passport or cash 4000?' then wait for the shop answer."
// A model that has read the message is the only thing in the system that KNOWS
// what it is unsure of, so it says so - one entry per shaky fact, each carrying
// the reading we would otherwise have latched and the question that settles it.
// ---------------------------------------------------------------------------

/** The facts a confirming question may be put about. Mirrored (deliberately,
 *  and asserted at compile time) by spte/types.ts ConfirmSubject: the engine's
 *  move vocabulary is closed, so the subjects it can be parameterized by are
 *  closed too. */
export const ConfirmSubjectSchema = z.enum([
  "deposit",
  "price",
  "availability",
  "conditions",
  "vehicle",
]);
export type ConfirmSubjectName = z.infer<typeof ConfirmSubjectSchema>;

export const ThreadComprehension = z.object({
  /**
   * WHERE THIS SHOP STANDS WITH US, as a person would read it.
   *
   * engaged    - still in the conversation, whatever else they said. A firm
   *              price, a stock-out, a question back, silence about the rate:
   *              all engaged.
   * deflecting - politely getting rid of us. Sending us to other shops, saying
   *              they cannot help with this, answering a rate question with a
   *              suggestion that we look elsewhere. NOT a refusal word, which
   *              is exactly why a phrase list never caught it.
   * declining  - an outright end: not interested, take the other offer.
   * unclear    - the message does not settle it.
   */
  stance: z.enum(["engaged", "deflecting", "declining", "unclear"]),
  /** Their own words for it, verbatim - so the card can quote, not claim. */
  stanceQuote: z.string().max(200).nullable(),
  /** One sentence of why, for the trace. Never sent to the shop. */
  stanceReason: z.string().max(240).nullable(),
  /**
   * FACTS THIS MESSAGE DID NOT SETTLE CLEANLY. Empty when the message is plain.
   * `reading` is what we would otherwise have written down; `question` is the
   * confirming question to put back, in the traveller's voice.
   */
  uncertain: z
    .array(
      z.object({
        subject: ConfirmSubjectSchema,
        reading: z.string().max(200),
        question: z.string().max(220),
        confidence: z.number().min(0).max(1),
      })
    )
    .max(3),
  /**
   * W4.6 - DID THE SHOP STATE SOMETHING ABOUT LANGUAGE?
   *
   * Not "did they reply in English" - that is a demonstration, and demonstration
   * is exactly what the old doctrine flipped on, ending the local-language
   * feature for every shop in Thailand that types "ok 300 per day". This is a
   * STATEMENT: they told us they do not speak the local language, or asked us to
   * write English (or asked us back into the local language). The judgement
   * belongs to a model reading the sentence, never to a phrase list - the
   * owner's standing rule for anything to do with understanding.
   *
   * `.nullish()` on purpose: an older provider that omits the key entirely must
   * not fail schema validation and take the stance read down with it.
   */
  languageRequest: z
    .object({
      /** "english" = write to us in English; "local" = write in the local one. */
      prefers: z.enum(["english", "local"]),
      /** Their own words, verbatim - the card quotes rather than claims. */
      quote: z.string().max(200).nullable(),
      confidence: z.number().min(0).max(1),
    })
    .nullish(),
  confidence: z.number().min(0).max(1),
});
export type ThreadComprehension = z.infer<typeof ThreadComprehension>;

export function readComprehension(
  text: string,
  context?: string,
  options?: { budgetMs?: number; tier?: "premium"; once?: boolean }
): Promise<SemanticOutcome<ThreadComprehension>> {
  return semanticParse({
    schema: ThreadComprehension,
    shape:
      '{"stance": "engaged"|"deflecting"|"declining"|"unclear", "stanceQuote": string|null, ' +
      '"stanceReason": string|null, "uncertain": [{"subject": "deposit"|"price"|"availability"' +
      '|"conditions"|"vehicle", "reading": string, "question": string, "confidence": 0..1}], ' +
      '"languageRequest": null | {"prefers": "english"|"local", "quote": string|null, "confidence": 0..1}, ' +
      '"confidence": 0..1}',
    instructions:
      "You are the traveller's agent reading a rental shop's WhatsApp reply. Answer TWO " +
      "questions.\n" +
      "FIRST, where does this shop stand? Telling us to try other shops, to look elsewhere, " +
      "or that someone else will help us, is DEFLECTING - a polite way of ending the " +
      "conversation without saying no. Saying outright they are not interested, or to take " +
      "the other offer, is DECLINING. Everything else is ENGAGED, and this matters: having " +
      "no vehicle right now is a stock-out, refusing to lower a price is firmness, asking us " +
      "a question back is interest - NONE of those is a refusal to deal, and treating them " +
      "as one ends a live negotiation. Use unclear only when the message genuinely does not " +
      "settle it.\n" +
      "SECOND, is there anything in this message you are NOT confident you read correctly? " +
      "List at most three. A deposit stated as a choice or with an unclear amount, a price " +
      "that could be per day or for the whole rental, an availability word that could mean " +
      "'in stock' or 'at no cost', a vehicle that could be a different model - each of those " +
      "is worth confirming rather than assuming. For each one give the reading you would " +
      "otherwise assume, and a SHORT, warm question the traveller could send to settle it " +
      "('wait - do you mean I can leave a passport OR 4,000 cash?'). Write the question in " +
      "simple everyday English, first person, one sentence. If the message is plain, return " +
      "an empty list - a needless question wastes the shop's patience.\n" +
      "THIRD, did this shop SAY something about which LANGUAGE to use? We write to shops in " +
      "their own local language on purpose, and we only change that if they ASK. Set " +
      "languageRequest ONLY for an explicit statement or request about language - 'sorry I " +
      "don't speak Thai', 'I am not Thai, please write English', 'can you write in English', " +
      "'English please' - or, the other way, 'please write Thai/Spanish/Indonesian'. " +
      "SIMPLY REPLYING IN ENGLISH IS NOT SUCH A STATEMENT and must return null: shop owners " +
      "everywhere type a few words of English at tourists and it says nothing about what they " +
      "read comfortably. A message that merely happens to be in English, or mixes languages, " +
      "is null. Quote their exact words when you do set it.",
    text,
    context,
    options: {
      budgetMs: options?.budgetMs ?? 6_000,
      maxTokens: 600,
      once: options?.once,
      ...(options?.tier === "premium" ? { tier: "premium" as const } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// DID THEY ANSWER THE QUESTION WE ASKED? - the other half of the confirm
// doctrine, and the half that had no reader at all.
//
// The owner: "if the ai agents not sure about something - they should ask the
// shop 'wait, you mean that I can deposit a passport or cash 4000?' THEN WAIT
// FOR THE SHOP ANSWER."
//
// Waiting only means something if something can end the wait, and "did this
// reply answer my question" is a judgement about MEANING - the shop answers
// "yes both ok", "up to you", "passport better but cash also fine", "we take
// 4000", a photo of a price board, or a sentence about something else entirely.
// A keyword test over that is the phrase-list mistake in its purest form, so
// this is a schema-validated model read like every other judgement here. The
// STATE MACHINE around it (are we waiting, for what, for how many turns) stays
// deterministic in spte/digest.ts, because a bound is arithmetic.
// ---------------------------------------------------------------------------

export const ConfirmAnswer = z.object({
  /** Does this message answer the question we put to them? */
  answered: z.boolean(),
  /** What they settled it as, in their words - for the thread's memory. */
  answer: z.string().max(200).nullable(),
  /**
   * They responded to it and it is STILL not clear (they repeated the same
   * ambiguous thing, or answered a different question). Answered=false covers
   * "they talked about something else"; this covers "they tried and we are no
   * wiser", which must not end the wait either.
   */
  stillUnclear: z.boolean(),
  confidence: z.number().min(0).max(1),
});
export type ConfirmAnswer = z.infer<typeof ConfirmAnswer>;

export function readConfirmAnswer(
  question: string,
  text: string,
  context?: string,
  options?: { budgetMs?: number; tier?: "premium"; once?: boolean }
): Promise<SemanticOutcome<ConfirmAnswer>> {
  return semanticParse({
    schema: ConfirmAnswer,
    shape:
      '{"answered": boolean, "answer": string|null, "stillUnclear": boolean, "confidence": 0..1}',
    instructions:
      "We are the traveller's agent. We asked this shop ONE question and have been waiting for " +
      `their reply. OUR QUESTION WAS: "${question.slice(0, 220)}"\n` +
      "Decide whether the message below ANSWERS that question. Answering it does not require " +
      "repeating it: 'yes both are ok', 'up to you', 'passport is better but cash also fine', " +
      "'4000 only', a correction, or a plain 'yes' to a yes/no question all answer it. Talking " +
      "about something else - the price, the pickup time, a greeting, a photo of a bike - does " +
      "NOT, however friendly it is. If they responded but we are still no wiser (they repeated " +
      "the same ambiguous wording, or answered a different question), set answered false and " +
      "stillUnclear true. Report what they settled it as in their own words when they did " +
      "settle it, and never invent an answer they did not give.",
    text,
    context,
    options: {
      budgetMs: options?.budgetMs ?? 6_000,
      maxTokens: 250,
      once: options?.once,
      ...(options?.tier === "premium" ? { tier: "premium" as const } : {}),
    },
  });
}

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

export function readAvailability(
  text: string,
  context?: string,
  options?: { budgetMs?: number; tier?: "premium"; once?: boolean }
): Promise<SemanticOutcome<AvailabilityMeaning>> {
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
    options: {
      budgetMs: options?.budgetMs ?? 6_000,
      maxTokens: 250,
      once: options?.once,
      ...(options?.tier === "premium" ? { tier: "premium" as const } : {}),
    },
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

export function readDepositTerms(
  text: string,
  context?: string,
  options?: { budgetMs?: number; tier?: "premium"; once?: boolean }
): Promise<SemanticOutcome<DepositTerms>> {
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
    options: {
      budgetMs: options?.budgetMs ?? 6_000,
      maxTokens: 300,
      once: options?.once,
      ...(options?.tier === "premium" ? { tier: "premium" as const } : {}),
    },
  });
}
