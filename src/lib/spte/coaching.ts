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

let cache: { text: string; exp: number } | null = null;
const TTL_MS = 30_000;

export async function loadCoaching(): Promise<string> {
  if (cache && cache.exp > Date.now()) return cache.text;
  let text = "";
  try {
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
    if (examples.length) {
      text =
        "LEARNED STYLE (imitate the TONE + tactics only - NEVER copy any number or place name):\n" +
        examples.map((e) => `- ${e}`).join("\n");
    }
  } catch {
    text = "";
  }
  text = text.slice(0, 1400);
  cache = { text, exp: Date.now() + TTL_MS };
  return text;
}

/** Test/hook: drop the cache so a fresh distillation shows up immediately. */
export function bustCoachingCache(): void {
  cache = null;
}
