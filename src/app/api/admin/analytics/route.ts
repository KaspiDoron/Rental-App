import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { analytics } from "@/lib/memory";

export async function GET() {
  const session = await requireManagement();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json(analytics());
}
