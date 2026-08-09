import "server-only";

// PROOF, NOT PRESENCE.
//
// The legal text was complete and the checkboxes were mandatory, and yet the
// only thing the system could actually PROVE was that a user had ticked
// something, once, at signup:
//
//   - `app_users.terms_version` exists in the schema and nothing ever wrote it,
//     so bumping TERMS_VERSION changed the document under everyone's feet with
//     no re-acceptance and no record of which version anyone agreed to.
//   - the WhatsApp linking release (WaTermsModal) was a modal you closed. Every
//     link, relink and number change went unrecorded.
//   - the booking sheet's "I understand the deal terms" checkbox gated its own
//     submit button on the CLIENT and was never sent anywhere.
//
// A consent nobody recorded is a consent you cannot rely on when it matters,
// which is the only moment consent is for. This module is the one place a
// consent is written, so a new acceptance surface cannot ship without a record
// again.
//
// ALMOST EVERY WRITE IS BEST-EFFORT AND NEVER BLOCKS THE USER'S ACTION. A
// database hiccup must not stop someone closing a deal; the ledger is an audit
// trail, not a gate. The gate is `needsReacceptance`, which is a pure function
// of data we already have.
//
// THE EXCEPTION IS `wa_link`, and it is the one that matters most. Its subject
// matter is the permanent loss of the user's phone number, so a wobble there
// means the link happens with no provable record that anyone accepted that
// risk - which is exactly the moment a record exists for. That kind retries,
// and the linking path calls `recordConsentBlocking` and refuses to hand out a
// QR or pairing code when it still cannot be recorded.

import { sbInsert, sbSelect, sbUpdate } from "./runtime-config";
import { TERMS_VERSION } from "./legal";

/**
 * Everything a user can accept, in one vocabulary.
 *
 * The first three are the signup consents and additionally stamp their own
 * durable column on `app_users` (they predate this ledger). The last two are
 * per-EVENT: a person links WhatsApp more than once and books more than once,
 * and each of those is its own acceptance at its own moment.
 */
export const CONSENT_KINDS = [
  "terms",
  "wa_risk",
  "ai_responsibility",
  // Sharing the traveller's own phone number with a rental agency so the agency
  // can message THEM. New personal-data disclosure, so it gets its own
  // recorded acceptance rather than riding inside the general terms.
  "number_sharing",
  "wa_link",
  "deal_terms",
] as const;

export type ConsentKind = (typeof CONSENT_KINDS)[number];

/** The breadcrumb kind a lost ledger row falls back to. On `agent_events`,
 *  which exists on every database this app has ever had. */
export const UNRECORDED_KIND = "consent-unrecorded";

export interface ConsentEvent {
  kind: ConsentKind;
  version: string;
  at: number;
  context?: Record<string, unknown>;
  /** True when this came from the fallback breadcrumb rather than the ledger -
   *  the acceptance is real, the durable record was not written. */
  degraded?: boolean;
}

/**
 * Does this user have to accept again?
 *
 * TRUE when they have never accepted, and true when the version they accepted
 * is not the version we are now serving. A missing `termsVersion` on a user who
 * HAS accepted is the pre-ledger population: they agreed to something, we just
 * cannot say what, so they are asked once and then recorded properly.
 *
 * Pure, because this decides whether an app entry is blocked and that decision
 * must be testable without a database.
 */
export function needsReacceptance(
  user: { termsAcceptedAt?: number; termsVersion?: string } | null | undefined,
  current: string = TERMS_VERSION
): boolean {
  if (!user?.termsAcceptedAt) return true;
  return user.termsVersion !== current;
}

/**
 * A human explanation of WHY the modal is showing, so the first-touch screen
 * does not tell a returning user they are new.
 */
export function reacceptanceReason(
  user: { termsAcceptedAt?: number; termsVersion?: string } | null | undefined,
  current: string = TERMS_VERSION
): "first-time" | "version-bump" | "none" {
  if (!user?.termsAcceptedAt) return "first-time";
  if (user.termsVersion !== current) return "version-bump";
  return "none";
}

/**
 * Write one acceptance to the durable ledger.
 *
 * Returns whether the row landed. Callers do not act on `false` - see the
 * best-effort note at the top - but the boolean lets the admin surface tell a
 * missing table from a missing consent.
 */
