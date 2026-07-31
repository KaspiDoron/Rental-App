import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sendPushToUser } from "@/lib/push";

/**
 * SEND A REAL PUSH, AND SAY WHAT HAPPENED.
 *
 * "Alerts on" was a server-side aggregate ("some row exists") that could be
 * true while every registered endpoint rejected - which is exactly what the
 * field test hit: the toggle said on, no notification ever arrived, and there
 * was no way for the traveller OR the owner to tell those two apart. This
 * endpoint is the difference: it pushes for real and reports per-device
 * outcomes, pruning whatever the push service says is dead.
 */
export async function POST() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const outcome = await sendPushToUser(session.email, {
    title: "WheelDeal alerts are working",
    body: "This is a test - real shop replies will look like this.",
    url: "/",
    tag: "wheeldeal-test",
  });
  return NextResponse.json({
    attempted: outcome.attempted,
    delivered: outcome.delivered,
    pruned: outcome.pruned,
    reason: outcome.reason ?? null,
    // Endpoints are long and device-identifying; the STATUS is what a human
    // needs, so only the outcome shape crosses the wire.
    results: outcome.results.map((r) => ({ ok: r.ok, status: r.status ?? null, error: r.error ?? null })),
  });
}
