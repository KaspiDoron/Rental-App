"use client";

import { useState } from "react";
import type { Vendor, StructuredRFQ } from "@/lib/types";
import { StageBadge, Pipeline } from "./Tracker";
import { Icon } from "./icons";
import { AnimatedNumber } from "./SavingsTicker";

const SMART_BARGAINS = [
  { id: "beat", label: "Beat a nearby quote" },
  { id: "longer", label: "Length discount" },
  { id: "bundle", label: "Bundle delivery" },
];

export function VendorCard({
  vendor,
  rfq,
  onBargain,
  onBook,
  onCustomMessage,
}: {
  vendor: Vendor;
  rfq: StructuredRFQ | null;
  onBargain: (vendorId: string) => void;
  onBook: (vendor: Vendor) => void;
  onCustomMessage: (
    vendorId: string,
    message: string
  ) => Promise<{ allowed: boolean; reason?: string; suggestion?: string }>;
}) {
  const [chatOpen, setChatOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [chatState, setChatState] = useState<
    { status: "idle" | "checking" | "sent" | "blocked"; reason?: string; suggestion?: string }
  >({ status: "idle" });

  const offer = vendor.offer;
  const savings =
    offer && rfq
      ? Math.max(0, (offer.listPricePerDay - offer.pricePerDay) * rfq.durationDays)
      : 0;
  const primaryClass = vendor.vehicleClasses[0];

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
    <div className="surface animate-slide-up rounded-2xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-[15px] font-semibold text-white">
              {vendor.name}
            </h3>
            {vendor.partner && (
              <span className="rounded-full bg-savings/15 px-2 py-0.5 text-[10px] font-semibold text-savings-bright">
                Partner
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-slate-400">
            <span className="inline-flex items-center gap-1">
              <Icon name="star" className="h-3.5 w-3.5 text-gold" />
              <span className="text-slate-300">{vendor.rating.toFixed(1)}</span>
              <span className="text-slate-500">({vendor.reviews})</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <Icon name="pin" className="h-3.5 w-3.5" />
              {vendor.distanceKm?.toFixed(1)} km
            </span>
            <span className="inline-flex items-center gap-1 capitalize">
              <Icon
                name={primaryClass === "car" ? "car" : "bike"}
                className="h-3.5 w-3.5"
              />
              {vendor.vehicleClasses.join(", ")}
            </span>
            {vendor.fulfillment.includes("hotel-delivery") && (
              <span className="text-savings-bright">Hotel delivery</span>
            )}
          </div>
        </div>
        {vendor.stage && <StageBadge stage={vendor.stage} />}
      </div>

      <div className="mt-3">
        <Pipeline stage={vendor.stage ?? "queued"} />
      </div>

      {offer ? (
        <div className="mt-3 rounded-xl bg-ink/50 p-3">
          <div className="flex items-end justify-between">
            <div>
              <div className="text-[11px] uppercase tracking-wide text-slate-500">
                Best offer
              </div>
              <div className="text-2xl font-bold text-white">
                $<AnimatedNumber value={offer.pricePerDay} />
                <span className="text-sm font-medium text-slate-400">/day</span>
              </div>
              <div className="text-[12px] text-slate-400">
                ${offer.totalPrice.toLocaleString()} total · {rfq?.durationDays}d
              </div>
            </div>
            {savings > 0 && (
              <div className="text-right">
                <div className="text-[11px] uppercase tracking-wide text-savings">
                  You save
                </div>
                <div className="text-lg font-bold text-savings-bright">
                  $<AnimatedNumber value={Math.round(savings)} />
                </div>
              </div>
            )}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {offer.includesDelivery && (
              <span className="rounded-md bg-savings/10 px-2 py-0.5 text-[11px] text-savings-bright">
                + free delivery
              </span>
            )}
            {offer.includesInsurance && (
              <span className="rounded-md bg-sky-500/10 px-2 py-0.5 text-[11px] text-sky-300">
                + insurance
              </span>
            )}
            <span className="rounded-md bg-slate-500/10 px-2 py-0.5 text-[11px] text-slate-400">
              round {offer.round + 1}
            </span>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            {SMART_BARGAINS.map((b) => (
              <button
                key={b.id}
                onClick={() => onBargain(vendor.id)}
                className="inline-flex items-center gap-1 rounded-lg border border-violet-400/25 bg-violet-500/10 px-2.5 py-1.5 text-[12px] font-medium text-violet-200 transition hover:bg-violet-500/20 active:scale-95"
              >
                <Icon name="spark" className="h-3.5 w-3.5" />
                {b.label}
              </button>
            ))}
          </div>

          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={() => onBook(vendor)}
              className="flex-1 rounded-xl bg-savings px-3 py-2.5 text-sm font-semibold text-ink transition hover:bg-savings-bright active:scale-[0.98]"
            >
              Lock this deal
            </button>
            <button
              onClick={() => setChatOpen((o) => !o)}
              className="rounded-xl border border-slate-600/40 px-3 py-2.5 text-sm text-slate-300 transition hover:bg-slate-700/30"
              aria-label="Ask a custom question"
            >
              <Icon name="send" className="h-4 w-4" />
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-2 text-[12px] text-slate-500">
          {vendor.stage === "no-response" ? (
            "No reply yet — we'll keep the line open."
          ) : (
            <>
              <span className="h-2 w-24 rounded-full skeleton" />
              <span>agent working…</span>
            </>
          )}
        </div>
      )}

      {chatOpen && (
        <div className="mt-3 rounded-xl border border-slate-700/40 bg-ink/40 p-3">
          <div className="mb-1 flex items-center gap-1.5 text-[11px] text-slate-400">
            <Icon name="shield" className="h-3.5 w-3.5 text-savings" />
            Messages are screened by the safety agent before sending.
          </div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            maxLength={600}
            placeholder="Ask this vendor something specific…"
            className="w-full resize-none rounded-lg border border-slate-700/50 bg-ink/60 p-2 text-sm text-white placeholder:text-slate-600 focus:border-savings/50 focus:outline-none"
          />
          {chatState.status === "blocked" && (
            <div className="mt-1 rounded-lg bg-rose-500/10 p-2 text-[12px] text-rose-300">
              {chatState.reason ?? "Message blocked."}
              {chatState.suggestion && (
                <div className="mt-1 text-rose-200/80">Try: {chatState.suggestion}</div>
              )}
            </div>
          )}
          {chatState.status === "sent" && (
            <div className="mt-1 text-[12px] text-savings-bright">
              ✓ Sent via WhatsApp Cloud API
            </div>
          )}
          <button
            onClick={sendCustom}
            disabled={chatState.status === "checking" || !draft.trim()}
            className="mt-2 w-full rounded-lg bg-slate-100/95 px-3 py-2 text-sm font-semibold text-ink disabled:opacity-50"
          >
            {chatState.status === "checking" ? "Screening…" : "Screen & send"}
          </button>
        </div>
      )}
    </div>
  );
}
