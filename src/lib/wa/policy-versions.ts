// THE GOVERNANCE INVERSION, CORRECTED - plan Part 5.9.
//
// Stated plainly, because it is the sharpest thing the whole review found:
//
//   Negotiation policy is versioned, golden-replay gated, one-click
//   rollbackable and owner-only. Its worst case is a bad haggle.
//
//   `whatsapp_security_policies` took a BARE UPSERT from any management
//   session, with no version, no author, no previous value and no undo. Its
//   worst case is a traveller losing their personal WhatsApp account.
//
// The rigour was applied to the cheap decision and withheld from the expensive
// one. This module is the minimum that reverses that: every anti-ban knob
// change becomes an append-only row carrying who, when, from what, to what.
//
// WHY IT MATTERS BEYOND AUDIT: without a before/after boundary, NOTHING on the
// risk dashboard means anything. "Restrictions fell after we changed the gap"
// is only a sentence you can say if the change has a timestamp the counts can
// be split on. This table is what makes the dashboard an instrument rather than
// a decoration, which is the entire reason for building it.
//
// It is NOT a rollback engine and does not pretend to be one. Recording the
// previous value is what makes a manual revert possible and correct; claiming
// one-click rollback without a replay gate would be the same over-promise this
// plan keeps deleting from the UI.

import { sbInsert } from "../runtime-config";
import { noteRisk } from "./risk-events";

export interface PolicyChange {
  key: string;
  /** Null when the key had no override row - the code default was in force. */
  from: string | null;
  to: string;
}

/**
 * Record one anti-ban policy change.
 *
 * Best-effort and never throws: a governance record that can break the admin
 * screen is a governance record people will route around. The write is awaited
 * so it survives the Cloud Run response boundary - CPU is throttled to zero the
 * instant the response flushes, and an un-awaited audit row simply never lands.
 */
export async function recordPolicyChange(
  change: PolicyChange,
  authorEmail: string | null,
  note?: string
): Promise<boolean> {
  try {
    const key = String(change?.key ?? "").trim();
    if (!key) return false;
    // Version is derived from the moment, not a counter. A counter needs a read
    // before every write and would race across instances; the timestamp is
    // monotone enough for an append-only audit and readable by a human.
    const version = new Date().toISOString();
    const ok = await sbInsert("wa_policy_versions", [
      {
        version,
        author_email: authorEmail ? String(authorEmail).slice(0, 200) : null,
        changes: { key, from: change.from ?? null, to: change.to },
        note: note ? String(note).slice(0, 500) : null,
      },
    ]);
    // Also on the risk ledger, so a behaviour change and its consequences sit in
    // one ordered stream. Two tables that have to be joined by eye during an
    // incident are two tables nobody joins.
    await noteRisk({
      senderKey: authorEmail || "owner",
      kind: "policy_changed",
      detail: { key, from: change.from ?? "", to: change.to },
      policyVersion: version,
    });
    return ok;
  } catch {
    return false;
  }
}

/**
 * Is this key one of the knobs that can put a traveller's number at risk?
 *
 * Used to decide whether a change deserves the audit row. Deliberately
 * INCLUSIVE: an unrecognised key is treated as safety-relevant, because the
 * cost of over-recording is a row, and the cost of under-recording is exactly
 * the gap this module exists to close.
 */
export function isSafetyPolicy(key: string): boolean {
  const k = String(key ?? "").toLowerCase();
  if (!k) return false;
  // The only exclusions are keys that provably cannot change send behaviour.
  const COSMETIC = ["ui_", "label_", "copy_"];
  return !COSMETIC.some((p) => k.startsWith(p));
}
