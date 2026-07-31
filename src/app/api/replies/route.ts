import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sbSelect } from "@/lib/runtime-config";
import { identityKey } from "@/lib/wa/phone-key";

// A live poll - never statically cached, or new shop offers stop popping in.
export const dynamic = "force-dynamic";

// Live feed of the signed-in user's vendor replies (auto-ingested by the
// WhatsApp webhook or added manually). The app polls this while agents are
// waiting on shops, so confirmed offers pop into the cards by themselves and
// the traveller never leaves the app.
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  // ATOMIC SESSION: the client passes the epoch its current search started at;
  // only replies created since then belong to this session. This is what stops
  // a previous search's offers/threads from resurfacing on a new search.
  const params = new URL(req.url).searchParams;
  const sinceMs = Number(params.get("since") ?? 0);
  // THE DECLARED SPEC scopes the option menu. The traveller asked for one
  // vehicle and declared a licence for that class; a shop's full price board
  // must never become a list of things to pick. Narrowing-only, and the engine
  // re-derives the same scope server-side from the real RFQ for anything it
  // actually negotiates, so a tampered value can only show the sender more rows.
  const specCc = Number(params.get("cc") ?? 0);
  const specClass = params.get("vclass");
  const specTx = params.get("tx");
  const sinceFilter =
    sinceMs > 0
      ? `&created_at=gte.${encodeURIComponent(new Date(sinceMs).toISOString())}`
      : "";

  // Reliability core: reconcile replies the webhook may have MISSED (the
  // Evolution host can be restarting exactly when a shop answers). Throttled
  // to one real pull per user per ~25s, so most polls skip it instantly.
  try {
    const { syncInboundReplies } = await import("@/lib/wa-sync");
    await syncInboundReplies(session.email);
  } catch {
    /* the DB feed below still answers */
  }
  // Any user activity also flushes due queued messages (no dedicated worker).
  try {
    const { drainOutbox } = await import("@/lib/wa-guard");
    const { sendFromUser } = await import("@/lib/evolution");
    await drainOutbox((senderKey, to, text) => sendFromUser(senderKey, to, text, true));
    const { drainGraphWakeups } = await import("@/lib/graph/engine");
    await drainGraphWakeups((senderKey, to, text) => sendFromUser(senderKey, to, text, true));
  } catch {
    /* best-effort */
  }

  interface ReplyRow {
    id: number;
    vendor_id: string;
    vendor_name: string;
    reply_text: string;
    found: boolean;
    price_per_day: number | null;
    matches_spec: boolean;
    confidence: string;
    auto: boolean;
    currency?: string | null;
    deposit?: string | null;
    deposit_type?: string | null;
    deposit_amount?: number | null;
    deposit_currency?: string | null;
    delivers?: boolean | null;
    insurance_included?: boolean | null;
    delivery_fee?: number | null;
    created_at: string;
  }
  const filter = `user_email=eq.${encodeURIComponent(session.email)}${sinceFilter}&order=created_at.desc&limit=40`;
  let rows = await sbSelect<ReplyRow>(
    "vendor_replies",
    `select=id,vendor_id,vendor_name,reply_text,found,price_per_day,matches_spec,confidence,auto,currency,deposit,deposit_type,deposit_amount,deposit_currency,delivers,insurance_included,delivery_fee,created_at&${filter}`
  );
  if (rows.length === 0) {
    // A select naming a not-yet-migrated column fails SILENTLY as [] - the
    // feed must keep working before the owner runs the newest schema.
    rows = await sbSelect<ReplyRow>(
      "vendor_replies",
      `select=id,vendor_id,vendor_name,reply_text,found,price_per_day,matches_spec,confidence,auto,currency,deposit,delivers,created_at&${filter}`
    );
  }
  if (rows.length === 0) {
    rows = await sbSelect<ReplyRow>(
      "vendor_replies",
      `select=id,vendor_id,vendor_name,reply_text,found,price_per_day,matches_spec,confidence,auto,created_at&${filter}`
    );
  }

  // Merge the digraph engine's per-thread state so the card can show the
  // fulfillment chip (delivery / pickup / on-shop), whether the deal is
  // complete enough to PRESENT, and the pickup-consent status. Best-effort:
  // before the migration this returns [] and the feed behaves exactly as
  // before (offers show immediately).
  interface ThreadRow {
    vendor_id: string | null;
    fields: {
      fulfillment?: string;
      depositType?: string;
      depositNote?: string;
      pricePerDay?: number;
      pickupOffered?: boolean;
      pickupConsent?: boolean;
      declined?: boolean;
      shopUnavailable?: boolean;
      restockHint?: string;
      vehicleConfirmation?: { status?: string; evidence?: string };
    } | null;
  }
  const threads = await sbSelect<ThreadRow>(
    "negotiation_threads",
    `select=vendor_id,fields&user_email=eq.${encodeURIComponent(
      session.email
    )}&order=updated_at.desc&limit=40`
  ).catch(() => [] as ThreadRow[]);
  const stateByVendor = new Map<string, ThreadRow["fields"]>();
  for (const th of threads) {
    if (th.vendor_id && !stateByVendor.has(th.vendor_id)) stateByVendor.set(th.vendor_id, th.fields);
  }
  const isComplete = (f: ThreadRow["fields"], depositLabel?: string | null) =>
    Boolean(
      f?.pricePerDay &&
        (f?.depositType || f?.depositNote || depositLabel) &&
        (f?.fulfillment === "pickup" || f?.fulfillment === "delivery" || f?.fulfillment === "on-shop")
    );

  // THE SHOP'S MENU, for the card. A reply naming more than one price is a
  // CHOICE ("some models 200 and some new 250/day"), and showing only the one
  // number the app happened to pick is how the 200 tier disappeared from the
  // traveller's screen entirely.
  //
  // Derived from the conversation, exactly as the engine derives it
  // (src/lib/offer-options.ts) - so there is one definition, no column to add,
  // and nothing that can go stale against the thread it came from. Deliberately
  // NOT a new select on this route: `rows` above degrades through three column
  // tiers, and an unknown column silently blanks the whole feed.
  //
  // ONE extra query for every inbound body in this session, scoped by the same
  // `raw->>receiver` predicate /api/thread uses (the privacy keystone), then
  // grouped per shop in memory.
  const optionsByVendor = new Map<string, import("@/lib/types").VehicleOption[]>();
  /** vendorId -> the shop's own words when they asked where the traveller is. */
  const askedLocationByVendor = new Map<string, string>();
  try {
    const { optionsFromThread } = await import("@/lib/offer-options");
    const numberByVendor = new Map<string, string>();
    for (const r of rows) if (r.vendor_id) numberByVendor.set(r.vendor_id, "");
    const inbound = await sbSelect<{ from_number: string; body: string }>(
      "whatsapp_messages",
      `select=from_number,body&direction=eq.inbound&raw->>receiver=eq.${encodeURIComponent(
        session.email
      )}${
        sinceMs > 0
          ? `&received_at=gte.${encodeURIComponent(new Date(sinceMs).toISOString())}`
          : ""
      }&order=received_at.asc&limit=200`
    ).catch(() => []);
    // Keyed by IDENTITY, not by the raw string. Inbound rows carry WhatsApp's
    // spelling and outbound rows carry discovery's; joining the two on the raw
    // text silently matched nothing, so a shop's option menu and its
    // "where are you staying?" never reached the card.
    const bodiesByNumber = new Map<string, string[]>();
    for (const m of inbound) {
      if (!m.from_number || !m.body) continue;
      const key = identityKey(m.from_number);
      if (!key) continue;
      const arr = bodiesByNumber.get(key) ?? [];
      arr.push(m.body);
      bodiesByNumber.set(key, arr);
    }
    // vendor_id -> the digits we actually messaged, via this user's outbound rows.
    const out = await sbSelect<{ to_number: string; raw: { vendorId?: string } | null }>(
      "whatsapp_messages",
      `select=to_number,raw&direction=eq.outbound&raw->>sender=eq.${encodeURIComponent(
        session.email
      )}&order=received_at.desc&limit=200`
    ).catch(() => []);
    for (const o of out) {
      const vid = o.raw?.vendorId;
      if (vid && o.to_number && !numberByVendor.get(vid)) numberByVendor.set(vid, o.to_number);
    }
    const { shopAskedLocation } = await import("@/lib/wa/detectors");
    for (const [vendorId, digits] of numberByVendor) {
      const bodies = digits ? bodiesByNumber.get(identityKey(digits)) : undefined;
      if (!bodies?.length) continue;
      const opts = optionsFromThread(bodies, {
        vehicleClass:
          specClass === "car" || specClass === "scooter" || specClass === "motorbike"
            ? specClass
            : undefined,
        engineSizeCc: specCc > 0 ? specCc : undefined,
        transmission: specTx === "automatic" || specTx === "manual" ? specTx : undefined,
      });
      if (opts.length >= 2) optionsByVendor.set(vendorId, opts);
      // Did this shop ASK where the traveller is? Same rows, no extra query.
      // We keep their own wording so the card can say WHY they want it rather
      // than guessing on the traveller's behalf.
      for (let i = bodies.length - 1; i >= 0; i--) {
        if (shopAskedLocation(bodies[i])) {
          askedLocationByVendor.set(vendorId, bodies[i].slice(0, 180));
          break;
        }
      }
    }
  } catch {
    /* the menu is an enrichment - a failure must never blank the feed */
  }

  // THE VEHICLE-IDENTITY GATE, derived per reply rather than stored.
  //
  // Two live threads reached the card as "BEST PRICE ₱400" for a 110cc when the
  // traveller had declared a 125. `matches_spec` could not catch it: nothing
  // had ever paired the price with the vehicle beside it, and an unnamed
  // vehicle defaulted to "must be theirs". src/lib/vehicle pairs them, and its
  // verdict travels to the client so no surface can present an unconfirmed
  // price as a deal. Derived from the reply text the row already holds, so
  // there is no column to add and nothing to migrate or keep in sync.
  const declaredSpec = {
    class:
      specClass === "car" || specClass === "scooter" || specClass === "motorbike"
        ? (specClass as "car" | "scooter" | "motorbike")
        : undefined,
    displacementCc: specCc > 0 ? specCc : undefined,
    transmission:
      specTx === "automatic" || specTx === "manual" ? (specTx as "automatic" | "manual") : undefined,
  };
  const { assessPrice } = await import("@/lib/vehicle/resolution");
  const { amountIndexIn } = await import("@/lib/wa/rate-expr");
  const gateFor = (text: string | null, price: number | null) => {
    if (!text || !price || price <= 0) return null;
    if (!declaredSpec.class && !declaredSpec.displacementCc && !declaredSpec.transmission) return null;
    try {
      const a = assessPrice(text, declaredSpec, {
        pricePerDay: price,
        index: amountIndexIn(text, price),
      });
      return { status: a.status, note: a.travellerNote };
    } catch {
      return null;
    }
  };

  return NextResponse.json({
    replies: rows.map((r) => {
      const st = stateByVendor.get(r.vendor_id);
      const fulfillment =
        st?.fulfillment === "pickup" || st?.fulfillment === "delivery" || st?.fulfillment === "on-shop"
          ? st.fulfillment
          : r.delivers === true
          ? "delivery"
          : undefined;
      // THREAD state outranks per-row derivation - except a positively WRONG
      // vehicle, which stays wrong per row. The field failure this closes: the
      // shop confirms the vehicle once, then sends "1100b./6days"; the per-row
      // gate re-judges that text alone as unconfirmed and the card freezes on
      // the old price. What the conversation established travels with every
      // later row.
      const rowGate = gateFor(r.reply_text, r.price_per_day);
      const conf = st?.vehicleConfirmation?.status;
      const vehicleStatus =
        rowGate?.status === "wrong-vehicle"
          ? ("wrong-vehicle" as const)
          : conf === "confirmed"
            ? ("confirmed" as const)
            : conf === "assumed" && rowGate?.status !== "confirmed"
              ? ("assumed" as const)
              : rowGate?.status ?? null;
      return {
      id: r.id,
      vendorId: r.vendor_id,
      vendorName: r.vendor_name,
      replyText: r.reply_text,
      found: r.found,
      pricePerDay: r.price_per_day,
      // VERIFIED = high-confidence read AND the vehicle is established. The
      // column pair alone stopped meaning that when unconfirmed prices became
      // real (unverified) offers.
      verified: r.matches_spec && r.confidence === "high" && vehicleStatus === "confirmed",
      // Raw spec match: false = the shop quoted a DIFFERENT vehicle. The client
      // must never present such a price as the best/lockable offer.
      matchesSpec: r.matches_spec,
      // Transparent verification states: "confirmed" wears the badge, "assumed"
      // presents as an honest unverified offer, only "wrong-vehicle" is barred.
      vehicleStatus,
      vehicleNote: vehicleStatus === "confirmed" ? null : rowGate?.note ?? null,
      auto: r.auto,
      currency: r.currency ?? null, // the shop's own money - never defaulted here
      deposit: r.deposit ?? null,
      depositType: r.deposit_type ?? null,
      depositAmount: r.deposit_amount ?? null,
      depositCurrency: r.deposit_currency ?? null,
      delivers: r.delivers ?? null,
      insuranceIncluded: r.insurance_included ?? null,
      deliveryFee: r.delivery_fee ?? null,
      // Digraph engine state (undefined before migration -> card treats as ready).
      fulfillment: fulfillment ?? null,
      presentable: st ? isComplete(st, r.deposit) : undefined,
      // The shop walked away - the card must say so instead of pretending
      // the agent is still working ("still confirming the deposit...").
      declined: st?.declined === true,
      // The shop has nothing to rent right now - a real, temporary state. The
      // card stops waiting for a price and says so, and the agent has already
      // asked when one is back.
      unavailable: st?.shopUnavailable === true,
      restockHint: st?.restockHint ?? null,
      pickupOffered: st?.pickupOffered ?? null,
      pickupConsent: st?.pickupConsent ?? null,
      // Every tier this shop offered, so the card can show the CHOICE instead
      // of the single price the app picked. Absent for an ordinary quote.
      options: optionsByVendor.get(r.vendor_id) ?? null,
      // The shop asked where we are. The card explains why and lets the
      // traveller choose WHICH place to share - it is never sent automatically.
      askedLocationQuote: askedLocationByVendor.get(r.vendor_id) ?? null,
      createdAt: r.created_at,
      };
    }),
  });
}

// maxDuration: lift the request-timeout ceiling for slow AI/WhatsApp upstreams.
export const maxDuration = 60;
