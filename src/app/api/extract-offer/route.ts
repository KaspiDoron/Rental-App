import { NextResponse } from "next/server";
import { extractOffer } from "@/lib/agents";
import { getSession } from "@/lib/session";
import type { StructuredRFQ } from "@/lib/types";

// Offer Extraction Agent endpoint: reads a vendor reply (text and/or an image
// of a price list) and returns a structured offer - or a clarification message
// when it is not 100% sure the price matches the exact requested vehicle.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const { checkDailyLimit } = await import("@/lib/usage");
  const gate = await checkDailyLimit("ai", session.email, "LIMIT_AI_PER_DAY");
  if (!gate.allowed) {
    return NextResponse.json(
      { error: `Daily AI limit reached (${gate.limit}/day). Try again tomorrow.` },
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
    const row = {
      user_email: session.email,
      vendor_id: String(body.vendorId ?? ""),
      vendor_name: String(body.vendorName ?? ""),
      price_per_day: result.pricePerDay,
      list_price_per_day: body.firstQuote ?? result.pricePerDay,
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
}

// Vercel: allow slow AI/WhatsApp upstreams (Hobby default is ~10s - too short).
export const maxDuration = 60;
