"use client";

import type { TrackerStage } from "@/lib/types";

const FLOW: { key: TrackerStage; label: string }[] = [
  { key: "locating-contact", label: "Locating" },
  { key: "rfq-sent", label: "RFQ Sent" },
  { key: "awaiting-response", label: "Awaiting" },
  { key: "negotiating", label: "Negotiating" },
  { key: "offer-received", label: "Offer" },
];

const ORDER: TrackerStage[] = [
  "queued",
  "locating-contact",
  "found",
  "rfq-sent",
  "awaiting-response",
  "negotiating",
  "offer-received",
];

export function StageBadge({ stage }: { stage: TrackerStage }) {
  const map: Record<TrackerStage, { text: string; cls: string }> = {
    queued: { text: "Queued", cls: "bg-card2 text-faint" },
    "locating-contact": { text: "Locating", cls: "bg-brandblue-soft text-brandblue" },
    found: { text: "Ready", cls: "bg-card2 text-soft" },
    "no-contact": { text: "No WhatsApp", cls: "bg-card2 text-faint" },
    "rfq-sent": { text: "RFQ sent", cls: "bg-brandblue-soft text-brandblue" },
    "awaiting-response": {
      text: "Awaiting reply",
      cls: "bg-brandyellow-soft text-[#8a6100] dark:text-brandyellow",
    },
    negotiating: { text: "Negotiating", cls: "bg-brandred-soft text-brandred" },
    "offer-received": { text: "Offer in", cls: "bg-savings-soft text-savings" },
    "no-response": { text: "No response", cls: "bg-card2 text-faint" },
    declined: { text: "Declined", cls: "bg-brandred-soft text-brandred" },
  };
  const s = map[stage];
  const live =
    stage === "negotiating" ||
    stage === "awaiting-response" ||
    stage === "locating-contact";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold ${s.cls}`}
    >
      {live && (
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-pulse-ring rounded-full bg-current opacity-70" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
        </span>
      )}
      {s.text}
    </span>
  );
}

/**
 * Plain-language, reassuring line describing what the AI agent is doing right
 * now - so the user always knows what step we are on and feels in control while
 * the agent does the work. English strings; translate at the call site with t().
 */
export function stageCaption(stage: TrackerStage): { emoji: string; text: string } {
  switch (stage) {
    case "queued":
      return { emoji: "🕓", text: "Queued - your agent starts on this shop in a moment." };
    case "locating-contact":
      return { emoji: "🔎", text: "Your agent is finding this shop's WhatsApp number." };
    case "found":
      return { emoji: "🎯", text: "Shop found - ask for the price and your agent takes it from there." };
    case "no-contact":
      return { emoji: "📵", text: "No WhatsApp number found for this shop - a nearby shop may work better." };
    case "rfq-sent":
      return { emoji: "📨", text: "Your agent messaged the shop asking for the best price." };
    case "awaiting-response":
      return { emoji: "⏳", text: "Waiting for the shop to reply - your agent is watching for it." };
    case "negotiating":
      return { emoji: "🤝", text: "Your agent is haggling with the shop for a lower price." };
    case "offer-received":
      return { emoji: "✅", text: "Price is in - review the shop's offer below." };
    case "no-response":
      return { emoji: "💤", text: "No reply yet. Your agent will keep watching for one." };
    case "declined":
      return { emoji: "🚫", text: "This shop passed - other shops are still negotiating." };
    default:
      return { emoji: "🤖", text: "Your agent is on it." };
  }
}

/** Horizontal pipeline showing progress through the negotiation flow. */
export function Pipeline({ stage }: { stage: TrackerStage }) {
  const idx = ORDER.indexOf(stage);
  const failed = stage === "no-response" || stage === "declined" || stage === "no-contact";
  return (
    <div className="flex items-center gap-1">
      {FLOW.map((step) => {
        const stepIdx = ORDER.indexOf(step.key);
        const done = idx >= stepIdx && !failed;
        const active = stage === step.key;
        return (
          <div key={step.key} className="flex flex-1 items-center gap-1">
            <div
              className={`h-1.5 flex-1 rounded-full transition-colors duration-500 ${
                done ? "bg-brandblue" : failed ? "bg-brandred/40" : "bg-line"
              } ${active ? "animate-pulse" : ""}`}
            />
          </div>
        );
      })}
    </div>
  );
}
