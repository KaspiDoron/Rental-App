import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { CONSENT_KINDS, recordConsent, stampTermsVersion, type ConsentKind } from "@/lib/consent";
import { TERMS_VERSION } from "@/lib/legal";
import { finishBeforeResponse } from "@/lib/after";

export const dynamic = "force-dynamic";

// ONE ENDPOINT FOR EVERY ACCEPTANCE.
//
// Three surfaces collected a consent and none of them recorded it: the first
// app entry (which did not exist), the WhatsApp linking release (a modal you
// closed) and the booking sheet's deal-terms checkbox (a client-side gate on
// its own submit button). Each one now posts here, so a new acceptance surface
// cannot ship without a record - there is nowhere else to send it.
//
// The version is the SERVER's TERMS_VERSION, never the client's. A browser
// telling us which version it agreed to is a browser we would have to trust
// about the one fact the record exists to establish.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  let body: { kind?: string; context?: Record<string, unknown> } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* an empty body is a terms acceptance - the common case */
  }

  const kind = String(body.kind ?? "terms") as ConsentKind;
  if (!(CONSENT_KINDS as readonly string[]).includes(kind)) {
    return NextResponse.json({ error: "Unknown consent." }, { status: 400 });
  }

  // The write is a durable side effect, so it goes through finishBeforeResponse
  // like every other one: on Cloud Run the CPU is throttled to ~0 the moment
  // this response flushes, and a detached insert simply never runs.
  await finishBeforeResponse("consent-record", async () => {
    await recordConsent({
      email: session.email,
      kind,
      version: TERMS_VERSION,
      context: body.context,
    });
    // The three signup consents also carry a version on the user row, which is
    // what `needsReacceptance` reads on every entry.
    if (kind === "terms" || kind === "wa_risk" || kind === "ai_responsibility") {
      await stampTermsVersion(session.email, TERMS_VERSION);
    }
  });

  return NextResponse.json({ ok: true, version: TERMS_VERSION });
}
