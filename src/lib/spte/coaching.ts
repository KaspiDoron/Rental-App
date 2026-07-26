// Coaching block for the PRIMARY (SPTE) engine.
//
// The graph engine already learns: it injects `agent_training` few-shot via
// composeBargain (agents.ts) and the compiled `ops_learning` exemplars via the
// director. SPTE - the LIVE primary engine - historically injected NEITHER, so
// the path that actually runs in production was the weaker learner. This closes
// that gap by assembling ONE compact coaching string from the SAME durable
// stores, so every SPTE turn benefits from owner teaching, Ops-Center review
// learning, AND the auto-distilled exemplars mined from winning traces
// (source:"distilled", written by src/lib/distill.ts).
//
// TONE-ONLY: the wording enforces "imitate tone/tactics, never copy a number";
// SPTE's post-rails checkOutboundNumbers still rejects any fabricated figure.
// Best-effort: returns "" on any failure so a turn never breaks on coaching.

import "server-only";
import { sbSelect } from "../runtime-config";
import { getOpsLearning } from "../ops/learning";

const cache = new Map<string, { text: string; exp: number }>();
const TTL_MS = 30_000;

/**
 * @param situation What is actually on screen this turn (menu open? photo
 * arrived? shop asked our location?). Owner LESSONS filed under the matching
 * label are retrieved for this turn only - a correction about price boards is
 * useless noise on a turn with no photo in it, and the prompt budget is small.
 * Omit it and only the global tone block is loaded, as before.
 */
export async function loadCoaching(
  situation?: import("../ops/misread").MisreadKind[]
): Promise<string> {
  // Keyed by situation: two different turns must not share one cached block.
  const kinds = [...new Set(situation ?? [])].sort();
  const key = kinds.join(",");
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.text;
  let text = "";
  try {
    // SITUATIONAL LESSONS first - they are the most specific thing we know
    // about this exact turn, and they are what the owner filed to fix it.
    const lessons = kinds.length
      ? await sbSelect<{ text: string }>(
          "agent_training",
          `select=text&source=eq.ops-lesson&note=in.(${kinds
            .map((k) => `"lesson:${k}"`)
            .join(",")})&order=created_at.desc&limit=3`
        ).catch(() => [])
      : [];
    // Priority: DISTILLED (auto-mined from winning DeepSeek/free traces) ->
    // owner Ops exemplars/corrections -> hand-taught transcripts.
    const [distilled, ops, classic] = await Promise.all([
      sbSelect<{ text: string }>(
        "agent_training",
        "select=text&source=eq.distilled&order=created_at.desc&limit=3"
      ).catch(() => []),
      sbSelect<{ text: string }>(
        "agent_training",
        "select=text&source=in.(ops-exemplar,ops-correction)&order=created_at.desc&limit=2"
      ).catch(() => []),
      sbSelect<{ text: string }>(
        "agent_training",
        "select=text&source=not.in.(ops-exemplar,ops-correction,distilled)&order=created_at.desc&limit=2"
      ).catch(() => []),
    ]);
    const learning = await getOpsLearning().catch(() => null);
    const exemplars = learning?.directorExemplars ?? [];

    const seen = new Set<string>();
    const examples: string[] = [];
    for (const t of [
      ...distilled.map((r) => r.text),
      ...ops.map((r) => r.text),
      ...exemplars,
      ...classic.map((r) => r.text),
    ]) {
      const clean = (t ?? "").replace(/\s+/g, " ").trim();
      if (clean && !seen.has(clean)) {
        seen.add(clean);
        examples.push(clean.slice(0, 280));
      }
      if (examples.length >= 5) break;
    }
    const blocks: string[] = [];
    if (lessons.length) {
      // Stated as RULES, not style: these are corrections about how to READ a
      // shop, and they must survive the "imitate the tone only" framing below.
      blocks.push(
        "WHAT THE OWNER TAUGHT US ABOUT SITUATIONS LIKE THIS ONE - follow it:\n" +
          lessons
            .map((l) => `- ${(l.text ?? "").replace(/\s+/g, " ").trim().slice(0, 320)}`)
            .filter((l) => l.length > 3)
            .join("\n")
      );
    }
    if (examples.length) {
      blocks.push(
        "LEARNED STYLE (imitate the TONE + tactics only - NEVER copy any number or place name):\n" +
          examples.map((e) => `- ${e}`).join("\n")
      );
    }
    text = blocks.join("\n\n");
  } catch {
    text = "";
  }
  text = text.slice(0, 1400);
  cache.set(key, { text, exp: Date.now() + TTL_MS });
  return text;
}

/** Test/hook: drop the cache so a fresh distillation shows up immediately. */
export function bustCoachingCache(): void {
  cache.clear();
}
