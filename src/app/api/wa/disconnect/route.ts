import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { disconnectInstance } from "@/lib/evolution";

// Log out + delete the user's personal WhatsApp session.
export async function POST() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  await disconnectInstance(session.email);
  return NextResponse.json({ ok: true });
}

// Vercel: allow slow upstreams (Hobby default is ~10s - too short).
export const maxDuration = 60;
