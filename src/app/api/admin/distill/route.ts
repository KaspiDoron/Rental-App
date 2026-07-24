import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/session";
import { runDistillation } from "@/lib/distill";

// Owner-only: mine winning negotiation turns and distil them into few-shot
// exemplars for the free models (the "DeepSeek teacher" of the free-first
// distillation pipeline). Writes agent_training(source:"distilled"); the SPTE
// coaching block injects them into every subsequent live turn. Owner-gated
// because it edits the SHARED training store that shapes all users' agents.
export async function POST() {
  const session = await requireOwner();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const result = await runDistillation();
  return NextResponse.json(result);
}

// Allow the slow teacher LLM call (DeepSeek/free failover) to finish.
export const maxDuration = 60;
