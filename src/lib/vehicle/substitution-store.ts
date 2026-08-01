import "server-only";
import type { AlternativeOffer } from "./substitution";

// WHERE A PENDING SUBSTITUTION CHOICE LIVES.
//
// On the thread's own `fields` blob, beside every other durable thread fact,
// because that is what the engine already reads on every turn through
// loadState - so a paused thread stays paused for the inbound reply, the
// scheduled wakeup and a user action alike, with no fourth place to keep in
// sync and no migration.
//
// Every write here is a read-modify-write on one JSONB key. The reads are
// immediate and the writes touch a single field, which is the same discipline
// the accessory verdicts use for the same reason.

interface ThreadRow {
  id: number;
  fields: (Record<string, unknown> & { alternativeOffer?: AlternativeOffer | null }) | null;
}

async function loadThread(email: string, vendorId: string): Promise<ThreadRow | null> {
  const { sbSelect } = await import("../runtime-config");
  const rows = await sbSelect<ThreadRow>(
    "negotiation_threads",
    `select=id,fields&user_email=eq.${encodeURIComponent(email)}&vendor_id=eq.${encodeURIComponent(
      vendorId
    )}&order=updated_at.desc&limit=1`
  );
  return rows[0] ?? null;
}

/** Park a choice for the traveller. Never overwrites one they have not seen. */
export async function persistAlternativeOffer(args: {
  email: string;
  vendorId: string;
  threadKey?: string;
  offer: AlternativeOffer;
}): Promise<boolean> {
  try {
    const row = await loadThread(args.email, args.vendorId);
    if (!row) return false;
    // ASK ONCE. A shop that repeats itself, or a webhook redelivery, must not
    // replace a choice the traveller is already looking at - the price on the
    // card would change under their thumb.
    if (row.fields?.alternativeOffer) return false;
    const { sbUpdate } = await import("../runtime-config");
    await sbUpdate("negotiation_threads", `id=eq.${row.id}`, {
      fields: { ...(row.fields ?? {}), alternativeOffer: args.offer },
    });
    return true;
  } catch {
    return false;
  }
}

/** The traveller decided. Clear the pause either way. */
export async function resolveAlternativeOffer(args: {
  email: string;
  vendorId: string;
  accept: boolean;
}): Promise<{ ok: boolean; offer: AlternativeOffer | null }> {
  try {
    const row = await loadThread(args.email, args.vendorId);
    const offer = row?.fields?.alternativeOffer ?? null;
    if (!row || !offer) return { ok: false, offer: null };
    const { sbUpdate } = await import("../runtime-config");
    const next: Record<string, unknown> = { ...(row.fields ?? {}), alternativeOffer: null };
    if (args.accept) {
      // ACCEPTING RETARGETS THE THREAD, it does not disable the gate. The
      // vehicle the traveller agreed to becomes the one this thread is about,
      // so a THIRD substitution is caught exactly the same way.
      if (typeof offer.engineSizeCc === "number" && offer.engineSizeCc > 0) {
        next.acceptedVehicleCc = offer.engineSizeCc;
      }
      next.acceptedVehicle = offer.vehicle;
      // The identity gate reads this: the traveller settled the vehicle
      // question themselves, which is stronger evidence than any message.
      next.vehicleConfirmation = { status: "confirmed", evidence: `traveller accepted ${offer.vehicle}` };
    } else {
      // DECLINED IS A DECLINE. The thread returns to the state it would have
      // been in without the choice - closed - rather than sitting open on a
      // vehicle nobody wants.
      next.declined = true;
    }
    await sbUpdate("negotiation_threads", `id=eq.${row.id}`, { fields: next });
    return { ok: true, offer };
  } catch {
    return { ok: false, offer: null };
  }
}
