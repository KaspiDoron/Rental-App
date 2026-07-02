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
  return NextResponse.json(result);
}
