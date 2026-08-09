// THE DISPATCHER - the fallback ladder, and the flush that makes a popular
// agency cheap. Plan Part 12.2.2 and 12.2.3.
//
// One lead, one decision, and a named outcome for every branch. Nothing here is
// allowed to drop a lead silently: Part 5.5 established that a shop dropped
// before the loop is counted nowhere and cannot be explained to the traveller,
// and that finding is the reason `held` is a real state rather than a queue
// nobody can see.
//
// THE LADDER, in order, first applicable wins:
//
//   1. Service window open  -> free-form. Free, uncapped, outside the tier.
//   2. Template allowed     -> template. Costs money and a cap slot.
//   3. Otherwise            -> HELD, waiting for the agency to open the window.
//   4. Hold times out       -> the legacy path, if the flag permits it.
//   5. Nothing left         -> honest refusal with a reason and a retry time.
//
// Rung 4 is why the old engine stays in the codebase rather than being deleted.
// It is not a migration artefact: constraint 1 (absolute shop choice) says a
// traveller who picks a shop gets that shop contacted, and an agency our
// business number cannot reach still has to be reachable somehow.

import "server-only";
import { wabaConfig } from "./config";
import { wabaSend } from "./send";
import {
  admitLead,
  advanceLead,
  createLead,
  heldLeadsFor,
  markTemplateCapped,
  markTemplateSent,
  noteWabaEvent,
  openWindow,
  type Lead,
} from "./leads";
import { nationalTail } from "../wa/phone-key";

export interface DispatchOutcome {
  leadId: number | null;
  /** What actually happened, in a word the console and the UI can both use. */
  outcome: "sent" | "held" | "refused" | "fallback-legacy";
  lane?: "template" | "freeform";
  reason: string;
  /** Shown to the traveller. Never a mechanism, never a bare failure. */
  userMessage: string;
  preview?: string;
}

/**
 * The traveller's language for each outcome.
 *
 * Constraint 5 governs: no "ban", "restricted", "blocked" or "risk" anywhere
 * outside the linking/consent screen. These describe what is happening to their
 * enquiry, not what is happening to our messaging account - which is our problem
 * and not theirs.
 */
const USER_COPY = {
  sent: "We have asked {shop} to message you directly.",
  held: "Waiting for {shop} to open the conversation.",
  fallback: "Contacting {shop} the usual way instead.",
  refused: "We could not reach {shop} just now - we will try again shortly.",
} as const;

const say = (t: string, shop: string) => t.replace("{shop}", shop || "the shop");

/**
 * Compose the first-contact template variables.
 *
 * The traveller's number is NOT in the body - it rides in the button target, so
 * the agency taps rather than transcribes. That removes the friction that would
 * otherwise make this design's reply rate WORSE than cold contact: we are
 * replacing "a traveller messages you" with "a middleman asks you to go message
 * a stranger", and the second is more work unless we delete the work.
 */
export function templateVariables(o: {
  agencyName?: string | null;
  vehicle: string;
  dates: string;
}): string[] {
  return [o.agencyName?.trim() || "there", o.vehicle, o.dates];
}

export interface DispatchInput {
  userEmail: string;
  agencyNumber: string;
  agencyName?: string;
  sessionId?: string;
  vehicle: string;
  dates: string;
  language?: string;
  /** Rendered by the caller for the free-form lane - informal is fine here. */
  freeformText: string;
}

/**
 * Dispatch one handoff.
 *
 * Never throws. This runs inside batch loops against an asset shared by every
 * user at once; a throw takes the loop down for everybody.
 */
export async function dispatchHandoff(input: DispatchInput): Promise<DispatchOutcome> {
  const shop = input.agencyName ?? "";
  const c = await wabaConfig();
  if (!c.enabled) {
    // Not an error and not a refusal - the official path simply is not the live
    // path. The caller takes the legacy route exactly as it does today.
    return {
      leadId: null,
      outcome: "fallback-legacy",
      reason: "flag-off",
      userMessage: say(USER_COPY.fallback, shop),
    };
  }

  const admission = await admitLead(input.agencyNumber);
  if ("refuse" in admission) {
    return {
      leadId: null,
      outcome: "refused",
      reason: admission.reason,
      userMessage: say(USER_COPY.refused, shop),
    };
  }

  const lead = await createLead({
    userEmail: input.userEmail,
    agencyNumber: input.agencyNumber,
    agencyName: input.agencyName,
    sessionId: input.sessionId,
  });
  if (!lead) {
    return {
      leadId: null,
      outcome: "refused",
      reason: "lead-write-failed",
      userMessage: say(USER_COPY.refused, shop),
    };
  }

  if ("hold" in admission) {
    // HELD, not dropped. The agency is contactable, just not right now - and the
    // moment it answers anyone, `flushHeldLeads` releases this one for free.
    await advanceLead(lead.id, "held", { terminal_reason: null });
    await noteWabaEvent("held", { leadId: lead.id, agencyTail: lead.agency_tail, raw: { reason: admission.reason } });
    return {
      leadId: lead.id,
      outcome: "held",
      reason: admission.reason,
      userMessage: say(USER_COPY.held, shop),
    };
  }

  return sendForLead(lead, admission.lane, input);
}

