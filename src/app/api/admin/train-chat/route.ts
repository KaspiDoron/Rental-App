import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { extractOffer, composeBargain, currencyForRegion, money } from "@/lib/agents";
import { floorPriceFor } from "@/lib/market";
import { addTraining } from "@/lib/memory";
import { sbInsert } from "@/lib/runtime-config";
import type { StructuredRFQ } from "@/lib/types";

// Interactive agent-training studio (New#13). The owner/manager plays a rental
// SHOP and chats with the real bargaining agent. We run the SAME brain the
// funnel uses (extractOffer -> decide -> composeBargain) and return the agent's
// reply PLUS its transparent reasoning (what it understood, its target, what it
// would remember). action:"save" stores the whole session as a training
// memory the agents learn from.

interface Turn {
  role: "shop" | "agent";
  text: string;
}

const DEFAULT_RFQ: StructuredRFQ = {
  vehicleClass: "scooter",
  transmission: "automatic",
  durationDays: 3,
  accessories: [],
  fulfillment: "any",
  vendorMessage: "",
};

export async function POST(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  // Global: no country is baked in. If the owner leaves the area blank the agent
  // simply bargains in a neutral currency until an area is given.
  const region = String(body.region ?? "").trim();
  const rfq: StructuredRFQ = { ...DEFAULT_RFQ, ...(body.rfq ?? {}) };
  const turns: Turn[] = Array.isArray(body.turns) ? body.turns : [];

  // Save the whole session as a learnable memory.
  if (body.action === "save") {
    const transcript = turns
      .map((t) => `${t.role === "agent" ? "Me" : "Shop"}: ${t.text}`)
      .join("\n")
      .slice(0, 3500);
    if (transcript.length < 20) {
      return NextResponse.json({ error: "Nothing to save yet." }, { status: 400 });
    }
    const ex = addTraining(transcript, "training");
    await sbInsert("agent_training", [
      { text: ex.text, note: "training", added_by: session.email, source: "training" },
    ]).catch(() => {});
    return NextResponse.json({ ok: true, saved: true });
  }

  const history = turns
    .map((t) => `${t.role === "agent" ? "Us" : "Shop"}: ${t.text}`)
    .join("\n");
  const lastShop = [...turns].reverse().find((t) => t.role === "shop")?.text ?? "";
  const cur = currencyForRegion(region) || "USD";

  // Read what the shop said (price? matches the vehicle? still unclear?).
  const extraction = await extractOffer(rfq, lastShop || "(no message yet)", [], history);
  const priorBargains = turns.filter(
    (t) => t.role === "agent" && /best|deal|discount|possible|\bfor\b.*\bday/i.test(t.text)
  ).length;

  let agentMessage = "";
  let action = "clarify";
  let reasoning = "";
  const usable = extraction.found ? extraction.pricePerDay : undefined;

  if (!usable && extraction.clarifyMessage && priorBargains === 0) {
    agentMessage = extraction.clarifyMessage;
    action = "clarify";
    reasoning = "No clear price yet for the exact vehicle, so I ask ONE clarifying question.";
  } else if (usable && priorBargains === 0) {
    const floor = await floorPriceFor(region, rfq);
    const floorPrice = floor && floor.currency === cur ? floor.floor : undefined;
    const target = floorPrice
      ? Math.max(floorPrice, Math.round(usable * 0.6))
      : Math.round(usable * 0.85);
    if (floorPrice && usable <= floorPrice * 1.05) {
      agentMessage = "Perfect, that works - thanks so much! I'll confirm shortly.";
      action = "close (already at floor)";
      reasoning = `They quoted ${money(usable, cur)}/day, at/under the local floor ${money(
        floorPrice,
        cur
      )} - no point pushing, so I close warmly.`;
    } else {
      const draft = await composeBargain({
        rfq,
        vendor: { name: "the shop" } as never,
        currentPricePerDay: usable,
        region,
        round: 1,
        currency: cur,
        targetPricePerDay: target,
        floorPricePerDay: floorPrice,
        history,
      });
      agentMessage = draft.message;
      action = "bargain (one ask)";
      reasoning = `They quoted ${money(usable, cur)}/day. Local floor ${
        floorPrice ? money(floorPrice, cur) : "unknown"
      }. I make my ONE friendly ask at ${money(target, cur)}/day - never lower, never pushy.`;
    }
  } else {
    agentMessage = "No worries at all - thanks for your time! I'll get back to you.";
    action = "close (no push)";
    reasoning = "I already made my one ask, so whatever they said, I thank them and stop - no pushing.";
  }

  return NextResponse.json({
    agentMessage,
    action,
    reasoning,
    understood: {
      foundPrice: extraction.found ? extraction.pricePerDay : null,
      currency: extraction.currency ?? cur,
      matchesVehicle: extraction.matchesSpec,
      confidence: extraction.confidence,
    },
  });
}
