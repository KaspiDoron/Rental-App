import "server-only";
import { z } from "zod";
import { chatDetailed, extractJson, type ProviderName } from "../ai";

// SEMANTIC PARSING, WITH A CONTRACT.
//
// The owner's mandate, stated plainly: no phrase lists for INTENT. Every
// keyword bucket this codebase has shipped has failed the same way - a shop
// wrote the thing in words nobody enumerated, and the feature was silently
// dead. "Do you have a helmet" is in the list; "gopro mount" is not. "Can I
// call you" is in the list; "phone?" is not. The list is always yesterday's
// vocabulary.
//
// So intent goes to a model, and comes back as a SCHEMA. The schema is what
// makes this different from "ask the LLM and hope": the value is validated
// before any caller sees it, a shape mismatch is retried once with the error
// fed back, and a second failure returns null rather than a plausible-looking
// object nobody checked.
//
// WHAT THIS IS NOT. This is not a rail. Rails - commitment language, price
// provenance, rival disclosure, duration integrity - stay deterministic,
// because a guarantee that depends on an LLM being reachable is not a
// guarantee. Rails constrain the model's OUTPUT. This reads the shop's INPUT.
//
// AND WHEN NO PROVIDER ANSWERS. The parser cannot run. Silent degradation is
// exactly how features "look dead" in the field, so the outcome says so - the
// provider, its error, and `degraded: true` - and callers surface it rather
// than pretending the shop said nothing.

export interface SemanticOutcome<T> {
  /** The validated value, or null when the parser could not produce one. */
  value: T | null;
  /** Which provider answered. Absent when none did. */
  provider?: ProviderName;
  /** The provider's own error, or the schema failure. */
  error?: string;
  /**
   * True when the parser could not run AT ALL (no reachable provider). The
   * caller's fallback is legitimate here; it is a bug everywhere else.
   */
  degraded: boolean;
  /** How many model calls this took (1 or 2). 0 when nothing was reachable. */
  attempts: number;
}

export interface SemanticOptions {
  /** Wall-clock budget per attempt. Keep it tight on the reply path. */
  budgetMs?: number;
  maxTokens?: number;
  /** Skip the retry - for callers where a second round trip costs more than
   *  the answer is worth (a background sweep, say). */
  once?: boolean;
  /**
   * THE STRONGEST BRAIN, FOR THE TURNS THAT CAN END A NEGOTIATION.
   *
   * `chatDetailed` runs the paid providers FIRST when the caller asks for the
   * premium tier (ai.ts) - it is the same escalation SPTE's pickRoute uses for
   * a farewell or a first push. Reading a shop's message is the other half of
   * that decision and it was pinned to the free chain: a brush-off misread as
   * "they just have not quoted yet" costs the same booking a bad farewell does.
   *
   * Deliberately per-CALL rather than per-classifier, because the same
   * judgement is high-stakes on the turn that could close the thread and
   * routine on the turn that could not - see spte/comprehension.ts.
   */
  tier?: "premium";
}

/** Turn a Zod issue list into one line a model can act on. */
function explain(err: z.ZodError): string {
  return err.issues
    .slice(0, 6)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

/**
 * Ask the model to read `text` and answer in the shape of `schema`.
 *
 * `instructions` describes the JUDGEMENT, not the format - the format comes
 * from the schema description passed as `shape`. Keep the instructions about
 * meaning ("decide whether the shop is asking to speak by phone"), because
 * that is the part a keyword list could never do.
 */
export async function semanticParse<T>(opts: {
  schema: z.ZodType<T>;
  /** A human-readable rendering of the expected JSON shape, for the prompt. */
  shape: string;
  /** What judgement to make. About meaning, never about formatting. */
  instructions: string;
  /** The text to read - usually the shop's own words, verbatim. */
  text: string;
  /** Anything the judgement depends on: the request, the thread so far. */
  context?: string;
  options?: SemanticOptions;
}): Promise<SemanticOutcome<T>> {
  const { schema, shape, instructions, text, context, options } = opts;
  const system =
    `${instructions}\n\n` +
    "You are reading a message from a vehicle rental shop, sent on WhatsApp, " +
    "often in imperfect English or a mix of languages. Judge what the sender " +
    "MEANS, not which words they used.\n" +
    "Answer with ONE JSON object and nothing else - no prose, no code fence.\n" +
    `SHAPE: ${shape}\n` +
    "If the message does not settle a field, use the schema's null/unknown " +
    "value for it. NEVER invent a fact the message does not contain.";

  const user = context ? `CONTEXT:\n${context}\n\nMESSAGE:\n${text}` : `MESSAGE:\n${text}`;

  let lastError: string | undefined;
  let provider: ProviderName | undefined;
  const maxAttempts = options?.once ? 1 : 2;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await chatDetailed(
      [
        { role: "system", content: system },
        {
          role: "user",
          content:
            attempt === 0
              ? user
              : // The retry SHOWS the model what was wrong. A blind re-ask is a
                // coin flip; a named schema violation is usually one edit away.
                `${user}\n\nYour previous answer did not match the shape. Fix exactly this: ${lastError}`,
        },
      ],
      {
        budgetMs: options?.budgetMs ?? 8_000,
        maxTokens: options?.maxTokens ?? 500,
        ...(options?.tier === "premium" ? { tier: "premium" as const } : {}),
      }
    );
    provider = res.provider ?? provider;

    if (!res.text) {
      // No provider answered. Retrying will not conjure one.
      return {
        value: null,
        provider,
        error: res.error ?? "no provider available",
        degraded: true,
        attempts: attempt,
      };
    }

    const raw = extractJson<unknown>(res.text);
    if (raw === null) {
      lastError = "the answer was not a JSON object";
      continue;
    }
    const parsed = schema.safeParse(raw);
    if (parsed.success) {
      return { value: parsed.data, provider, error: undefined, degraded: false, attempts: attempt + 1 };
    }
    lastError = explain(parsed.error);
  }

  // A reachable model that cannot produce the shape twice is NOT degraded mode
  // - the parser ran, it simply failed. Callers must tell those apart: one is
  // an outage, the other is a prompt or schema that needs work.
  return { value: null, provider, error: lastError, degraded: false, attempts: maxAttempts };
}
