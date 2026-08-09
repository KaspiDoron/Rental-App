// THE NARROW EXCEPTION - and it is narrow on purpose.
//
// This is the single hardest conflict between the business-number handoff and
// the app as it stands, and it is worth stating in full because a future edit
// that does not understand it will "fix" the wrong side.
//
// Task #67 (privacy isolation) and task #85 (the leak where personal chats
// surfaced as shop replies) exist to guarantee ONE thing: the app never ingests
// an inbound WhatsApp message from a number the traveller's own agent did not
// message first. `isVendorThread` enforces it with an RFQ anchor - "ever sent
// them something" is deliberately not enough, because a mistyped number or a
// stray manual reply must not turn a personal contact into a permanent
// ingestion target. That gate is correct and it is load-bearing.
//
// The handoff inverts the direction. Our official number asks the agency to
// message the traveller, so the FIRST message in that thread is inbound, from a
// number the traveller has never written to. Under the existing gate it is
// dropped - correctly, by a rule that has no way to know we asked for it.
//
// THE RESOLUTION IS A PRE-AUTHORISED EXPECTATION, NOT A LOOSER GATE.
//
// When a handoff is dispatched we already write a lead row naming exactly which
// traveller is expecting exactly which agency. That row IS the authorisation.
// The gate admits an unknown inbound only when it matches a live lead, and
// everything else stays rejected on the original rules.
//
// Four properties make this safe, and each is pinned by a test:
//
//   1. SCOPED to one (traveller, agency) pair. It authorises nothing else.
//   2. EXPIRING. A lead older than the TTL stops authorising anything, so a
//      handoff from last month cannot re-open ingestion.
//   3. ADDITIVE. It can only ever turn a "no" into a "yes" for a number we
//      asked to be contacted. It cannot relax the RFQ anchor, the recency rule
//      or the drill window for any other number.
//   4. FLAG-GATED. With WABA_ENABLED off this module never runs and the gate is
//      byte-identical to today. We do not dispatch handoffs when the flag is
//      off, so there is nothing to authorise.
//
// It is NOT implemented by editing the existing predicate's rules. That
// distinction is the whole safety argument: the original gate keeps its exact
// semantics, and this sits beside it as a separately-auditable allowance.

import "server-only";
import { getConfig, sbSelectStrict } from "../runtime-config";
import { nationalTail } from "../wa/phone-key";
import { wabaConfig } from "./config";

/**
 * How long a dispatched handoff keeps authorising inbound from that agency.
 *
 * Long enough that a shop replying the next morning still lands (agencies are
 * not always at the desk), short enough that it is a window rather than a
 * standing permission. Once the traveller's agent answers there is a real
 * outbound row and the ORIGINAL gate takes over on its own terms - so this only
 * has to cover the span between the agency's first message and our first reply.
 */
export const EXPECTATION_TTL_HOURS_DEFAULT = 72;

export async function expectationTtlHours(): Promise<number> {
  const raw = Number(await getConfig("WABA_EXPECTATION_TTL_HOURS"));
  return Number.isFinite(raw) && raw > 0 ? raw : EXPECTATION_TTL_HOURS_DEFAULT;
}

/**
 * Did we ask this agency to contact this traveller, recently enough to still
 * be expecting it?
 *
 * Returns:
 *   true  - a live lead authorises this inbound
 *   false - no authorisation (the caller keeps whatever verdict it had)
 *   null  - could not read. The caller must treat this as RETRYABLE, never as
 *           "not authorised": swallowing a genuine handoff reply on our own
 *           outage is a permanent loss, because the webhook's 200 means the
 *           provider never redelivers. Same reasoning as the existing gate's
 *           null contract, deliberately mirrored so the two behave alike.
 */
export async function wabaExpectsInbound(
  fromDigits: string,
  ownerEmail: string,
  now = Date.now()
): Promise<boolean | null> {
  // The flag first, and cheaply. With the handoff off we never dispatched a
  // lead, so there is nothing this could authorise - and skipping the read
  // keeps the "nothing changes while the flag is off" invariant literal: no new
  // table is touched.
  const c = await wabaConfig();
  if (!c.enabled) return false;

  const tail = nationalTail(fromDigits);
  if (!tail) return false;

  const cutoff = new Date(now - (await expectationTtlHours()) * 3600_000).toISOString();
  const read = await sbSelectStrict<{ id: number }>(
    "waba_leads",
    // Only leads we actually DISPATCHED authorise anything. A `draft` lead has
    // not been sent, and a `failed`/`expired` one was never handed to the
    // agency - neither is a reason to expect a message.
    `select=id&user_email=eq.${encodeURIComponent(
      ownerEmail.trim().toLowerCase()
    )}&agency_tail=eq.${encodeURIComponent(
      tail
    )}&state=in.(template_sent,handoff_sent,handed_off)&created_at=gte.${encodeURIComponent(
      cutoff
    )}&limit=1`
  );
  if ("error" in read) {
    // "missing" = the handoff tables have never been created, so no handoff was
    // ever dispatched: honestly not authorised. "unavailable" = our outage.
    return read.error === "missing" ? false : null;
  }
  return read.rows.length > 0;
}
