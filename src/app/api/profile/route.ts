import { NextResponse } from "next/server";
import { runProfiler, deterministicRFQ } from "@/lib/agents";
import { aiEnabled } from "@/lib/ai";
import { getSession } from "@/lib/session";
import { sbInsert } from "@/lib/runtime-config";
import { clampRfqWindow } from "@/lib/rental-window";
import type { StructuredRFQ } from "@/lib/types";

// THE SAME AUTHORITY, AT THE START OF THE FUNNEL. Without this the opener asked
// twenty shops about a start date the traveller's plan cannot arrange - twenty
// real conversations built on a promise the app would refuse at the close.
// Adjusting up front is kinder than refusing at the end, and it is the same
// decision function every other surface calls (lib/rental-window).
function applyWindow(
  rfq: StructuredRFQ,
  plan: string | null | undefined,
  timeZone: unknown
): StructuredRFQ {
  return clampRfqWindow(rfq, {
    plan,
    nowMs: Date.now(),
    timeZone: typeof timeZone === "string" ? timeZone : undefined,
  }).rfq;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({ text: "" }));
  const { text: rawText, durationDays, structured, fields } = body ?? {};

  // TAP-TO-BUILD path (F2): a fully-structured request skips the LLM profiler
  // entirely - the panel already knows every field. Zero tokens, instant.
  if (structured === true && fields && typeof fields === "object") {
    const session = await getSession();
    const rfq = applyWindow(deterministicRFQ(fields), session?.plan, body?.timeZone);
    await sbInsert("searches", [
      {
        user_email: session?.email ?? null,
        query_text: "(built with the request panel)",
        vehicle_class: rfq.vehicleClass,
        source: "panel",
        results: 0,
      },
    ]);
    return NextResponse.json({ rfq, aiEnabled: await aiEnabled() });
  }

  if (!rawText || typeof rawText !== "string" || rawText.trim().length < 3) {
    return NextResponse.json(
      { error: "Describe the vehicle you want (at least a few words)." },
      { status: 400 }
    );
  }
  // This route is intentionally open (search before signup), so CAP the input
  // that reaches the LLM - an uncapped body is a cost/DoS vector (a 1 MB prompt
  // per call). A real request is a sentence; 600 chars is generous headroom.
  const text = rawText.slice(0, 600);
  // The session identity powers the stable per-user voice persona, so this
  // user's first message always sounds like the same distinct human.
  const session = await getSession();
  const rfq = applyWindow(
    await runProfiler(text, durationDays, session?.email),
    session?.plan,
    body?.timeZone
  );
  await sbInsert("searches", [
    {
      user_email: session?.email ?? null,
      query_text: text.slice(0, 500),
      vehicle_class: rfq.vehicleClass,
      source: "profiler",
      results: 0,
    },
  ]);

  return NextResponse.json({ rfq, aiEnabled: await aiEnabled() });
}

// maxDuration: lift the request-timeout ceiling for slow AI/WhatsApp upstreams.
export const maxDuration = 60;
