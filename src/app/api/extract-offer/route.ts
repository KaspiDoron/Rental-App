import { NextResponse } from "next/server";
import { runWithAiBudget, currentAiBudget } from "@/lib/ai-budget";
import { extractOffer } from "@/lib/agents";
import { getSession } from "@/lib/session";
import type { StructuredRFQ } from "@/lib/types";

// Offer Extraction Agent endpoint: reads a vendor reply (text and/or an image
// of a price list) and returns a structured offer - or a clarification message
// when it is not 100% sure the price matches the exact requested vehicle.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  // THE ONE PLACE THIS CAP WAS ENFORCED, AND IT COULD NEVER FIRE.
  //
  // This route gated on `checkDailyLimit("ai", ...)` and then never DEBITED -
  // nothing anywhere called `recordApi("ai", ...)`. So the counter the gate
  // read was never incremented, `used` was always 0, and the limit was
  // unreachable. Combined with the engine having no gate at all, the practical
  // state was that `LIMIT_AI_PER_DAY` governed nothing whatsoever.
  //
  // The scope pairs them: one read on open, one debit on close. An interactive
  // request still gets a real 429 rather than silently degrading to a
  // template - that is the right answer here, where a person is waiting on a
  // response, and the wrong one for a background negotiation turn.
  return await runWithAiBudget(session.email, async () => {
    const scope = currentAiBudget();
    if (scope && !scope.allowed) {
      return NextResponse.json(
        { error: `Daily AI limit reached (${scope.remaining === 0 ? "cap" : scope.remaining}/day). Try again tomorrow.` },
        { status: 429 }
      );
    }
    const body = await req.json().catch(() => null);
    if (!body?.rfq) return NextResponse.json({ error: "rfq required" }, { status: 400 });

    const images: { mime: string; base64: string }[] = [];
    for (const dataUrl of (body.images ?? []).slice(0, 3)) {
      const m = /^data:([^;]+);base64,(.+)$/.exec(String(dataUrl));
      if (m) images.push({ mime: m[1], base64: m[2] });
    }

    // Region matters: a pasted "250 per day" from a Thai shop is 250 THB, never
    // $250 - the extractor needs the local-currency context.
    const region = String(body.region ?? "").trim() || undefined;
    const result = await extractOffer(
      body.rfq as StructuredRFQ,
      String(body.text ?? ""),
      images,
      undefined,
      region
    );
    const { currencyForRegion } = await import("@/lib/agents");
    const cur = result.currency || currencyForRegion(region) || "USD";

    // Everything is saved: raw reply + extraction outcome feed agent memory.
    // sbInsert fails silently on unknown columns, so retry without the newest
    // ones if the owner has not run the latest schema yet.
    const { sbInsert } = await import("@/lib/runtime-config");
    const replyBase = {
      user_email: session.email,
      vendor_id: String(body.vendorId ?? ""),
      vendor_name: String(body.vendorName ?? ""),
      reply_text: String(body.text ?? "").slice(0, 4000),
      image_count: images.length,
      found: result.found,
      price_per_day: result.pricePerDay ?? null,
      matches_spec: result.matchesSpec,
      confidence: result.confidence,
    };
    const replyOk = await sbInsert("vendor_replies", [
      { ...replyBase, currency: cur, deposit: result.deposit ?? null, delivers: result.delivers ?? null },
    ]);
    if (!replyOk) await sbInsert("vendor_replies", [replyBase]);
    // Verified shop tags (item #13): store this reply's explicit facts; a tag is
    // only shown after >= 2 distinct replies confirm it.
    if (body.vendorId) {
      const { tagsFromExtraction, recordTagSignals } = await import("@/lib/vendor-tags");
      await recordTagSignals(
        String(body.vendorId),
        session.email,
        String(body.text ?? ""),
        tagsFromExtraction(result, String(body.text ?? ""))
      ).catch(() => {});
    }
    if (result.found && result.pricePerDay) {
      const { sbSelect } = await import("@/lib/runtime-config");
      const latest = await sbSelect<{ id: number }>(
        "searches",
        `select=id&user_email=eq.${encodeURIComponent(session.email)}&order=created_at.desc&limit=1`
      ).catch(() => []);
      // THE SAVINGS BASELINE IS NOT THE CLIENT'S TO DECIDE.
      //
      // `body.firstQuote` went into the `numeric` column verbatim - no Number(),
      // no range check - and that column IS the "before" price behind every
      // savings figure: the per-session saved%, the trip snapshot, the judge's
      // scoring, and the owner's GLOBAL, cross-user average-discount KPI. One
      // caller could move the headline number for every user.
      //
      // It also broke the row: a non-numeric value 400s the insert, and the
      // fallback insert below re-sent the SAME field, so the offer was dropped
      // entirely while the route still answered 200 with the extraction.
      //
      // A baseline is only meaningful if it is a real number, at or above what we
      // negotiated (a "before" cannot be cheaper than the "after"), and not
      // absurd - beyond 10x the quote it is not a rental list price, it is noise
      // that would report a 90%+ discount. Anything else falls back to the quote
      // itself, which reports a saving of zero: honest, and the direction that
      // cannot flatter us.
      const askedRaw = Number(body.firstQuote);
      const listPerDay =
        Number.isFinite(askedRaw) &&
        askedRaw >= result.pricePerDay &&
        askedRaw <= result.pricePerDay * 10
          ? askedRaw
          : result.pricePerDay;
      const row = {
        user_email: session.email,
        vendor_id: String(body.vendorId ?? ""),
        vendor_name: String(body.vendorName ?? ""),
        price_per_day: result.pricePerDay,
        list_price_per_day: listPerDay,
        currency: cur,
        round: Number(body.round ?? 0),
        simulated: false,
        verified: result.matchesSpec && result.confidence === "high",
      };
      // Session attribution; retry without the column pre-migration.
      const ok = await sbInsert("offers", [{ ...row, search_id: latest[0]?.id ?? null }]);
      if (!ok) await sbInsert("offers", [row]);
    }
    return NextResponse.json({ ...result, currency: cur });
  });
}

// maxDuration: lift the request-timeout ceiling for slow AI/WhatsApp upstreams.
export const maxDuration = 60;
