"use client";

// WillGuide (R4): Will as an INTEGRATED on-screen guide banner - NOT a floating
// side widget. It sits inline at the top of the workflow and actively walks the
// user through the deal-search lifecycle, one step at a time, driven by the real
// app state. Tap it to open the full Will chat. Dismissible per stage, but it
// re-appears when the stage changes (it is guidance, not chrome).

import { WillAvatar } from "./WillAvatar";
import { useI18n } from "@/lib/i18n";
import { Icon } from "../icons";

export type WillStage =
  | "connect"      // WhatsApp not linked yet
  | "compose"      // linked, no search yet
  | "dispatching"  // search running / messaging shops
  | "waiting"      // messaged, awaiting replies
  | "offers"       // offers are in - time to pick/bargain
  | "closing";     // a deal is being locked

const COPY: Record<WillStage, { title: string; body: string; cta: string }> = {
  connect: {
    title: "First, let's link your WhatsApp",
    body: "I bargain from your own number so shops talk to a real traveller. One 30-second link and the search unlocks.",
    cta: "How it works",
  },
  compose: {
    title: "Tell me what you want to ride",
    body: "Type it, or build it in taps. Set your stay and radius, then hit Find my deal - I'll message every shop nearby.",
    cta: "Ask Will",
  },
  dispatching: {
    title: "I'm reaching out to the shops now",
    body: "Messages go out from your WhatsApp, paced so your number stays safe. This takes a few minutes - you can leave the app.",
    cta: "Ask Will",
  },
  waiting: {
    title: "Waiting on the shops to reply",
    body: "I'm watching every chat. The moment a price lands I compare it to the real market floor and push for cheaper.",
    cta: "Ask Will",
  },
  offers: {
    title: "Offers are in - want me to push harder?",
    body: "Tap a shop to see its price vs the market target. I never accept for you - when you're happy, tap Book.",
    cta: "Ask Will",
  },
  closing: {
    title: "Locking your deal",
    body: "I'll send the shop a final confirmation, then hand you a direct WhatsApp link to set your exact pickup time.",
    cta: "Ask Will",
  },
};

export function WillGuide({
  stage,
  busy,
  onOpen,
  onDismiss,
}: {
  stage: WillStage;
  busy?: boolean;
  onOpen: () => void;
  onDismiss?: () => void;
}) {
  const { t } = useI18n();
  const c = COPY[stage];
  return (
    <div
      data-tour="will"
      className="relative mt-3 flex items-start gap-3 rounded-2xl border-2 border-brandblue/25 bg-brandblue-soft p-3"
    >
      <div className="shrink-0">
        <WillAvatar size={44} mood={busy ? "thinking" : "idle"} wave={!busy} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-extrabold text-brandblue">{t(c.title)}</div>
        <p className="mt-0.5 text-[12px] font-medium leading-snug text-soft">{t(c.body)}</p>
        <button
          onClick={onOpen}
          className="btn btn-sm mt-2 inline-flex items-center gap-1 rounded-xl bg-brandblue px-3 py-1.5 text-[12px] font-extrabold text-white"
        >
          <Icon name="sparkles" className="h-3.5 w-3.5" /> {t(c.cta)}
        </button>
      </div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          aria-label={t("Dismiss")}
          className="btn btn-sm absolute right-1.5 top-1.5 h-6 w-6 rounded-full text-faint hover:text-soft"
        >
          ✕
        </button>
      )}
    </div>
  );
}

/** Derive the current guide stage from live app state. */
export function willStageFrom(opts: {
  waConnected: boolean;
  phase: string;
  vendorCount: number;
  offerCount: number;
  closing: boolean;
}): WillStage {
  if (!opts.waConnected) return "connect";
  if (opts.closing) return "closing";
  if (opts.offerCount > 0) return "offers";
  if (opts.phase === "profiling" || opts.phase === "running") return "dispatching";
  if (opts.vendorCount > 0) return "waiting";
  return "compose";
}
