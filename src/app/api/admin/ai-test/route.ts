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
  try {
    const results = await testAllProviders();
    return NextResponse.json({ results });
  } catch (e) {
    // The sweep itself crashing must reach the panel as its own words, not
    // as an opaque 500 the client can only render as "something failed".
    const reason = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: reason.slice(0, 300) }, { status: 500 });
  }
}

export const maxDuration = 60;
