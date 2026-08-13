import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { testAllProviders } from "@/lib/ai";

// Fire a tiny real completion at EVERY configured AI provider at once and
// report, per provider, whether it answered and with WHICH model - the
// one-button live truth behind Admin -> AI providers -> "Test AI providers".
// A provider whose primary id drifted shows ok:true with model !==
// configuredModel (the fallback rescued it), which is a fix-me signal, not
// a pass.
export async function POST() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const results = await testAllProviders();
  return NextResponse.json({ results });
}

export const maxDuration = 60;
