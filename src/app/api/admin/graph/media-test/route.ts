import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { extractOffer, type ExtractedOffer } from "@/lib/agents";
import { floorPriceFor } from "@/lib/market";
import { transcribeAudio } from "@/lib/graph/transcribe";
import { validateMediaCoherence } from "@/lib/graph/coherence";
import type { StructuredRFQ } from "@/lib/types";

// The Media Testing Lab (owner/manager only): upload a price-table / odometer /
// vehicle image OR a voice note and see EXACTLY what the vision / transcription
// agent read AND whether the media-coherence validator finds it consistent with
// an optional conversation context. 100% visibility, zero WhatsApp traffic.
//
// Body: { kind: "image"|"audio", mime, base64, context?, region?, rfq? }
// (base64 within Vercel's 4.5MB body limit; the client downscales/caps first.)

const DEFAULT_RFQ: StructuredRFQ = {
  vehicleClass: "scooter",
  transmission: "automatic",
  durationDays: 3,
  accessories: [],
  fulfillment: "any",
  vendorMessage: "",
  engineSizeCc: 110,
};

export async function POST(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const kind = body.kind === "audio" ? "audio" : "image";
  const mime = String(body.mime ?? (kind === "audio" ? "audio/ogg" : "image/jpeg"));
  const base64 = String(body.base64 ?? "");
  if (!base64) return NextResponse.json({ error: "No media uploaded." }, { status: 400 });
  // Guard the serverless body budget (base64 is ~1.33x the raw bytes).
  if (base64.length > 6_000_000) {
    return NextResponse.json(
      { error: "File too large - keep it under ~4MB." },
      { status: 413 }
    );
  }

  const region = body.region ? String(body.region).slice(0, 120) : undefined;
  const context = String(body.context ?? "").slice(0, 2000);
  const rfq: StructuredRFQ = { ...DEFAULT_RFQ, ...(body.rfq && typeof body.rfq === "object" ? body.rfq : {}) };
  const history = context || undefined;

  const floor = await floorPriceFor(region, rfq).catch(() => null);

  let transcript: { text: string; language?: string; source: string } | null = null;
  let extraction: ExtractedOffer;
  let interpretation: string;

  if (kind === "audio") {
    transcript = await transcribeAudio({ mime, base64, region });
    if (!transcript) {
      return NextResponse.json({
        kind,
        transcript: null,
        note: "No transcription produced (add a GROQ_TOKEN or GEMINI_TOKEN in Keys to enable voice).",
      });
    }
    interpretation = transcript.text;
    // Feed the transcript through the SAME extractor the live loop uses.
    extraction = await extractOffer(rfq, `(voice note) ${transcript.text}`, [], history, region);
  } else {
    extraction = await extractOffer(rfq, context || "See attached image.", [{ mime, base64 }], history, region);
    interpretation = JSON.stringify(
      {
        found: extraction.found,
        pricePerDay: extraction.pricePerDay,
        currency: extraction.currency,
        matchesSpec: extraction.matchesSpec,
        imageKind: extraction.imageKind,
        vehicleDescription: extraction.vehicleDescription,
      },
      null,
      2
    );
  }

  // An all-nulls extraction on an image means NO vision model answered (not a
  // bad photo). Say so explicitly WITH each provider's verbatim error - a
  // silent shrug made a perfectly readable price sheet look like an agent
  // failure when the real story was e.g. a Gemini quota error.
  const { lastVisionDiagnostics } = await import("@/lib/ai");
  const visionAttempts = kind === "image" ? lastVisionDiagnostics() : [];
  const visionSilent =
    kind === "image" && !extraction.found && !extraction.pricePerDay && !extraction.imageKind;
  const note = visionSilent
    ? "No vision model answered - every attempt is listed below with its exact error. " +
      (visionAttempts.some((a) => a.error?.includes("not configured"))
        ? "Add the missing key in Admin -> Keys, then retry."
        : "Fix the reported provider error (quota / key restriction), then retry.")
    : undefined;

  const coherence = await validateMediaCoherence({
    kind,
    interpretation,
    extraction,
    history: history ?? "(no conversation context provided)",
    rfq,
    floorPrice: floor?.currency === extraction.currency ? floor?.floor : undefined,
    floorTypical: floor?.currency === extraction.currency ? floor?.typical ?? undefined : undefined,
    region,
    llmAllowed: true,
  });

  return NextResponse.json({
    kind,
    transcript,
    extraction,
    coherence,
    note,
    visionAttempts,
    floor: floor ? { floor: floor.floor, typical: floor.typical, currency: floor.currency } : null,
  });
}

export const maxDuration = 60;
