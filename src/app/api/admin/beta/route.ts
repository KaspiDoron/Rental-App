import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { betaAllowlist, saveBetaAllowlist, betaLockEnabled, type BetaEntry } from "@/lib/allowlist";

// Owner-only management of the private-beta invite list (the 25 testers +
// the owner). GET returns the current list + lock state; PUT replaces it.
export async function GET() {
  const session = await getSession();
  if (session?.role !== "owner") return NextResponse.json({ error: "Owner only" }, { status: 403 });
  const list = await betaAllowlist();
  return NextResponse.json({
    lockEnabled: betaLockEnabled(),
    entries: list,
    counts: {
      total: list.length,
      free: list.filter((e) => e.plan === "free").length,
      pro: list.filter((e) => e.plan === "pro").length,
      ultra: list.filter((e) => e.plan === "ultra").length,
    },
  });
}

export async function PUT(req: Request) {
  const session = await getSession();
  if (session?.role !== "owner") return NextResponse.json({ error: "Owner only" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const entries: BetaEntry[] = Array.isArray(body.entries) ? body.entries : [];
  await saveBetaAllowlist(entries);
  const list = await betaAllowlist();
  return NextResponse.json({ ok: true, entries: list });
}

// Vercel: allow slow upstreams (Hobby default is ~10s - too short).
export const maxDuration = 60;
