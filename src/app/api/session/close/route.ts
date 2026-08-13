import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { closeSearchSession } from "@/lib/session-close";

// Close the user's search session HARD. Called whenever the user starts a NEW
// search or clears the current one. The three guarantees (purge the outbox,
// tombstone every contacted shop, stamp the durable session-closed marker)
// live in lib/session-close.ts now, shared with the TTL stand-down - an
// expired hunt winds down exactly the way a cleared one does.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  // A CLOSE IS SCOPED TO THE SESSION IT CLOSES. The client sends the epochs
  // that bound the closing session: `from` (when it started) and `before`
  // (when the NEW session began - i.e. the close cutoff). Everything the close
  // touches is bounded by them, which makes it IDEMPOTENT and RETRY-SAFE: a
  // retried close can never tombstone a shop the new session has since queued
  // or messaged, and it never reaches back across every shop messaged in the
  // last 7 days (that over-reach is what painted six never-removed shops as
  // "REMOVED BY YOU" at the next search).
  const body = (await req.json().catch(() => ({}))) as { from?: number; before?: number };
  const { purged } = await closeSearchSession(session.email, {
    fromMs: Number.isFinite(body.from) ? Number(body.from) : undefined,
    beforeMs: Number.isFinite(body.before) ? Number(body.before) : undefined,
    reason: "user",
  });

  return NextResponse.json({ ok: true, purged });
}

// maxDuration: lift the request-timeout ceiling for slow upstreams.
export const maxDuration = 60;
