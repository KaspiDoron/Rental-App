import { NextResponse } from "next/server";
import { placeDetails } from "@/lib/google";
import { getSession } from "@/lib/session";

// Resolve a real vendor's phone (Place Details) into a compliant wa.me link.
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const placeId = new URL(req.url).searchParams.get("placeId") ?? "";
  if (!placeId) return NextResponse.json({ error: "placeId required" }, { status: 400 });

  const details = await placeDetails(placeId);
  if (!details?.phone) {
    return NextResponse.json({
      available: false,
      note: "No phone number available for this vendor (or the Google Maps key is not set).",
    });
  }
  const digits = details.phone.replace(/[^\d]/g, "");
  return NextResponse.json({
    available: true,
    phone: details.phone,
    waLink: `https://wa.me/${digits}`,
    website: details.website ?? null,
    address: details.address ?? null,
  });
}
