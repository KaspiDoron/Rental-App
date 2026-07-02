"use client";

import { useRef, useState } from "react";
import type { Vendor, StructuredRFQ, Offer } from "@/lib/types";
import { Modal } from "./Modal";
import { Icon } from "./icons";
import { LoadingDots } from "./LoadingDots";

// The vendor replied on WhatsApp (text or a photo of a price list). Paste it
// here; the Offer Extraction Agent reads it and only accepts a price it is
// sure matches the exact requested vehicle - otherwise it drafts a
// clarification question to send back.
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
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    found: boolean;
    pricePerDay?: number;
    matchesSpec: boolean;
    confidence: string;
    clarifyMessage?: string;
    vehicleDescription?: string;
  } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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

  const waNumber = vendor.whatsapp.replace(/[^\d]/g, "");

  return (
    <Modal onClose={onClose}>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-extrabold text-strong">Vendor reply</h2>
          <p className="text-[12px] text-faint">{vendor.name}</p>
        </div>
        <button onClick={onClose} className="btn btn-sm btn-ghost rounded-xl px-3" aria-label="Close">
          ✕
        </button>
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder="Paste what the shop replied on WhatsApp..."
        className="w-full resize-none rounded-2xl border-2 border-line bg-card p-3 text-sm text-strong placeholder:text-faint focus:border-brandblue focus:outline-none"
      />

      <div className="mt-2 flex items-center gap-2">
        {images.map((img, i) => (
          <div key={i} className="relative h-14 w-14 overflow-hidden rounded-xl border-2 border-line">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={img} alt="" className="h-full w-full object-cover" />
            <button
              onClick={() => setImages((p) => p.filter((_, j) => j !== i))}
              className="absolute right-0 top-0 flex h-5 w-5 items-center justify-center bg-black/60 text-[11px] text-white"
            >
              ✕
            </button>
          </div>
        ))}
        {images.length < 3 && (
          <button
            onClick={() => fileRef.current?.click()}
            className="btn flex h-14 w-14 items-center justify-center rounded-xl border-2 border-dashed border-line text-faint hover:border-brandblue hover:text-brandblue"
            aria-label="Add price-list photo"
          >
            <Icon name="plus" className="h-5 w-5" />
          </button>
        )}
        <span className="text-[11px] text-faint">Photo of a price list? The agent reads images too.</span>
      </div>
      <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => addFiles(e.target.files)} />

      <button
        onClick={analyze}
        disabled={busy || (!text.trim() && images.length === 0)}
        className="btn btn-primary mt-3 w-full rounded-2xl py-3 text-sm disabled:opacity-60"
      >
        {busy ? <LoadingDots light label="Agent reading the reply" /> : "Analyze reply"}
      </button>

      {result && (
        <div className="mt-3 rounded-2xl bg-card2 p-3">
          {result.found && result.pricePerDay ? (
            <>
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-bold text-soft">Detected price</span>
                <span className="text-xl font-extrabold text-strong">
                  ${result.pricePerDay}/day
                </span>
              </div>
              {result.matchesSpec && result.confidence === "high" ? (
                <div className="mt-1 flex items-center gap-1.5 text-[12px] font-bold text-savings">
                  <Icon name="check" className="h-4 w-4" /> Verified: matches your exact vehicle.
                </div>
              ) : (
                <div className="mt-1 text-[12px] font-bold text-brandyellow">
                  Not 100% sure this price is for your exact vehicle - the offer
                  is marked unconfirmed. Send the question below to verify:
                </div>
              )}
            </>
          ) : (
            <div className="text-[13px] font-bold text-soft">
              No clear price found. Ask the shop:
            </div>
          )}
          {result.clarifyMessage && (
            <>
              <p className="mt-2 rounded-xl bg-card p-2.5 text-[13px] text-soft">
                {result.clarifyMessage}
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => navigator.clipboard?.writeText(result.clarifyMessage!)}
                  className="btn btn-ghost btn-sm flex-1 rounded-xl text-[12px]"
                >
                  Copy
                </button>
                {waNumber && (
                  <a
                    href={`https://wa.me/${waNumber}?text=${encodeURIComponent(result.clarifyMessage)}`}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-sm flex-1 rounded-xl bg-savings text-center text-[12px] font-extrabold leading-9 text-white"
                  >
                    Send on WhatsApp
                  </a>
                )}
              </div>
            </>
          )}
          {result.found && (
            <button onClick={onClose} className="btn btn-primary mt-2 w-full rounded-xl py-2 text-[13px]">
              Done
            </button>
          )}
        </div>
      )}
    </Modal>
  );
}
