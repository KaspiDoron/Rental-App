"use client";

import { useState } from "react";
import type { Vendor, StructuredRFQ, Offer } from "@/lib/types";
import { Modal } from "./Modal";
import { Icon } from "./icons";
import { LoadingDots } from "./LoadingDots";
import { useI18n } from "@/lib/i18n";
import { moneyLocal } from "@/lib/currency";

// Manual FALLBACK for adding a shop's reply (text or a photo of a price list).
// With WhatsApp connected, replies flow in automatically via the webhook and
// this modal is rarely needed. The Offer Extraction Agent only accepts a price
// it is sure matches the exact requested vehicle - otherwise it sends a
// clarification question back, from inside the app.
export function PasteReplyModal({
  vendor,
  rfq,
  round,
  firstQuote,
  onOffer,
  onClose,
}: {
  vendor: Vendor;
  rfq: StructuredRFQ;
  round: number;
  firstQuote?: number;
  onOffer: (offer: Offer, verified: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [clarifyState, setClarifyState] = useState<"idle" | "sending" | "sent" | "manual">("idle");
  const [result, setResult] = useState<{
    found: boolean;
    pricePerDay?: number;
    currency?: string;
    matchesSpec: boolean;
    confidence: string;
    clarifyMessage?: string;
    vehicleDescription?: string;
  } | null>(null);

  function addFiles(files: FileList | null) {
    if (!files) return;
    Array.from(files)
      .slice(0, 3 - images.length)
      .forEach((f) => {
        const reader = new FileReader();
        reader.onload = () =>
          setImages((prev) => [...prev, String(reader.result)].slice(0, 3));
        reader.readAsDataURL(f);
      });
  }

  async function analyze() {
    if (!text.trim() && images.length === 0) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/extract-offer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rfq,
          text,
          images,
          vendorId: vendor.id,
          vendorName: vendor.name,
          round,
          firstQuote,
        }),
      });
      const data = await res.json();
      setResult(data);
      if (data.found && data.pricePerDay) {
        const verified = data.matchesSpec && data.confidence === "high";
        onOffer(
          {
            pricePerDay: data.pricePerDay,
            listPricePerDay: firstQuote ?? data.pricePerDay,
            currency: data.currency ?? "USD",
            totalPrice: Math.round(data.pricePerDay * rfq.durationDays),
            includesInsurance: false,
            includesDelivery: false,
            round,
            verified,
            simulated: false,
            message: text.slice(0, 200),
          },
          verified
        );
      }
    } finally {
      setBusy(false);
    }
  }

  // Send the clarification question WITHOUT leaving the app.
  async function sendClarify(message: string) {
    setClarifyState("sending");
    try {
      const res = await fetch("/api/outreach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: vendor.whatsapp || undefined,
          placeId: vendor.placeId,
          vendorId: vendor.id,
          vendorName: vendor.name,
          message,
          kind: "clarify",
          rfq,
          round,
        }),
      });
      const d = await res.json();
      setClarifyState(d.sent ? "sent" : "manual");
    } catch {
      setClarifyState("manual");
    }
  }

  return (
    <Modal onClose={onClose}>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-extrabold text-strong">{t("Add the shop's reply")}</h2>
          <p className="text-[12px] text-faint">{vendor.name}</p>
        </div>
        <button onClick={onClose} className="btn btn-sm btn-ghost rounded-xl px-3" aria-label="Close">
          ✕
        </button>
      </div>

      <p className="mb-2 rounded-xl bg-brandblue-soft p-2 text-[11px] font-bold text-brandblue">
        {t("Fallback only: with WhatsApp connected, replies arrive here by themselves.")}
      </p>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder={t("Paste what the shop replied...")}
        className="w-full resize-none rounded-2xl border-2 border-line bg-card p-3 text-sm text-strong placeholder:text-faint focus:border-brandblue focus:outline-none"
      />

      <div className="mt-2 flex items-center gap-2">
        {images.map((img, i) => (
          <div key={i} className="relative h-14 w-14 overflow-hidden rounded-xl border-2 border-line">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={img} alt="" className="h-full w-full object-cover" />
            <button
              type="button"
              onClick={() => setImages((p) => p.filter((_, j) => j !== i))}
              className="absolute right-0 top-0 flex h-5 w-5 items-center justify-center bg-black/60 text-[11px] text-white"
            >
              ✕
            </button>
          </div>
        ))}
        {images.length < 3 && (
          <label
            className="btn flex h-14 w-14 cursor-pointer items-center justify-center rounded-xl border-2 border-dashed border-line text-faint hover:border-brandblue hover:text-brandblue"
            aria-label="Add price-list photo"
          >
            <input
              type="file"
              accept="image/*"
              multiple
              className="sr-only"
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <Icon name="plus" className="h-5 w-5" />
          </label>
        )}
        <span className="text-[11px] text-faint">
          {t("Photo of a price list? The agent reads images too.")}
        </span>
      </div>

      <button
        onClick={analyze}
        disabled={busy || (!text.trim() && images.length === 0)}
        className="btn btn-primary mt-3 w-full rounded-2xl py-3 text-sm disabled:opacity-60"
      >
        {busy ? <LoadingDots light label={t("Agent reading the reply")} /> : t("Analyze reply")}
      </button>

      {result && (
        <div className="mt-3 rounded-2xl bg-card2 p-3">
          {result.found && result.pricePerDay ? (
            <>
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-bold text-soft">{t("Detected price")}</span>
                <span className="text-xl font-extrabold text-strong">
                  {moneyLocal(result.pricePerDay, result.currency)}/{t("day")}
                </span>
              </div>
              {result.matchesSpec && result.confidence === "high" ? (
                <div className="mt-1 flex items-center gap-1.5 text-[12px] font-bold text-savings">
                  <Icon name="check" className="h-4 w-4" /> {t("Verified: matches your exact vehicle.")}
                </div>
              ) : (
                <div className="mt-1 text-[12px] font-bold text-brandyellow">
                  {t("Not 100% sure this price is for your exact vehicle - the offer is marked unconfirmed. Send the question below to verify:")}
                </div>
              )}
            </>
          ) : (
            <div className="text-[13px] font-bold text-soft">
              {t("No clear price found. Ask the shop:")}
            </div>
          )}
          {result.clarifyMessage && (
            <>
              <p className="mt-2 rounded-xl bg-card p-2.5 text-[13px] text-soft">
                {result.clarifyMessage}
              </p>
              <div className="mt-2">
                <button
                  onClick={() => sendClarify(result.clarifyMessage!)}
                  disabled={clarifyState === "sending" || clarifyState === "sent"}
                  className="btn w-full rounded-xl bg-savings py-2 text-center text-[12px] font-extrabold text-white disabled:opacity-70"
                >
                  {clarifyState === "sending" ? (
                    <LoadingDots light label={t("Sending")} />
                  ) : clarifyState === "sent" ? (
                    `✓ ${t("Sent from the app")}`
                  ) : (
                    t("Send via WhatsApp")
                  )}
                </button>
              </div>
              {clarifyState === "manual" && (
                <a
                  href="/profile"
                  className="mt-1.5 block rounded-xl bg-brandyellow-soft p-2 text-center text-[11px] font-bold text-[#8a6100] dark:text-brandyellow"
                >
                  {t("Not sent - connect your WhatsApp in Profile first.")} →
                </a>
              )}
            </>
          )}
          {result.found && (
            <button onClick={onClose} className="btn btn-primary mt-2 w-full rounded-xl py-2 text-[13px]">
              {t("Done")}
            </button>
          )}
        </div>
      )}
    </Modal>
  );
}
