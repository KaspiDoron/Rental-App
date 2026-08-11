import { NextResponse } from "next/server";
import { runProfiler, deterministicRFQ } from "@/lib/agents";
import { runWithAiBudget } from "@/lib/ai-budget";
import { aiEnabled } from "@/lib/ai";
import { getSession } from "@/lib/session";
import { sbInsert } from "@/lib/runtime-config";
import { addDays, clampRfqWindow } from "@/lib/rental-window";
import type { StructuredRFQ } from "@/lib/types";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The traveller's chosen pickup date, if they sent a real one. */
function requestedStart(v: unknown): string | undefined {
  return typeof v === "string" && ISO_DATE.test(v) ? v : undefined;
}

// THE SAME AUTHORITY, AT THE START OF THE FUNNEL. Without this the opener asked
// twenty shops about a start date the traveller's plan cannot arrange - twenty
// real conversations built on a promise the app would refuse at the close.
// Adjusting up front is kinder than refusing at the end, and it is the same
// decision function every other surface calls (lib/rental-window).
//
// W-7: IT ALSO REPORTS WHAT IT DID. `clampRfqWindow` has always returned
// `{adjusted, reason}` and this function threw both away, so the server could
// move a traveller's pickup date and the only trace was a different date in the
// picker with no sentence attached to it. The decision now travels with the RFQ.
function applyWindow(
  rfq: StructuredRFQ,
  plan: string | null | undefined,
  timeZone: unknown
): { rfq: StructuredRFQ; adjusted: boolean; reason?: string } {
  return clampRfqWindow(rfq, {
    plan,
    nowMs: Date.now(),
    timeZone: typeof timeZone === "string" ? timeZone : undefined,
  });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({ text: "" }));
  const { text: rawText, durationDays, structured, fields } = body ?? {};

  // TAP-TO-BUILD path (F2): a fully-structured request skips the LLM profiler
  // entirely - the panel already knows every field. Zero tokens, instant.
  if (structured === true && fields && typeof fields === "object") {
    const session = await getSession();
    const decided = applyWindow(deterministicRFQ(fields), session?.plan, body?.timeZone);
    const rfq = decided.rfq;
    await sbInsert("searches", [
      {
        user_email: session?.email ?? null,
        query_text: "(built with the request panel)",
        vehicle_class: rfq.vehicleClass,
        source: "panel",
        results: 0,
      },
    ]);
    return NextResponse.json({
      rfq,
      windowAdjusted: decided.adjusted,
      windowReason: decided.reason ?? null,
      aiEnabled: await aiEnabled(),
    });
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
  // The profiler is an LLM call and was ungoverned. Over-cap it falls back to
  // heuristicRFQ - the same deterministic path it already uses when no provider
  // key is configured or the 9s budget expires - so the search still runs.
  const profiled = await runWithAiBudget(session?.email ?? "", () =>
    runProfiler(text, durationDays, session?.email)
  );
  // W-7: THE WINDOW CONTROL WINS OVER THE PARSE, WHEN THERE IS ONE.
  //
  // `durationDays` was already destructured here and handed to the profiler as
  // a hint - by a client that had never sent it, because the only date control
  // in the app lived inside the tap builder. Now that the window is a page-level
  // control shown in both modes, an explicit pickup date is a statement, not a
  // hint: it overrides whatever the profiler inferred from prose, and the return
  // date moves with it so the trip keeps the length the traveller asked for.
  // The page sends these ONLY when the traveller actually set them, so a request
  // that says "from the 20th" and never touches the picker still parses.
  const start = requestedStart(body?.startDate);
  const withWindow: StructuredRFQ = start
    ? {
        ...profiled,
        startDate: start,
        returnDate: addDays(start, profiled.durationDays),
      }
    : profiled;
  const decided = applyWindow(withWindow, session?.plan, body?.timeZone);
  const rfq = decided.rfq;
  await sbInsert("searches", [
    {
      user_email: session?.email ?? null,
      query_text: text.slice(0, 500),
      vehicle_class: rfq.vehicleClass,
      source: "profiler",
      results: 0,
    },
  ]);

  return NextResponse.json({
    rfq,
    windowAdjusted: decided.adjusted,
    windowReason: decided.reason ?? null,
    aiEnabled: await aiEnabled(),
  });
}

// maxDuration: lift the request-timeout ceiling for slow AI/WhatsApp upstreams.
export const maxDuration = 60;
