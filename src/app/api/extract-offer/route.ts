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

  const result = await extractOffer(
    body.rfq as StructuredRFQ,
    String(body.text ?? ""),
    images
  );

  // Everything is saved: raw reply + extraction outcome feed agent memory.
  const { sbInsert } = await import("@/lib/runtime-config");
  await sbInsert("vendor_replies", [
    {
      user_email: session.email,
      vendor_id: String(body.vendorId ?? ""),
      vendor_name: String(body.vendorName ?? ""),
      reply_text: String(body.text ?? "").slice(0, 4000),
      image_count: images.length,
      found: result.found,
      price_per_day: result.pricePerDay ?? null,
      matches_spec: result.matchesSpec,
      confidence: result.confidence,
    },
  ]);
  if (result.found && result.pricePerDay) {
    await sbInsert("offers", [
      {
        user_email: session.email,
        vendor_id: String(body.vendorId ?? ""),
        vendor_name: String(body.vendorName ?? ""),
        price_per_day: result.pricePerDay,
        list_price_per_day: body.firstQuote ?? result.pricePerDay,
        currency: result.currency ?? "USD",
        round: Number(body.round ?? 0),
        simulated: false,
        verified: result.matchesSpec && result.confidence === "high",
      },
    ]);
  }
  return NextResponse.json(result);
}
