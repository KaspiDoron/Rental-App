import "server-only";
import { z } from "zod";
import { semanticParse } from "../semantic/parse";
import { containsAbuse } from "../safety/blocklist";

// W6.2 - "DON'T ALLOW TO ADD CURSES / LANGUAGE WHICH IS NOT GOOD BEHAVIOUR -
// WE WANT SAFE WORDS FEEDBACK PAGE." (owner report 5, item 18)
//
// There was NO profanity or abuse filter anywhere in the feedback pipeline. The
// repo's only blocklist was inside `runSafety`, which guards outbound WhatsApp
// and is called by no feedback route; the triage prompt was not even asked to
// notice abuse, and a negative triage verdict blocked nothing - so an abusive
// report was stored and rendered verbatim to the owner.
//
// MODEL FIRST, BLOCKLIST AS THE FLOOR. A word list is yesterday's vocabulary by
// construction (this repo's own doctrine - see lib/semantic/parse.ts), so the
// judgement of whether a message is abusive goes to a model with a validated
// schema. The list is what cannot fail: no provider, no network, no budget, so
// there is no outage in which "fuck your app" gets through unexamined.
//
// AND IT IS DELIBERATELY NOT A COMPLAINT FILTER. "This is broken and I am
// furious" is exactly the feedback the owner most wants. The model is told, in
// as many words, that anger about the product is welcome and only abuse
// directed at a PERSON, slurs and threats are not.

const ModerationSchema = z.object({
  abusive: z.boolean(),
  /** Which kind, so the copy can be specific rather than generically prim. */
  kind: z.enum(["profanity", "insult", "threat", "hate", "sexual", "none"]),
  /** One short phrase, for the owner's log. Never shown to the reporter. */
  reason: z.string().max(200).default(""),
});

export type ModerationKind = z.infer<typeof ModerationSchema>["kind"];

export interface ModerationVerdict {
  allowed: boolean;
  kind: ModerationKind;
  /** Reporter-facing copy. Polite, specific, and it never quotes them back. */
  message?: string;
  /** How the decision was reached - for tests and for the owner's log. */
  source: "blocklist" | "model" | "clean";
  reason?: string;
}

const REFUSALS: Record<Exclude<ModerationKind, "none">, string> = {
  profanity:
    "We read every report - please send this one again without the swearing and we will get straight on it.",
  insult:
    "We want this report, but not the personal insult. Tell us what went wrong and we will fix it.",
  threat:
    "We cannot accept messages that threaten anyone. Describe the problem and we will take it seriously.",
  hate: "We do not accept hateful or discriminatory language. Please describe the problem instead.",
  sexual:
    "Please keep reports about the app. Send this again describing what went wrong and we will look into it.",
};

const INSTRUCTIONS =
  "You are moderating a bug report / feedback message sent to a small travel app's team. " +
  "Decide ONLY whether the message contains ABUSIVE language: swearing, insults aimed at a " +
  "person, threats, slurs, hate speech or sexual content. " +
  "ANGER AT THE PRODUCT IS NOT ABUSE. Harsh criticism, frustration, sarcasm, 'this is terrible', " +
  "'nothing works', 'I want my money back' are all legitimate feedback and must pass. " +
  "Only the language itself decides - never the severity of the complaint.";

/**
 * Is this feedback safe to store and show the owner?
 *
 * NEVER THROWS and never blocks on a slow provider: the floor answers first,
 * and a model that cannot be reached leaves a clean-looking message allowed
 * (which is the honest degrade - refusing everything during an LLM outage would
 * silently close the feedback box).
 */
export async function moderateFeedback(text: string): Promise<ModerationVerdict> {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return { allowed: false, kind: "none", source: "blocklist", message: REFUSALS.profanity };

  // The floor runs FIRST: it is free, instant and cannot be unavailable.
  if (containsAbuse(trimmed)) {
    return {
      allowed: false,
      kind: "profanity",
      source: "blocklist",
      reason: "matched the shared abuse blocklist",
      message: REFUSALS.profanity,
    };
  }

  try {
    const out = await semanticParse({
      schema: ModerationSchema,
      shape: '{ "abusive": boolean, "kind": "profanity"|"insult"|"threat"|"hate"|"sexual"|"none", "reason": string }',
      instructions: INSTRUCTIONS,
      text: trimmed.slice(0, 2000),
      options: { budgetMs: 6_000, maxTokens: 200, once: true },
    });
    const v = out.value;
    if (v?.abusive && v.kind !== "none") {
      return {
        allowed: false,
        kind: v.kind,
        source: "model",
        reason: v.reason || "the moderator flagged abusive language",
        message: REFUSALS[v.kind],
      };
    }
  } catch {
    // A moderator that cannot run must not close the feedback box. The floor
    // above has already had its say, and it is the part that cannot fail.
  }
  return { allowed: true, kind: "none", source: "clean" };
}
