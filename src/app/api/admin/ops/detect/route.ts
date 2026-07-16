import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/session";
import { detectWeakConversations } from "@/lib/ops/detect";

// Fired opportunistically when the Ops Center opens (same piggyback pattern
// as outbox draining) - the system pre-fills the review inbox with the
// conversations most worth the owner's attention. Idempotent.
export async function POST() {
  const session = await requireOwner();
  if (!session) return NextResponse.json({ error: "Owner only." }, { status: 403 });
  const result = await detectWeakConversations();
  return NextResponse.json(result);
}

export const maxDuration = 60;
