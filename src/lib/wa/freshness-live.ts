import { sbSelect } from "../runtime-config";
import { numberFilter } from "./phone-key";
import { judgeFreshness, type ComposedAgainst, type FreshnessVerdict } from "./freshness";

// THE SAME QUESTION, ASKED ON EVERY PATH THAT SENDS.
//
// "Is this draft still the right thing to say?" had exactly one asker: the
// drain, for messages that had been PARKED. But parking is the exception. The
// common case - the one the inline-delivery rewrite exists to produce - composes
// a reply and sends it in the same request, after a short human-like pause, and
// that path never asked the question at all.
//
// So the field failure the freshness guard was written for stayed fully
// reproducible on the path that carries most traffic: compose an answer, wait,
// send it into a conversation that has moved on.
//
// This module is the shared asker. It performs the reads (what is the newest
// inbound, what does stock look like right now) and hands them to the pure
// judge. Both the drain and the inline send call it, so neither can be stale
// and neither can disagree with the other about what stale means.

export interface MovedOnArgs {
  senderKey: string;
  toNumber: string;
  composedAgainst?: ComposedAgainst | null;
  /** Outbox/meta kind. Cold intros and human-typed messages are never stale. */
  kind?: string;
}

const NEVER_STALE = new Set(["rfq", "custom", "human-manual"]);
const FRESH: FreshnessVerdict = { stale: false };

/**
 * Has the conversation moved past this draft?
 *
 * FAILS OPEN, like the judge it wraps: an unreadable table, a draft with no
 * fingerprint, a cold introduction that answers nothing - all send. Dropping a
 * correct message because a read blipped trades one silent failure for another.
 */
export async function threadMovedOn(args: MovedOnArgs): Promise<FreshnessVerdict> {
  if (args.kind && NEVER_STALE.has(args.kind)) return FRESH;
  const composedAgainst = args.composedAgainst;
  if (!composedAgainst) return FRESH;

  try {
    const enc = encodeURIComponent(args.senderKey);
    const inbound = await sbSelect<{
      wa_message_id: string | null;
      received_at: string;
      body: string | null;
    }>(
      "whatsapp_messages",
      `select=wa_message_id,received_at,body&direction=eq.inbound&raw->>receiver=eq.${enc}` +
        `&order=received_at.desc&limit=10${numberFilter("from_number", args.toNumber)}`
    );
    // A STICKER IS NOT A CHANGE OF MIND EITHER.
    //
    // Stickers, reactions and protocol frames (edits, revokes) are stored with
    // an empty body. Left in, the newest of them counts as "the shop has
    // spoken since we wrote this" and throws away a perfectly good reply - a
    // thumbs-up would silently cost the traveller a turn. Real media is never
    // contentless here: photos, voice notes, documents and videos all carry a
    // placeholder body.
    const meaningful = inbound.filter((m) => (m.body ?? "").trim().length > 0);
    if (!meaningful.length) return FRESH;

    // A BURST IS NOT A CHANGE OF MIND.
    //
    // When a shop sends three messages in five seconds, ingest stores them all
    // and the turn coalesces them into one answer - stamped with the id of the
    // message that triggered it, which may not be the newest of the three. On
    // the drain that never mattered (minutes had passed), but inline it would
    // read as "a newer inbound arrived" and throw away a reply that already
    // accounted for it, on every single burst.
    //
    // So the id rule only applies to something that arrived AFTER we started
    // composing. Anything already stored by then is, by definition, something
    // this draft could see.
    const composedAtMs = composedAgainst.inboundAt ? Date.parse(composedAgainst.inboundAt) : NaN;
    const newest = meaningful[0];
    const newestMs = Date.parse(newest.received_at);
    const arrivedAfterCompose =
      !Number.isFinite(composedAtMs) || (Number.isFinite(newestMs) && newestMs > composedAtMs);

    // Stock as the thread reads RIGHT NOW, from the shop's own recent words.
    // Bounded to the rows already fetched - never a second query per message.
    let stockNow: "in-stock" | "out-of-stock" | "unknown" = "unknown";
    try {
      const { claimsAcross } = await import("../thread/claims");
      const { stockState } = await import("../thread/ledger");
      const bodies = [...meaningful].reverse().map((m) => m.body ?? "");
      stockNow = stockState({
        claims: claimsAcross(bodies, "shop"),
        known: [],
        outstanding: [],
        owed: [],
      }).state;
    } catch {
      /* stock is the narrower rule; the newer-inbound rule stands alone */
    }

    return judgeFreshness({
      composedAgainst,
      latestInboundId: arrivedAfterCompose ? newest.wa_message_id : composedAgainst.inboundId,
      latestInboundAt: newest.received_at,
      stockNow,
    });
  } catch {
    return FRESH; // unreadable => send, never delete on a blip
  }
}

/**
 * A dropped draft must never be the end of the thread.
 *
 * Whatever the shop said that made this draft wrong may have had no turn of its
 * own - it can have been coalesced, guard-refused, or lost to a takeover flip.
 * So a drop always schedules a fresh turn against the CURRENT state. The wakeup
 * drain applies its own per-thread claim, so a turn already in flight is not
 * duplicated. Drop and recompose, never drop and hope.
 */
export async function scheduleRecompose(
  senderKey: string,
  toNumber: string,
  reason: string
): Promise<void> {
  const { sbInsert } = await import("../runtime-config");
  const { threadKeyFor } = await import("../graph/state");
  const base = {
    kind: "tick",
    thread_key: threadKeyFor(senderKey, toNumber),
    not_before: new Date(Date.now() + 2_000).toISOString(),
    payload: { reason },
  };
  const ok = await sbInsert("graph_wakeups", [{ ...base, user_email: senderKey }]).catch(
    () => false
  );
  if (!ok) await sbInsert("graph_wakeups", [base]).catch(() => {});
}
