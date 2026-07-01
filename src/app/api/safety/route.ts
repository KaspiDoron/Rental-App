import { NextResponse } from "next/server";
import { runSafety } from "@/lib/agents";

export async function POST(req: Request) {
  const { message } = await req.json().catch(() => ({ message: "" }));
  const verdict = await runSafety(String(message ?? ""));
  return NextResponse.json(verdict);
}