export async function recordConsent(input: {
  email: string;
  kind: ConsentKind;
  version?: string;
  context?: Record<string, unknown>;
}): Promise<boolean> {
  const email = String(input.email ?? "").trim().toLowerCase();
  if (!email) return false;
  const version = input.version ?? TERMS_VERSION;

  // ONE KIND IS NOT BEST-EFFORT, AND IT IS THE ONE THAT MATTERS MOST.
  //
  // Best-effort is right for five of the six: a database hiccup must not stop
  // someone closing a deal, and the acceptance is reconstructable from the
  // breadcrumb below. It is indefensible for `wa_link`, whose subject matter is
  // the permanent loss of the user's phone number. A wobble there means the
  // link happens with no provable record that anyone accepted that risk - which
  // is exactly the moment a record exists for.
  //
  // So `wa_link` retries a few times before falling back. The retry is short and
  // bounded because a linking flow is interactive: somebody is watching a
  // spinner, and this is meant to survive a blip, not an outage. The refusal
  // itself lives in the caller, via `recordConsentBlocking`.
  const attempts = input.kind === "wa_link" ? 3 : 1;
  let landed = false;
  for (let i = 0; i < attempts && !landed; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 150 * i));
    landed = await sbInsert("consent_events", [
      {
        email,
        kind: input.kind,
        version,
        context: input.context ?? null,
        accepted_at: new Date().toISOString(),
      },
    ]).catch(() => false);
  }
  if (landed) return true;

  // THE LEDGER FAILED. THE CONSENT STILL HAPPENED.
  //
  // `consent_events` is a new table, and the code that writes it can reach a
  // database where `supabase/schema.sql` has not been re-run - the insert 400s
  // and this returns false, which every caller discards. The result is the exact
  // failure this module was built to end: a person accepted something, and the
  // system cannot prove it.
  //
  // `agent_events` predates all of this and is always there, so it is where a
  // lost acceptance goes. A breadcrumb is a worse record than a ledger row - it
  // has no schema and no index - but it is a RECORD, and `consentLedger` reads
  // it back so the fallback is not write-only.
  await sbInsert("agent_events", [
    {
      kind: UNRECORDED_KIND,
      detail: JSON.stringify({
        email,
        consentKind: input.kind,
        version,
        context: input.context ?? null,
        at: new Date().toISOString(),
      }).slice(0, 2000),
    },
  ]).catch(() => false);
  return false;
}

/**
 * Record a consent and REPORT whether it is provable.
 *
 * The WhatsApp linking path calls this rather than `recordConsent`, and treats
 * `false` as a refusal: a number must not be linked against an acceptance
 * nobody can produce. Everything else stays best-effort - the difference is not
 * the write, it is what the caller is obliged to do with the answer.
 */
export async function recordConsentBlocking(input: {
  email: string;
  kind: ConsentKind;
  version?: string;
  context?: Record<string, unknown>;
}): Promise<boolean> {
  return recordConsent(input);
}

/**
 * Stamp the version alongside the signup consents.
 *
 * `terms_accepted_at` was written from the day the column existed;
 * `terms_version` never was, which is what made a version bump silent. Written
 * separately from `mirror()` in access.ts so an older database missing the
 * column fails only this write instead of the whole user upsert.
 */
export async function stampTermsVersion(
  email: string,
  version: string = TERMS_VERSION
): Promise<boolean> {
  const who = String(email ?? "").trim().toLowerCase();
  if (!who) return false;
  return sbUpdate(
    "app_users",
    `email=eq.${encodeURIComponent(who)}`,
    { terms_version: version, terms_accepted_at: new Date().toISOString() }
  ).catch(() => false);
}

/**
 * One user's acceptance history, newest first - the admin proof view.
 *
 * Reads BOTH sources. An empty ledger and a ledger the writes never reached
 * look identical from a table read, and the difference is the whole question
 * this view is asked. The breadcrumbs are merged in flagged `degraded` so the
 * fallback in `recordConsent` is not write-only.
 */
export async function consentLedger(email: string, limit = 50): Promise<ConsentEvent[]> {
  const who = String(email ?? "").trim().toLowerCase();
  if (!who) return [];
  const cap = Math.max(1, Math.min(200, limit));

  const [rows, crumbs] = await Promise.all([
    sbSelect<{
      kind: string;
      version: string | null;
      context: Record<string, unknown> | null;
      accepted_at: string;
    }>(
      "consent_events",
      `select=kind,version,context,accepted_at&email=eq.${encodeURIComponent(
        who
      )}&order=accepted_at.desc&limit=${cap}`
    ).catch(() => []),
    sbSelect<{ detail: string; created_at: string }>(
      "agent_events",
      `select=detail,created_at&kind=eq.${UNRECORDED_KIND}&order=created_at.desc&limit=200`
    ).catch(() => []),
  ]);

  const fromLedger: ConsentEvent[] = rows
    .filter((r) => (CONSENT_KINDS as readonly string[]).includes(r.kind))
    .map((r) => ({
      kind: r.kind as ConsentKind,
      version: r.version ?? "",
      at: Date.parse(r.accepted_at) || 0,
      context: r.context ?? undefined,
    }));

  const fromCrumbs: ConsentEvent[] = [];
  for (const c of crumbs) {
    try {
      const d = JSON.parse(c.detail) as {
        email?: string;
        consentKind?: string;
        version?: string;
        context?: Record<string, unknown> | null;
        at?: string;
      };
      if (String(d.email ?? "").toLowerCase() !== who) continue;
      if (!(CONSENT_KINDS as readonly string[]).includes(String(d.consentKind))) continue;
      fromCrumbs.push({
        kind: d.consentKind as ConsentKind,
        version: d.version ?? "",
        at: Date.parse(d.at ?? c.created_at) || 0,
        context: d.context ?? undefined,
        degraded: true,
      });
    } catch {
      /* a breadcrumb we cannot parse is not an acceptance we can claim */
    }
  }

  return [...fromLedger, ...fromCrumbs].sort((a, b) => b.at - a.at).slice(0, cap);
}
