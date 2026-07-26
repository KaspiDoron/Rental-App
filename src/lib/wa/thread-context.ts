// THE one thread resolver. Every layer that asks "is this a real shop thread,
// and what RFQ does it belong to?" must come through here.
//
// The bug this kills: three copies of the lookup existed with THREE different
// predicates -
//   - drill.ts/thread-gate: newest 10 outbound, anchor = rfq OR vendorId OR kind
//   - agent-loop:            newest 1  outbound, anchor = rfq ONLY
//   - vision.worker:         newest 1  outbound, anchor = rfq ONLY
// so a thread could PASS the ingest gate (message stored), then be dropped by
// the agent as "no-rfq-thread". That happened whenever the newest outbound row
// carried no rfq - which a human-manual takeover row, or any send whose client
// omitted body.rfq, guarantees. One stray row silently killed the whole
// conversation forever.
//
// Fix: scan a WINDOW of recent outbound rows and take the newest row that
// actually carries an RFQ, instead of demanding it be the very newest row. A
// later takeover/custom message can no longer erase the thread's identity.

import "server-only";
import { sbSelect } from "../runtime-config";
import { threadNumberOr } from "./phone-key";
import { classifyIngestDetailed, type GateRaw, type IngestReason } from "./thread-gate";
import type { StructuredRFQ } from "../types";

export interface ThreadRaw extends GateRaw {
  sender?: string;
  region?: string;
  vendorName?: string;
  localLang?: boolean;
  plan?: string;
  round?: number;
}

export interface ThreadContext {
  /** Ingestible: a real shop thread inside its window. */
  ok: boolean;
  reason: IngestReason;
  /** The newest outbound raw that carries an RFQ (not merely the newest row). */
  rfq: StructuredRFQ | null;
  ctx: ThreadRaw | null;
  vendorId?: string;
  vendorName?: string;
  region?: string;
  /** How many outbound rows we saw (0 => we never messaged this number). */
  anchors: number;
  /** received_at of the newest outbound row (session-close comparisons). */
  newestAt: string | null;
  /** True when `rfq` came from anchor RECOVERY, not from an outbound row. */
  repaired?: boolean;
}

const WINDOW = 12; // recent outbound rows scanned for an RFQ anchor

/**
 * Resolve the thread for `digits` as seen by `senderEmail`. Number matching is
 * spelling-tolerant (see phone-key) so threads written before canonicalization
 * still resolve.
 */
export async function resolveThreadContext(
  digits: string,
  senderEmail: string
): Promise<ThreadContext> {
  const empty: ThreadContext = {
    ok: false,
    reason: "no-outbound",
    rfq: null,
    ctx: null,
    anchors: 0,
    newestAt: null,
  };
  if (!digits || !senderEmail) return empty;

  const or = threadNumberOr("to_number", digits);
  if (!or) return empty;

  const rows = await sbSelect<{ id: number; received_at: string; raw: ThreadRaw | null }>(
    "whatsapp_messages",
    `select=id,received_at,raw&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
      senderEmail
    )}&order=received_at.desc&limit=${WINDOW}&or=${or}`
  ).catch(() => []);

  if (rows.length === 0) return empty;

  const gate = classifyIngestDetailed(rows, Date.now());

  // The newest row that actually carries an RFQ - NOT simply rows[0]. This is
  // the whole fix: a human-manual or rfq-less row on top no longer orphans the
  // conversation.
  const anchor = rows.find((r) => r.raw?.rfq != null) ?? null;
  // Identity (vendor/region) can come from any recent row, newest wins.
  const identity = rows.find((r) => r.raw?.vendorId) ?? anchor ?? rows[0];

  // SELF-HEAL. We demonstrably messaged this shop (rows.length > 0) and the
  // gate says the thread is live, yet NO row carries an rfq - so every reply
  // would die as "no-rfq-thread" forever. Recover the RFQ from the traveller's
  // own recent search and repair the row, instead of going permanently silent.
  if (!anchor && gate.ok) {
    const { recoverRfqForSender } = await import("./anchor-recovery");
    const recovered = await recoverRfqForSender(senderEmail).catch(() => null);
    if (recovered) {
      const target = identity ?? rows[0];
      // Persist onto the newest outbound row so the heal is permanent (one
      // recovery per thread, not one per inbound message) and the WA doctor
      // reports a healthy anchor from here on. Best-effort: if the write fails
      // we still proceed with THIS turn using the recovered rfq.
      if (target) {
        const { sbUpdate } = await import("../runtime-config");
        await sbUpdate(
          "whatsapp_messages",
          `id=eq.${target.id}`,
          { raw: { ...(target.raw ?? {}), rfq: recovered, rfqRecovered: true } }
        ).catch(() => {});
      }
      // Never silent: the repair is an event the owner can see in the doctor.
      const { sbInsert } = await import("../runtime-config");
      await sbInsert("agent_events", [
        {
          kind: "anchor-repaired",
          user_email: senderEmail,
          vendor_name: identity?.raw?.vendorName ?? digits,
          detail: `Re-anchored ${digits} from the traveller's recent search (no outbound row carried an rfq).`,
        },
      ]).catch(() => {});
      return {
        ok: gate.ok,
        reason: gate.reason,
        rfq: recovered,
        ctx: (target?.raw ?? null) as ThreadRaw | null,
        vendorId: identity?.raw?.vendorId,
        vendorName: identity?.raw?.vendorName,
        region: identity?.raw?.region || undefined,
        anchors: rows.length,
        newestAt: rows[0]?.received_at ?? null,
        repaired: true,
      };
    }
  }

  return {
    ok: gate.ok,
    reason: gate.reason,
    rfq: (anchor?.raw?.rfq as StructuredRFQ | undefined) ?? null,
    ctx: anchor?.raw ?? identity?.raw ?? null,
    vendorId: identity?.raw?.vendorId,
    vendorName: identity?.raw?.vendorName,
    region: (anchor?.raw?.region ?? identity?.raw?.region) || undefined,
    anchors: rows.length,
    newestAt: rows[0]?.received_at ?? null,
  };
}
