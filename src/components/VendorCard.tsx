"use client";

import { useState } from "react";
import type { Vendor, StructuredRFQ } from "@/lib/types";
import { StageBadge, Pipeline, stageCaption } from "./Tracker";
import { Icon } from "./icons";
import { AnimatedNumber } from "./SavingsTicker";
import { LoadingDots } from "./LoadingDots";
import { PhotoGallery } from "./PhotoGallery";
import { useI18n } from "@/lib/i18n";

// A rental-shop card. Prices are NEVER invented - we first ask the shop, and
// only its real reply produces a price. Everything happens INSIDE the app:
// the RFQ is sent from here via the official WhatsApp Cloud API, and the
// shop's answer flows back into this card automatically through the webhook.
export function VendorCard({
  vendor,
  rfq,
  plan,
  waConnected,
  onBook,
  onReviews,
  onBargain,
  onStage,
  onCustomMessage,
}: {
  vendor: Vendor;
  rfq: StructuredRFQ | null;
  plan?: string;
  waConnected: boolean;
  onBook: (vendor: Vendor) => void;
  onReviews: (vendor: Vendor) => void;
  onBargain: (vendor: Vendor) => void;
  onStage: (vendorId: string, stage: Vendor["stage"]) => void;
  onCustomMessage: (
    vendorId: string,
    message: string
  ) => Promise<{ allowed: boolean; reason?: string; suggestion?: string }>;
}) {
  const { t } = useI18n();
  const [chatOpen, setChatOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [chatState, setChatState] = useState<{
    status: "idle" | "checking" | "sent" | "blocked";
    reason?: string;
    suggestion?: string;
  }>({ status: "idle" });
  const [rfqState, setRfqState] = useState<
    "idle" | "sending" | "sent" | "no-phone" | "not-connected" | "rate-limited"
  >("idle");
  const [rfqError, setRfqError] = useState<string | null>(null);
  const [galleryOpen, setGalleryOpen] = useState(false);

  const offer = vendor.offer;
  const savings =
    offer && rfq
      ? Math.max(0, (offer.listPricePerDay - offer.pricePerDay) * rfq.durationDays)
      : 0;

  // Send the RFQ WITHOUT leaving the app: safety-screened, dispatched via the
  // official Cloud API, thread logged so the reply lands here automatically.
  async function sendRfq() {
    if (!rfq) return;
    setRfqState("sending");
    try {
      const res = await fetch("/api/outreach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: vendor.whatsapp || undefined,
          placeId: vendor.placeId,
          vendorId: vendor.id,
          vendorName: vendor.name,
          message: rfq.vendorMessage,
          kind: "rfq",
          rfq,
          round: 0,
        }),
      });
      const d = await res.json();
      if (d.sent) {
        setRfqState("sent");
        onStage(vendor.id, "rfq-sent");
        setTimeout(() => onStage(vendor.id, "awaiting-response"), 1200);
      } else if (d.reason === "no-phone") {
        setRfqState("no-phone");
      } else if (d.rateLimited) {
        setRfqState("rate-limited");
        setRfqError(d.error ?? null);
      } else if (d.reconnecting) {
        // Transient drop (server waking) - no re-link needed, just retry.
        setRfqState("rate-limited");
        setRfqError(d.error ?? null);
      } else {
        // We NEVER pretend a message was sent: without a connected WhatsApp
        // nothing goes out, and the user is told exactly that.
        setRfqState("not-connected");
      }
    } catch {
      setRfqState("not-connected");
    }
  }

  async function sendCustom() {
    if (!draft.trim()) return;
    setChatState({ status: "checking" });
    const verdict = (await onCustomMessage(vendor.id, draft.trim())) as {
      allowed: boolean;
      sent?: boolean;
      reason?: string;
      suggestion?: string;
    };
    if (verdict.allowed && !verdict.sent) {
      setChatState({
        status: "blocked",
        reason: t("Not sent: connect your WhatsApp in Profile first - messages leave WheelDeal only through WhatsApp."),
      });
      return;
    }
    if (verdict.allowed) {
      setChatState({ status: "sent" });
      setDraft("");
      setTimeout(() => {
        setChatOpen(false);
        setChatState({ status: "idle" });
      }, 1600);
    } else {
      setChatState({
        status: "blocked",
        reason: verdict.reason,
        suggestion: verdict.suggestion,
      });
    }
  }

  return (
    <div className="surface lift overflow-hidden rounded-blob">
      {vendor.photoUrl && (
        <div className="relative h-32 w-full">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={vendor.photoUrl} alt="" className="h-full w-full object-cover" />
          {vendor.openNow !== undefined && (
            <span
              className={`absolute left-3 top-3 rounded-full px-2.5 py-1 text-[11px] font-extrabold ${
                vendor.openNow ? "bg-savings text-white" : "bg-brandred text-white"
              }`}
            >
              {vendor.openNow ? t("Open now") : t("Closed")}
            </span>
          )}
        </div>
      )}

      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-[16px] font-extrabold text-strong">{vendor.name}</h3>
              {vendor.demo && (
                <span className="shrink-0 rounded-full bg-brandyellow-soft px-2 py-0.5 text-[10px] font-extrabold text-[#8a6100] dark:text-brandyellow">
                  {t("Demo")}
                </span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-soft">
              <button
                onClick={() => onReviews(vendor)}
                className="chip inline-flex items-center gap-1 font-bold text-strong"
              >
                <Icon name="star" className="h-3.5 w-3.5 text-brandyellow" />
                {vendor.rating ? vendor.rating.toFixed(1) : t("New")}
                <span className="font-semibold text-brandblue underline decoration-dotted">
                  {vendor.reviews} {t("reviews")}
                </span>
              </button>
              <span className="inline-flex items-center gap-1">
                <Icon name="pin" className="h-3.5 w-3.5 text-brandred" />
                {vendor.distanceKm?.toFixed(1)} km
              </span>
              {(vendor.photoUrls?.length ?? 0) > 1 && (
                <button
                  onClick={() => setGalleryOpen(true)}
                  className="chip inline-flex items-center gap-1 font-bold text-brandblue"
                >
                  🖼 {vendor.photoUrls!.length} {t("photos")}
                </button>
              )}
            </div>
            {/* Real Google data chips */}
            <div className="mt-1 flex flex-wrap gap-1">
              {vendor.todayHours && (
                <span className="rounded-md bg-card2 px-1.5 py-0.5 text-[10px] font-bold text-soft">
                  🕒 {vendor.todayHours}
                </span>
              )}
              {(vendor.orders ?? 0) > 0 ? (
                <span className="rounded-md bg-savings-soft px-1.5 py-0.5 text-[10px] font-extrabold text-savings">
                  ✓ {vendor.orders} {t("booked here on WheelDeal")}
                </span>
              ) : (
                <span className="rounded-md bg-brandblue-soft px-1.5 py-0.5 text-[10px] font-extrabold text-brandblue">
                  ✨ {t("New on WheelDeal")}
                </span>
              )}
            </div>
            {vendor.address && (
              <div className="mt-1 truncate text-[12px] text-faint">{vendor.address}</div>
            )}
          </div>
          {vendor.stage && <StageBadge stage={vendor.stage} />}
        </div>

        <div className="mt-3">
          <Pipeline stage={vendor.stage ?? "queued"} />
          {vendor.stage && vendor.stage !== "offer-received" && (
            <div className="mt-2 flex items-start gap-1.5 rounded-xl bg-card2 p-2 text-[11px] font-bold text-soft">
              <span className="shrink-0">{stageCaption(vendor.stage).emoji}</span>
              <span>{t(stageCaption(vendor.stage).text)}</span>
            </div>
          )}
        </div>

        {offer ? (
          <div className="mt-3 rounded-2xl bg-card2 p-3">
            <div className="flex items-end justify-between">
              <div>
                <div className="flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-wide text-faint">
                  {t("Shop's offer")}
                  {offer.verified ? (
                    <span className="rounded bg-savings-soft px-1.5 py-0.5 text-[9px] font-extrabold text-savings">
                      {t("VERIFIED")}
                    </span>
                  ) : (
                    <span className="rounded bg-brandyellow-soft px-1.5 py-0.5 text-[9px] font-extrabold text-[#8a6100] dark:text-brandyellow">
                      {t("UNCONFIRMED")}
                    </span>
                  )}
                </div>
                <div className="text-2xl font-extrabold text-strong">
                  $<AnimatedNumber value={offer.pricePerDay} />
                  <span className="text-sm font-bold text-faint">/{t("day")}</span>
                </div>
                <div className="text-[12px] text-soft">
                  ${offer.totalPrice.toLocaleString()} {t("total")} · {rfq?.durationDays}d
                </div>
              </div>
              {savings > 0 && (
                <div className="text-right">
                  <div className="badge-flash rounded-full px-2 py-0.5 text-[10px] font-extrabold">
                    🤝 {t("Authentic bargain")}
                  </div>
                  <div className="mt-1 text-lg font-extrabold text-savings">
                    -$
                    <AnimatedNumber value={Math.round(savings)} />
                  </div>
                </div>
              )}
            </div>

            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={() => onBook(vendor)}
                className="btn btn-primary flex-1 rounded-2xl px-3 py-2.5 text-sm"
              >
                {t("Lock this deal")}
              </button>
              <button
                onClick={() => onBargain(vendor)}
                className="btn btn-sm chip rounded-2xl border-2 border-brandred/30 bg-brandred-soft px-3 py-2.5 text-[12px] font-extrabold text-brandred"
              >
                🥊 {t("Bargain")}
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-3 rounded-2xl bg-card2 p-3">
            <div className="text-[12px] font-bold text-soft">
              {t("No price yet - we first ask the shop. Real prices come only from its reply.")}
            </div>
            {plan === "free" && (
              <div className="mt-1.5 text-[11px] font-bold text-brandyellow">
                {t("Free plan: same-day pickup scheduling only.")}
              </div>
            )}

            <div className="mt-2">
              <button
                onClick={sendRfq}
                disabled={!waConnected || rfqState === "sending" || rfqState === "sent"}
                className={`btn w-full rounded-2xl py-2.5 text-[13px] font-extrabold text-white disabled:opacity-60 ${
                  waConnected ? "bg-savings hover:brightness-95" : "bg-faint"
                }`}
              >
                {rfqState === "sending" ? (
                  <LoadingDots light label={t("Sending")} />
                ) : rfqState === "sent" ? (
                  `✓ ${t("Sent - reply lands here")}`
                ) : waConnected ? (
                  t("Ask for price")
                ) : (
                  `🔒 ${t("Ask for price")}`
                )}
              </button>
              {!waConnected && (
                <a
                  href="/profile"
                  className="mt-1 block text-center text-[10px] font-bold text-brandblue underline"
                >
                  {t("Connect WhatsApp in Profile to unlock")} →
                </a>
              )}
            </div>

            {rfqState === "sent" && (
              <div className="mt-1.5 text-[11px] font-bold text-savings">
                {t("Sent from inside the app. When the shop answers, the agent reads it and the price appears here automatically.")}
              </div>
            )}
            {rfqState === "no-phone" && (
              <div className="mt-1.5 text-[11px] text-faint">
                {t("No phone number found for this shop yet - try another shop nearby.")}
              </div>
            )}
            {rfqState === "not-connected" && (
              <div className="mt-1.5 rounded-xl bg-brandyellow-soft p-2 text-[11px] font-bold text-[#8a6100] dark:text-brandyellow">
                {t("Nothing was sent. Connect your WhatsApp first - it takes 30 seconds and the agents handle everything after that.")}
                <a
                  href="/profile"
                  className="btn btn-sm mt-1.5 block w-full rounded-lg bg-card py-1.5 text-center text-[11px] font-extrabold text-brandblue"
                >
                  {t("Connect WhatsApp in Profile")} →
                </a>
              </div>
            )}
            {rfqState === "rate-limited" && (
              <div className="mt-1.5 rounded-xl bg-brandyellow-soft p-2 text-[11px] font-bold text-[#8a6100] dark:text-brandyellow">
                {rfqError ?? t("Safety pause - try again in a few minutes.")}
              </div>
            )}
          </div>
        )}

        <div className="mt-2 flex items-center justify-between">
          <button
            onClick={() => waConnected && setChatOpen((o) => !o)}
            disabled={!waConnected}
            className={`btn btn-sm text-[12px] font-bold ${
              waConnected ? "text-brandblue" : "text-faint"
            }`}
          >
            <span className="inline-flex items-center gap-1">
              <Icon name="send" className="h-3.5 w-3.5" />{" "}
              {waConnected ? t("Ask something custom") : `🔒 ${t("Ask something custom")}`}
            </span>
          </button>
        </div>

        {galleryOpen && vendor.photoUrls && (
          <PhotoGallery
            name={vendor.name}
            photos={vendor.photoUrls}
            onClose={() => setGalleryOpen(false)}
          />
        )}

        {chatOpen && (
          <div className="mt-2 rounded-2xl border-2 border-line bg-card p-3">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-bold text-soft">
              <Icon name="shield" className="h-3.5 w-3.5 text-savings" />
              {t("Screened by the safety agent, then sent from the app.")}
            </div>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={2}
              maxLength={600}
              placeholder={t("Ask this shop something specific...")}
              className="w-full resize-none rounded-xl border-2 border-line bg-card2 p-2 text-sm text-strong placeholder:text-faint focus:border-brandblue focus:outline-none"
            />
            {chatState.status === "blocked" && (
              <div className="mt-1 rounded-xl bg-brandred-soft p-2 text-[12px] font-semibold text-brandred">
                {chatState.reason ?? t("Message blocked.")}
                {chatState.suggestion && (
                  <div className="mt-1 opacity-80">
                    {t("Try:")} {chatState.suggestion}
                  </div>
                )}
              </div>
            )}
            {chatState.status === "sent" && (
              <div className="mt-1 text-[12px] font-bold text-savings">✓ {t("Sent")}</div>
            )}
            <button
              onClick={sendCustom}
              disabled={chatState.status === "checking" || !draft.trim()}
              className="btn btn-primary mt-2 w-full rounded-xl py-2 text-sm disabled:opacity-50"
            >
              {chatState.status === "checking" ? (
                <LoadingDots light label={t("Screening")} />
              ) : (
                t("Screen & send")
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
