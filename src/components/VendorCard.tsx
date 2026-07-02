"use client";

import { useState } from "react";
import type { Vendor, StructuredRFQ } from "@/lib/types";
import { vehicleLabel } from "@/lib/labels";
import { StageBadge, Pipeline } from "./Tracker";
import { Icon } from "./icons";
import { AnimatedNumber } from "./SavingsTicker";

export function VendorCard({
  vendor,
  rfq,
  marketRate,
  onBargain,
  onBook,
  onCustomMessage,
  onReviews,
}: {
  vendor: Vendor;
  rfq: StructuredRFQ | null;
  marketRate: number | null;
  onBargain: (vendorId: string) => void;
  onBook: (vendor: Vendor) => void;
  onCustomMessage: (
    vendorId: string,
    message: string
  ) => Promise<{ allowed: boolean; reason?: string; suggestion?: string }>;
  onReviews: (vendor: Vendor) => void;
}) {
  const [chatOpen, setChatOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [chatState, setChatState] = useState<{
    status: "idle" | "checking" | "sent" | "blocked";
    reason?: string;
    suggestion?: string;
  }>({ status: "idle" });
  const [contact, setContact] = useState<{ waLink?: string; phone?: string } | null>(null);

  const offer = vendor.offer;
  const savings =
    offer && rfq
      ? Math.max(0, (offer.listPricePerDay - offer.pricePerDay) * rfq.durationDays)
      : 0;

  async function openWhatsApp() {
    if (vendor.whatsapp) {
      const msg = encodeURIComponent(rfq?.vendorMessage ?? "");
      window.open(`https://wa.me/${vendor.whatsapp.replace(/[^\d]/g, "")}?text=${msg}`, "_blank");
      return;
    }
    if (vendor.placeId) {
      const res = await fetch(`/api/contact?placeId=${encodeURIComponent(vendor.placeId)}`);
      const data = await res.json();
      if (data.waLink) {
        setContact(data);
        const msg = encodeURIComponent(rfq?.vendorMessage ?? "");
        window.open(`${data.waLink}?text=${msg}`, "_blank");
      } else {
        setContact({ phone: undefined });
      }
    }
  }

  async function sendCustom() {
    if (!draft.trim()) return;
    setChatState({ status: "checking" });
    const verdict = await onCustomMessage(vendor.id, draft.trim());
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
    <div className="surface animate-slide-up overflow-hidden rounded-blob">
      {/* Photo header for real vendors */}
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
              {vendor.openNow ? "Open now" : "Closed"}
            </span>
          )}
        </div>
      )}

      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-[16px] font-extrabold text-strong">
                {vendor.name}
              </h3>
              {vendor.demo ? (
                <span className="shrink-0 rounded-full bg-brandyellow-soft px-2 py-0.5 text-[10px] font-extrabold text-[#8a6100] dark:text-brandyellow">
                  Demo
                </span>
              ) : (
                <span className="shrink-0 rounded-full bg-brandblue-soft px-2 py-0.5 text-[10px] font-extrabold text-brandblue">
                  Real place
                </span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-soft">
              <button
                onClick={() => onReviews(vendor)}
                className="chip inline-flex items-center gap-1 font-bold text-strong"
              >
                <Icon name="star" className="h-3.5 w-3.5 text-brandyellow" />
                {vendor.rating ? vendor.rating.toFixed(1) : "New"}
                <span className="font-semibold text-brandblue underline decoration-dotted">
                  {vendor.reviews} reviews
                </span>
              </button>
              <span className="inline-flex items-center gap-1">
                <Icon name="pin" className="h-3.5 w-3.5 text-brandred" />
                {vendor.distanceKm?.toFixed(1)} km
              </span>
              <span className="inline-flex items-center gap-1">
                <Icon
                  name={vendor.vehicleClasses[0] === "car" ? "car" : "bike"}
                  className="h-3.5 w-3.5"
                />
                {vendor.vehicleClasses.map(vehicleLabel).join(", ")}
              </span>
            </div>
            {vendor.address && (
              <div className="mt-1 truncate text-[12px] text-faint">{vendor.address}</div>
            )}
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {vendor.fulfillment.includes("hotel-delivery") && (
                <span className="rounded-md bg-savings-soft px-2 py-0.5 text-[11px] font-bold text-savings">
                  Hotel delivery
                </span>
              )}
              {vendor.priceLevel !== undefined && (
                <span className="rounded-md bg-card2 px-2 py-0.5 text-[11px] font-bold text-soft">
                  {"$".repeat(Math.max(1, vendor.priceLevel))} price level
                </span>
              )}
              {vendor.partner && (
                <span className="rounded-md bg-brandblue-soft px-2 py-0.5 text-[11px] font-bold text-brandblue">
                  Partner
                </span>
              )}
            </div>
          </div>
          {vendor.stage && <StageBadge stage={vendor.stage} />}
        </div>

        <div className="mt-3">
          <Pipeline stage={vendor.stage ?? "queued"} />
        </div>

        {offer ? (
          <div className="mt-3 rounded-2xl bg-card2 p-3">
            <div className="flex items-end justify-between">
              <div>
                <div className="flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-wide text-faint">
                  Best offer
                  {offer.simulated && (
                    <span className="rounded bg-brandyellow-soft px-1.5 py-0.5 text-[9px] font-extrabold text-[#8a6100] dark:text-brandyellow">
                      SIMULATED
                    </span>
                  )}
                  {offer.verified && (
                    <span className="rounded bg-savings-soft px-1.5 py-0.5 text-[9px] font-extrabold text-savings">
                      VERIFIED
                    </span>
                  )}
                </div>
                <div className="text-2xl font-extrabold text-strong">
                  $<AnimatedNumber value={offer.pricePerDay} />
                  <span className="text-sm font-bold text-faint">/day</span>
                </div>
                <div className="text-[12px] text-soft">
                  ${offer.totalPrice.toLocaleString()} total · {rfq?.durationDays}d
                </div>
              </div>
              {savings > 0 && (
                <div className="text-right">
                  <div className="text-[11px] font-extrabold uppercase tracking-wide text-savings">
                    You save
                  </div>
                  <div className="text-lg font-extrabold text-savings">
                    $<AnimatedNumber value={Math.round(savings)} />
                  </div>
                </div>
              )}
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              {["Beat a nearby quote", "Length discount", "Bundle delivery"].map((b) => (
                <button
                  key={b}
                  onClick={() => onBargain(vendor.id)}
                  className="btn btn-sm chip inline-flex items-center gap-1 rounded-xl border-2 border-brandred/30 bg-brandred-soft px-2.5 py-1.5 text-[12px] font-bold text-brandred hover:border-brandred"
                >
                  <Icon name="spark" className="h-3.5 w-3.5" />
                  {b}
                </button>
              ))}
            </div>

            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={() => onBook(vendor)}
                className="btn btn-primary flex-1 rounded-2xl px-3 py-2.5 text-sm"
              >
                Lock this deal
              </button>
              <button
                onClick={() => setChatOpen((o) => !o)}
                className="btn btn-ghost rounded-2xl px-3 py-2.5"
                aria-label="Ask a custom question"
              >
                <Icon name="send" className="h-4 w-4" />
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-3 rounded-2xl bg-card2 p-3">
            {vendor.demo ? (
              vendor.stage === "no-response" ? (
                <div className="text-[12px] text-faint">
                  No reply yet - we&apos;ll keep the line open.
                </div>
              ) : (
                <div className="flex items-center gap-2 text-[12px] text-faint">
                  <span className="skeleton h-2 w-24 rounded-full" />
                  <span>agent working...</span>
                </div>
              )
            ) : (
              <div>
                <div className="flex items-center justify-between">
                  <div className="text-[12px] font-bold text-soft">
                    No quoted price yet - real prices come only from the vendor.
                  </div>
                </div>
                {marketRate && (
                  <div className="mt-1 text-[12px] text-faint">
                    Market estimate: ~${marketRate}/day{" "}
                    <span className="rounded bg-brandyellow-soft px-1 py-0.5 text-[9px] font-extrabold text-[#8a6100] dark:text-brandyellow">
                      ESTIMATE
                    </span>
                  </div>
                )}
                <button
                  onClick={openWhatsApp}
                  className="btn mt-2 w-full rounded-2xl bg-savings py-2.5 text-sm font-extrabold text-white hover:brightness-95"
                >
                  Send RFQ on WhatsApp
                </button>
                {contact && !contact.waLink && (
                  <div className="mt-1.5 text-[11px] text-faint">
                    No WhatsApp number found for this vendor yet.
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {chatOpen && (
          <div className="mt-3 rounded-2xl border-2 border-line bg-card p-3">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-bold text-soft">
              <Icon name="shield" className="h-3.5 w-3.5 text-savings" />
              Messages are screened by the safety agent before sending.
            </div>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={2}
              maxLength={600}
              placeholder="Ask this vendor something specific..."
              className="w-full resize-none rounded-xl border-2 border-line bg-card2 p-2 text-sm text-strong placeholder:text-faint focus:border-brandblue focus:outline-none"
            />
            {chatState.status === "blocked" && (
              <div className="mt-1 rounded-xl bg-brandred-soft p-2 text-[12px] font-semibold text-brandred">
                {chatState.reason ?? "Message blocked."}
                {chatState.suggestion && (
                  <div className="mt-1 opacity-80">Try: {chatState.suggestion}</div>
                )}
              </div>
            )}
            {chatState.status === "sent" && (
              <div className="mt-1 text-[12px] font-bold text-savings">✓ Sent</div>
            )}
            <button
              onClick={sendCustom}
              disabled={chatState.status === "checking" || !draft.trim()}
              className="btn btn-primary mt-2 w-full rounded-xl py-2 text-sm disabled:opacity-50"
            >
              {chatState.status === "checking" ? "Screening..." : "Screen & send"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
