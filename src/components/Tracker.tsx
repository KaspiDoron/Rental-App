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
  "rfq-sent",
  "awaiting-response",
  "negotiating",
  "offer-received",
];

export function StageBadge({ stage }: { stage: TrackerStage }) {
  const map: Record<TrackerStage, { text: string; cls: string }> = {
    queued: { text: "Queued", cls: "bg-slate-500/15 text-slate-300" },
    "locating-contact": { text: "Locating", cls: "bg-sky-500/15 text-sky-300" },
    "rfq-sent": { text: "RFQ sent", cls: "bg-indigo-500/15 text-indigo-300" },
    "awaiting-response": {
      text: "Awaiting reply",
      cls: "bg-amber-500/15 text-amber-300",
    },
    negotiating: {
      text: "Negotiating",
      cls: "bg-violet-500/15 text-violet-300",
    },
    "offer-received": {
      text: "Offer in",
      cls: "bg-savings/15 text-savings-bright",
    },
    "no-response": { text: "No response", cls: "bg-slate-600/20 text-slate-400" },
    declined: { text: "Declined", cls: "bg-rose-500/15 text-rose-300" },
  };
  const s = map[stage];
  const live =
    stage === "negotiating" ||
    stage === "awaiting-response" ||
    stage === "locating-contact";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${s.cls}`}
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

/** Horizontal pipeline showing progress through the negotiation flow. */
export function Pipeline({ stage }: { stage: TrackerStage }) {
  const idx = ORDER.indexOf(stage);
  const failed = stage === "no-response" || stage === "declined";
  return (
    <div className="flex items-center gap-1">
      {FLOW.map((step, i) => {
        const stepIdx = ORDER.indexOf(step.key);
        const done = idx >= stepIdx && !failed;
        const active = stage === step.key;
        return (
          <div key={step.key} className="flex flex-1 items-center gap-1">
            <div
              className={`h-1.5 flex-1 rounded-full transition-colors duration-500 ${
                done
                  ? "bg-savings"
                  : failed
                  ? "bg-rose-500/40"
                  : "bg-slate-600/40"
              } ${active ? "animate-pulse" : ""}`}
            />
            {i === FLOW.length - 1 && null}
          </div>
        );
      })}
    </div>
  );
}
