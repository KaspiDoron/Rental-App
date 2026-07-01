import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { analytics } from "@/lib/memory";

export async function GET() {
  const session = getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json(analytics());
}
