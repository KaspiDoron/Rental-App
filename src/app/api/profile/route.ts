import { NextResponse } from "next/server";
import { runProfiler, deterministicRFQ } from "@/lib/agents";
import { runWithAiBudget } from "@/lib/ai-budget";
import { aiEnabled } from "@/lib/ai";
import { getSession } from "@/lib/session";
import { sbInsert } from "@/lib/runtime-config";
import { clampRfqWindow, deriveReturnDate } from "@/lib/rental-window";
import type { StructuredRFQ } from "@/lib/types";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The traveller's chosen pickup date, if they sent a real one. */
function requestedStart(v: unknown): string | undefined {
  return typeof v === "string" && ISO_DATE.test(v) ? v : undefined;
}

/** The traveller's chosen day count, if they sent a sane one (picker is 1-90). */
function requestedDays(v: unknown): number | undefined {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 90 ? n : undefined;
}

/**
 * WHICH HALF OF THE WINDOW THE TRAVELLER ACTUALLY TOUCHED (W9).
 *
 * The client always sends the window it is SHOWING - that is the whole point,
 * the on-screen card is what the traveller believes they searched - and marks
 * each control independently as touched or not. Untouched is a default the
 * traveller merely saw, so it fills a gap but never overrules their own words;
 * touched is a statement and always wins.
 *
 * One shared flag for both controls is what made this unfixable before: any tap
 * on the date picker promoted the untouched 4-day default into an explicit
 * override, so "scooter for a week from the 20th" plus one date tap shipped a
 * 4-day rental - and the mismatch note could not fire, because the app had
 * asked for 4 and got 4.
 */
function explicitWindow(v: unknown): { startDate: boolean; durationDays: boolean } {
  // NO FLAGS = THE OLD CONTRACT, WHICH WAS "only sent when touched". A client
  // running a cached bundle still gets its window honoured as an override
  // rather than quietly demoted to a fallback mid-deploy.
  if (!v || typeof v !== "object") return { startDate: true, durationDays: true };
  const o = v as { startDate?: unknown; durationDays?: unknown };
  return { startDate: o.startDate === true, durationDays: o.durationDays === true };
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
  const explicit = explicitWindow(body?.windowExplicit);
  const start = requestedStart(body?.startDate);
  const days = requestedDays(durationDays);
  const profiled = await runWithAiBudget(session?.email ?? "", () =>
    // The hint is the traveller's STATEMENT (touched), the default is what their
    // screen was showing (untouched). Both are the same number on the wire; only
    // `windowExplicit` says which of the two it is.
    runProfiler(text, explicit.durationDays ? days : undefined, session?.email, days)
  );
  // W-7 / W4.1: THE WINDOW CONTROL WINS OVER THE PARSE - BOTH HALVES OF IT.
  //
  // W-7 made the explicit pickup DATE override the profiler, and its comment
  // claimed the duration travelled with it - it did not. Only startDate was
  // overridden; `durationDays` stayed whatever the LLM read (or invented) from
  // prose, and the return date was computed FROM that unoverridden value. A
  // traveller who picked 3 days got openers saying "from 16 Aug until 17 Aug"
  // because the model guessed 1 (owner report 5 #2/#7). The doctrine: explicit
  // traveller input always beats LLM inference - date AND duration alike - and
  // the return date is derived arithmetic (start + days) by the one writer in
  // lib/rental-window, never a parse of its own.
  //
  // W9: THE WINDOW ON THE WIRE IS THE WINDOW ON THE SCREEN - ALWAYS.
  //
  // The page used to send neither field unless the traveller touched the
  // control, so the DEFAULT search - type a sentence, press the button - sent no
  // start date and no duration at all. The profiler then had nothing to work
  // with: no date reached the RFQ (deriveReturnDate and clampRfqWindow both
  // no-op without one) and the duration fell to a hard-coded 3, while the card
  // above the button said "From today - For 4 days". Twenty shops were asked
  // about a rental the traveller had never seen described anywhere.
  //
  // Both halves now travel on every typed search, and `windowExplicit` says
  // which of them the traveller actually set. An untouched control is a
  // FALLBACK - it fills what the prose left unsaid ("I need a scooter") and
  // yields to what the prose states ("from the 20th for a week"). A touched one
  // is an override and wins outright. The duration's fallback is applied inside
  // the profiler, which is the only layer that knows whether prose stated a
  // length at all.
  const withWindow: StructuredRFQ = deriveReturnDate({
    ...profiled,
    ...(start && (explicit.startDate || !profiled.startDate) ? { startDate: start } : {}),
    ...(days && explicit.durationDays ? { durationDays: days } : {}),
  });
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
