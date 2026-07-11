import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { verifiedTagsFor } from "@/lib/vendor-tags";

// VERIFIED shop tags for a set of vendor ids (item #13). A tag appears only
// after the shop confirmed it in at least two different replies - one message
// never earns a badge. Tags are global shop knowledge (not per-user), so every
// traveller benefits from every conversation the shop ever had.
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ tags: {} }, { status: 401 });

  const ids = (new URL(req.url).searchParams.get("ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 40);
  if (!ids.length) return NextResponse.json({ tags: {} });

  const tags = await verifiedTagsFor(ids);
  return NextResponse.json({ tags });
}

// Vercel: allow slow upstreams (Hobby default is ~10s - too short).
export const maxDuration = 60;
