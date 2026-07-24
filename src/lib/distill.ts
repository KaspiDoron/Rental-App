// Knowledge distillation (Module 1.2, "free-first + DeepSeek teacher").
//
// The live negotiations run on the FREE providers. This offline teacher mines
// the WINNING turns from the engine's own telemetry (`agent_events`
// kind='engine-v3-turn', where `materialDrop === true` means the agent's message
// actually moved a shop's price down), asks DeepSeek (preferred; free chain as
// fallback) to distil them into short, number-free, reusable tactic exemplars,
// and writes them to `agent_training(source:"distilled")`. The SPTE coaching
// block (spte/coaching.ts) then injects them into every live free-model turn -
// so the cheap models inherit DeepSeek-grade tactics without DeepSeek running
// in the hot path (≈$0 ongoing). Owner-triggered via /api/admin/distill.

import "server-only";
import { sbSelect, sbInsert } from "./runtime-config";
import { chatDetailed, extractJson } from "./ai";
import { bustCoachingCache } from "./spte/coaching";

interface TurnDetail {
  move?: string;
  materialDrop?: boolean;
  text?: string | null;
}

export interface DistillResult {
  mined: number;
  written: number;
  provider?: string;
  error?: string;
}

export async function runDistillation(limit = 8): Promise<DistillResult> {
  // 1. Pull recent engine turns and keep only the WINNING ones.
  const rows = await sbSelect<{ detail: string }>(
    "agent_events",
    "select=detail&kind=eq.engine-v3-turn&order=created_at.desc&limit=300"
  ).catch(() => []);
  const wins: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    let d: TurnDetail;
    try {
      d = JSON.parse(r.detail) as TurnDetail;
    } catch {
      continue;
    }
    if (!d?.materialDrop || typeof d.text !== "string") continue;
    if (!["bargain", "present", "answer"].includes(String(d.move))) continue;
    const t = d.text.replace(/\s+/g, " ").trim();
    if (t.length < 8 || seen.has(t)) continue;
    seen.add(t);
    wins.push(t);
    if (wins.length >= 40) break;
  }
  if (wins.length < 3) {
    return {
      mined: wins.length,
      written: 0,
      error:
        "Not enough winning turns yet - need at least 3 messages that moved a shop's price down. Run more live negotiations first.",
    };
  }

  // 2. Teacher pass - DeepSeek preferred, free chain fallback. TONE/tactics only.
  const system =
    "You are a negotiation coach. Below are real WhatsApp messages a rental-haggling agent sent that " +
    "SUCCESSFULLY moved a shop's price down. Distil the TRANSFERABLE tactics into short reusable exemplars.";
  const user =
    "WINNING MESSAGES:\n" +
    wins.map((w, i) => `${i + 1}. ${w}`).join("\n") +
    `\n\nReturn ONLY a JSON object: { "exemplars": string[] } with up to ${limit} exemplars (each <=140 chars). ` +
    "Each teaches ONE reusable tactic in the same warm, brief, human tone - NO specific numbers, NO place names, NO shop names. " +
    'Example style: "Anchor on the multi-day total, then ask for one concrete number off the daily rate."';

  const res = await chatDetailed(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { maxTokens: 600, budgetMs: 20_000, preferProvider: "deepseek" }
  );
  if (!res.text) {
    return { mined: wins.length, written: 0, error: res.error ?? "No AI provider answered the teacher call." };
  }
  const parsed = extractJson<{ exemplars?: string[] }>(res.text);
  const exemplars = (parsed?.exemplars ?? [])
    .filter((e): e is string => typeof e === "string")
    .map((e) => e.replace(/\s+/g, " ").trim())
    // Reject any exemplar that leaked a number or price sign (tone-only rule).
    .filter((e) => e.length >= 8 && e.length <= 200 && !/\d|[$€£₱฿]/.test(e))
    .slice(0, limit);
  if (!exemplars.length) {
    return { mined: wins.length, written: 0, provider: res.provider, error: "The teacher returned no usable (number-free) exemplars." };
  }

  // 3. Persist as distilled few-shot; SPTE coaching reads source='distilled'.
  await sbInsert(
    "agent_training",
    exemplars.map((text) => ({
      text,
      source: "distilled",
      added_by: "distill",
      note: `distilled from ${wins.length} winning turns`,
    }))
  ).catch(() => {});
  bustCoachingCache();
  return { mined: wins.length, written: exemplars.length, provider: res.provider };
}
