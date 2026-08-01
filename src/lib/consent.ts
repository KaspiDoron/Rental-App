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
// EVERY WRITE IS BEST-EFFORT AND NEVER BLOCKS THE USER'S ACTION. A database
// hiccup must not stop someone linking WhatsApp or closing a deal; the ledger
// is an audit trail, not a gate. The gate is `needsReacceptance`, which is a
// pure function of data we already have.

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
  "wa_link",
  "deal_terms",
] as const;

export type ConsentKind = (typeof CONSENT_KINDS)[number];

export interface ConsentEvent {
  kind: ConsentKind;
  version: string;
  at: number;
  context?: Record<string, unknown>;
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
  return sbInsert("consent_events", [
    {
      email,
      kind: input.kind,
      version: input.version ?? TERMS_VERSION,
      context: input.context ?? null,
      accepted_at: new Date().toISOString(),
    },
  ]).catch(() => false);
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

/** One user's acceptance history, newest first - the admin proof view. */
export async function consentLedger(email: string, limit = 50): Promise<ConsentEvent[]> {
  const who = String(email ?? "").trim().toLowerCase();
  if (!who) return [];
  const rows = await sbSelect<{
    kind: string;
    version: string | null;
    context: Record<string, unknown> | null;
    accepted_at: string;
  }>(
    "consent_events",
    `select=kind,version,context,accepted_at&email=eq.${encodeURIComponent(
      who
    )}&order=accepted_at.desc&limit=${Math.max(1, Math.min(200, limit))}`
  ).catch(() => []);
  return rows
    .filter((r) => (CONSENT_KINDS as readonly string[]).includes(r.kind))
    .map((r) => ({
      kind: r.kind as ConsentKind,
      version: r.version ?? "",
      at: Date.parse(r.accepted_at) || 0,
      context: r.context ?? undefined,
    }));
}
