import { NextResponse } from "next/server";
import { sbSelectStrict, sbUpdate } from "@/lib/runtime-config";
import { noteWabaEvent } from "@/lib/waba/leads";
import { wabaConfig } from "@/lib/waba/config";
import { digitsOnly } from "@/lib/phone";
import { prefilledOpener } from "@/lib/waba/render";

export const dynamic = "force-dynamic";

// THE HANDOFF LINK - one tap, and the only honest engagement signal we have.
//
// The template's call-to-action points at THIS route rather than straight at
// wa.me, and that indirection is not a workaround - it buys four things:
//
//   1. It is permitted. `wa.me` links and URL shorteners are named
//      template-rejection causes, so a template pointing directly at a chat
//      would never have been approved. A full domain URL is fine.
//   2. It removes the agency's work entirely. One tap opens a chat with the
//      traveller - no number to save, no number to type. That matters more than
//      it sounds: this design replaces "a traveller messages you" with "a
//      middleman asks you to go message a stranger", and unless the work is
//      deleted the reply rate could easily land BELOW cold contact.
//   3. It is the tap ledger. Delivered and read tell you the message arrived;
//      only a tap tells you it worked. No other surface in this product has
//      that signal, and Part 11's agency scanner should consume it.
//   4. It fixes attribution. The prefilled text is authored by us, so when the
//      agency's message lands on the traveller's phone it carries a phrase our
//      ingest can recognise - which is what covers the common case of an agency
//      replying from a staff mobile rather than the listed number.
//
// The token is opaque and carries no phone number, because anyone who receives
// a forwarded template can tap this.

interface LeadRow {
  id: number;
  user_email: string;
  agency_name: string | null;
  link_tapped_at: string | null;
  state: string;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const c = await wabaConfig();

  // A token nobody can act on must not leak whether it ever existed. Every
  // failure below lands on the same neutral page.
  const dead = () => NextResponse.redirect(new URL("/", process.env.APP_DOMAIN ?? "https://wheeldeal.pro"));

  if (!token || token.length < 12) return dead();

  // THE FLAG WAS READ AND THROWN AWAY. `const c = await wabaConfig()` sat at
  // the top of this handler and the only use of it was `void c;` at the bottom
  // - a deliberate silencing of the unused-variable warning that read as "the
  // config is considered here". It was not. With WABA_ENABLED off, every
  // handoff link ever minted still resolved: it still stamped link_tapped_at,
  // still recorded a `tap` event into the ledger, and still redirected a real
  // agency into a real chat with a real traveller.
  //
  // A lane that is off has no live links. Checked BEFORE the lead read so a
  // switched-off deployment does not even confirm whether a token exists.
  if (!c.enabled) return dead();

  const read = await sbSelectStrict<LeadRow & { user_phone?: string }>(
    "waba_leads",
    `select=id,user_email,agency_name,link_tapped_at,state&link_token=eq.${encodeURIComponent(
      token
    )}&limit=1`
  );
  if ("error" in read || !read.rows.length) return dead();
  const lead = read.rows[0];

  // The traveller's number lives on their account, never in the token and never
  // in the URL - so a forwarded link cannot be mined for phone numbers by
  // anyone who does not already hold a valid lead token.
  const { getUser } = await import("@/lib/access");
  const user = await getUser(lead.user_email);
  const to = digitsOnly(user?.phone ?? "");
  if (!to) return dead();

  // Write-once: the FIRST tap is the signal. Re-stamping on every open would
  // turn "did this work" into "how often did someone re-open the chat", which
  // is a different and much less useful question.
  if (!lead.link_tapped_at) {
    await sbUpdate("waba_leads", `id=eq.${lead.id}&link_tapped_at=is.null`, {
      link_tapped_at: new Date().toISOString(),
    }).catch(() => false);
    await noteWabaEvent("tap", { leadId: lead.id });
  }

  const text = encodeURIComponent(prefilledOpener(lead.agency_name));
  // Inside a normal message wa.me is entirely fine - only TEMPLATES restrict it.
  const target = `https://wa.me/${to}?text=${text}`;
  return NextResponse.redirect(target, 302);
}
