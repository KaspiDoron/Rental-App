import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { connectInstance, evolutionConfigured } from "@/lib/evolution";
import { trustedRequestOrigin } from "@/lib/request-origin";
import { resolveSiteOrigin } from "@/lib/site";
import { finishBeforeResponse } from "@/lib/after";

// Start (or resume) the signed-in user's personal WhatsApp session: creates
// the Evolution instance and returns a QR code to scan from the Profile page.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  if (!(await evolutionConfigured())) {
    return NextResponse.json({
      available: false,
      error:
        "The WhatsApp connector is not set up yet (owner: add EVOLUTION_API_URL + EVOLUTION_API_KEY in Admin -> Keys).",
    });
  }

  // Proxy-aware AND allow-listed. The forwarded host is the real public one on
  // Cloud Run, but it is also client input, and this origin ends up REGISTERED
  // ON EVOLUTION as `<origin>/api/webhooks/evolution?token=<webhookToken>`. Any
  // signed-in user sending `x-forwarded-host: theirs.example` could therefore
  // hand out the webhook token and redirect every shop reply on this instance
  // to their server. trustedRequestOrigin only answers for hosts the OWNER
  // controls; anything else falls back to the canonical site origin, which
  // connectInstance canonicalizes again (APP_DOMAIN wins) regardless.
  const origin = (await trustedRequestOrigin(req)) ?? (await resolveSiteOrigin());
  const body = await req.json().catch(() => ({}));
  // Pairing code needs the user's WhatsApp number - prefer the one they typed
  // now, else the phone on their profile.
  const { getUser, registerUser } = await import("@/lib/access");
  const profile = await getUser(session.email);
  const typed = String(body.phone ?? "").trim();
  const phone = typed || profile?.phone;
  // Persist the number the user links with to their account, so it survives
  // across sessions and is never lost between logins (durable in app_users).
  if (typed && typed !== profile?.phone) {
    await registerUser({
      email: session.email,
      phone: typed,
      name: profile?.name,
      provider: profile?.provider ?? "email",
      acceptedTerms: true,
    }).catch(() => {});
  }
  // fresh=true is an EXPLICIT user "Try again / new code" tap. It is handed to
  // connectInstance as permission to rebuild, NOT executed here.
  //
  // This used to call resetInstance() first, which wrote status "disconnected"
  // and therefore made connectInstance's `existing === "connecting"` guard
  // unreachable - so EVERY refresh took the destructive logout+delete+recreate
  // path and wiped whatever handshake the user's phone was completing. Combined
  // with the client's automatic 55s code-expiry refresh that meant up to four
  // full instance rebuilds per pairing (~3.7 min of self-inflicted churn), which
  // both broke the pairing and hammered the Evolution container. connectInstance
  // now re-issues the code on the SAME instance instead.
  // PER LINKING EVENT, not once at signup. The WhatsApp release (WaTermsModal)
  // is the heaviest document in the product - it is the one that says the user
  // may lose their number - and it was a modal you closed. Nothing recorded
  // that anyone had seen it, for any link, ever.
  //
  // A link request IS the acceptance: the release is on screen and the UI does
  // not offer this button without it. Recorded here rather than from the
  // browser so the proof does not depend on a client call that can simply not
  // be made. `fresh` retries re-issue a code on the same instance and are not
  // new acceptances.
  //
  // BEFORE THE CODE, NOT AFTER, AND IT CAN REFUSE.
  //
  // This used to run after `connectInstance`, awaited only for the response
  // boundary - so a failed write happened when the QR had already been minted
  // and there was nothing left to withhold. The one consent whose subject
  // matter is the permanent loss of someone's phone number was therefore the
  // one we were least able to prove.
  //
  // Now it gates: the write retries, and if it still cannot be recorded we do
  // not hand out a pairing code at all. Refusing to link is a bad afternoon;
  // linking against an acceptance nobody can produce is the thing the whole
  // consent ledger exists to prevent.
  if (body.fresh !== true) {
    const { recordConsentBlocking } = await import("@/lib/consent");
    const recorded = await recordConsentBlocking({
      email: session.email,
      kind: "wa_link",
      // The number that carries the risk. Last four only - the full number is
      // already on the user row and a ledger does not need a second copy.
      context: { phoneTail: String(phone ?? "").slice(-4) || null },
    });
    if (!recorded) {
      return NextResponse.json(
        {
          available: true,
          error:
            "We could not save your acceptance just now, so we have not started the connection. Please try again in a moment.",
        },
        { status: 503 }
      );
    }
  }

  // fresh=true is an EXPLICIT user "Try again / new code" tap.
  const result = await connectInstance(session.email, origin, phone, {
    fresh: body.fresh === true,
  });

  return NextResponse.json({ available: true, phoneUsed: phone ?? null, ...result });
}

// maxDuration: lift the request-timeout ceiling for slow upstreams.
export const maxDuration = 60;