/** The send itself, shared by the first attempt and by the window flush. */
export async function sendForLead(
  lead: Lead,
  lane: "template" | "freeform",
  input: Pick<DispatchInput, "vehicle" | "dates" | "language" | "freeformText" | "agencyName">
): Promise<DispatchOutcome> {
  const c = await wabaConfig();
  const shop = input.agencyName ?? lead.agency_name ?? "";

  const result =
    lane === "freeform"
      ? await wabaSend({ lane: "freeform", to: lead.agency_number, text: input.freeformText })
      : await wabaSend({
          lane: "template",
          to: lead.agency_number,
          templateName: c.templateFirstContact,
          language: input.language ?? "en",
          variables: templateVariables({
            agencyName: input.agencyName ?? lead.agency_name,
            vehicle: input.vehicle,
            dates: input.dates,
          }),
          buttonSuffix: lead.link_token ?? "",
        });

  await noteWabaEvent("send", {
    leadId: lead.id,
    agencyTail: lead.agency_tail,
    errorCode: result.errorCode,
    raw: { lane, ok: result.ok, dryRun: result.dryRun, error: result.error },
  });

  if (result.ok) {
    await advanceLead(lead.id, lane === "template" ? "template_sent" : "handoff_sent", {
      lane,
      sent_at: new Date().toISOString(),
      preview: result.preview,
    });
    if (lane === "template") await markTemplateSent(lead.agency_tail, lead.agency_number);
    return {
      leadId: lead.id,
      outcome: "sent",
      lane,
      reason: result.dryRun ? "dry-run" : "ok",
      userMessage: say(USER_COPY.sent, shop),
      preview: result.preview,
    };
  }

  // 131049: the recipient has hit their per-user marketing cap across ALL
  // businesses. Not our failure and not retryable - record the cap so the
  // governor stops choosing this agency, and hold the lead for the window.
  if (result.recipientCapped) {
    await markTemplateCapped(lead.agency_tail);
    await advanceLead(lead.id, "held", { terminal_reason: null });
    return {
      leadId: lead.id,
      outcome: "held",
      reason: "recipient-capped",
      userMessage: say(USER_COPY.held, shop),
    };
  }

  await advanceLead(lead.id, "failed", {
    terminal_reason: result.error ?? "send-failed",
    error_code: result.errorCode ?? null,
  });
  return {
    leadId: lead.id,
    outcome: "refused",
    reason: result.error ?? "send-failed",
    userMessage: say(USER_COPY.refused, shop),
  };
}

/**
 * An agency answered us. Open the window and release everything waiting on it.
 *
 * THIS IS THE MECHANISM THAT MAKES THE DESIGN SCALE. Without it, a popular
 * agency costs one template per traveller and the per-recipient cap silently
 * eats the third one. With it, the agency costs one template per DAY and every
 * subsequent traveller rides the free lane.
 */
export async function onAgencyReplied(
  agencyNumber: string,
  render: (lead: Lead) => Pick<DispatchInput, "vehicle" | "dates" | "language" | "freeformText" | "agencyName">
): Promise<{ opened: boolean; flushed: number }> {
  const tail = nationalTail(agencyNumber);
  if (!tail) return { opened: false, flushed: 0 };

  await openWindow(tail, agencyNumber);
  await noteWabaEvent("inbound", { agencyTail: tail });

  const held = await heldLeadsFor(tail);
  let flushed = 0;
  for (const lead of held) {
    // Only leads still waiting. A lead already sent a template is waiting on the
    // AGENCY to contact the traveller, not on us to send again - re-sending
    // would double-message the agency about the same person.
    if (lead.state !== "held") continue;
    const out = await sendForLead(lead, "freeform", render(lead));
    if (out.outcome === "sent") flushed += 1;
  }
  return { opened: true, flushed };
}
