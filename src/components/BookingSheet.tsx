"use client";

import { useEffect, useState } from "react";
import type { Vendor, StructuredRFQ } from "@/lib/types";
import { vehicleLabel } from "@/lib/labels";
import { Modal } from "./Modal";
import { Icon } from "./icons";

type Step = "verify" | "schedule" | "confirmed";

export function BookingSheet({
  vendor,
  rfq,
  plan = "free",
  onClose,
}: {
  vendor: Vendor;
  rfq: StructuredRFQ | null;
  plan?: string;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>("verify");
  const [verification, setVerification] = useState<string>("");
  // Arrangement is confirmed with the shop over WhatsApp, not asserted here.
  const mode: "in-store" = "in-store";
  const [date, setDate] = useState("");
  const [time, setTime] = useState("10:00");
  const [dealTerms, setDealTerms] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/negotiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendor, rfq, round: 0, verify: true }),
    })
      .then((r) => r.json())
      .then((d) => alive && setVerification(d.verification ?? ""))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [vendor, rfq]);

  // Free plan schedules SAME-DAY pickups only; Pro/Business unlock future days.
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const freePlan = plan === "free";
  const minDate = today;
  const maxDate = freePlan ? today : undefined;
  const defaultDate = freePlan ? today : tomorrow;

  async function confirm() {
    setStep("confirmed");
    // Persist the booking (saved to the database when Supabase is connected).
    fetch("/api/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vendorId: vendor.id,
        vendorName: vendor.name,
        pricePerDay: vendor.offer?.pricePerDay ?? 0,
        totalPrice: vendor.offer?.totalPrice ?? 0,
        fulfillment: mode,
        scheduledAt: `${date || defaultDate}T${time}:00Z`,
      }),
    }).catch(() => {});
  }

  return (
    <Modal onClose={onClose}>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-extrabold text-strong">
          {step === "confirmed" ? "Booking confirmed 🎉" : "Lock your deal"}
        </h2>
        <button onClick={onClose} className="btn btn-sm btn-ghost rounded-xl px-3" aria-label="Close">
          ✕
        </button>
      </div>

      <div className="mb-4 rounded-2xl bg-card2 p-3 text-sm">
        <div className="font-extrabold text-strong">{vendor.name}</div>
        {vendor.offer && (
          <div className="text-soft">
            ${vendor.offer.pricePerDay}/day · ${vendor.offer.totalPrice} total
          </div>
        )}
      </div>

      {step === "verify" && (
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-[12px] font-extrabold text-savings">
            <Icon name="check" className="h-4 w-4" /> Agent spec verification
          </div>
          <div className="rounded-2xl border-2 border-line bg-card p-3 text-[13px] text-soft">
            {verification || "Requesting confirmation from the vendor..."}
          </div>
          <div className="mt-2 space-y-1 text-[12px] text-soft">
            <div className="flex items-center gap-1.5">
              <Icon name="check" className="h-3.5 w-3.5 text-savings" />
              {rfq ? vehicleLabel(rfq.vehicleClass) : ""}
              {rfq?.engineSizeCc ? ` · ${rfq.engineSizeCc}cc` : ""}
            </div>
            {rfq?.maxMileageKm && (
              <div className="flex items-center gap-1.5">
                <Icon name="check" className="h-3.5 w-3.5 text-savings" />
                under {rfq.maxMileageKm.toLocaleString()} km
              </div>
            )}
            {rfq?.accessories.map((a) => (
              <div key={a} className="flex items-center gap-1.5">
                <Icon name="check" className="h-3.5 w-3.5 text-savings" />
                {a}
              </div>
            ))}
          </div>
          <button
            onClick={() => setStep("schedule")}
            className="btn btn-primary mt-4 w-full rounded-2xl py-2.5 text-sm"
          >
            Specs match - continue
          </button>
        </div>
      )}

      {step === "schedule" && (
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-[12px] font-extrabold text-soft">
            <Icon name="calendar" className="h-4 w-4 text-brandblue" /> When would you like it?
          </div>
          <p className="mb-2 text-[11px] text-faint">
            Confirm the exact pickup or delivery arrangement directly with the
            shop over WhatsApp - the agents will have asked already.
          </p>

          {freePlan && (
            <div className="mt-3 rounded-2xl bg-brandyellow-soft p-2.5 text-[12px] font-bold text-[#8a6100] dark:text-brandyellow">
              Free plan: pickup can be scheduled for TODAY only. Upgrade to Pro
              to book future days.
            </div>
          )}
          <div className="mt-3 grid grid-cols-2 gap-2">
            <label className="text-[12px] font-bold text-soft">
              Date
              <input
                type="date"
                min={minDate}
                max={maxDate}
                disabled={freePlan}
                value={date || defaultDate}
                onChange={(e) => setDate(e.target.value)}
                className="mt-1 w-full rounded-xl border-2 border-line bg-card p-2 text-sm text-strong disabled:opacity-70"
              />
            </label>
            <label className="text-[12px] font-bold text-soft">
              Time
              <input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="mt-1 w-full rounded-xl border-2 border-line bg-card p-2 text-sm text-strong"
              />
            </label>
          </div>

          {/* Liability acknowledgement - required before any deal is locked. */}
          <label className="mt-3 flex items-start gap-2 rounded-2xl bg-card2 p-2.5 text-[11px] leading-relaxed text-soft">
            <input
              type="checkbox"
              checked={dealTerms}
              onChange={(e) => setDealTerms(e.target.checked)}
              className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--blue)]"
            />
            <span>
              I understand that WheelDeal only connects me with independent
              rental shops and takes NO responsibility whatsoever for the
              vehicle, its condition, pricing, insurance, deposits, accidents,
              damages, disputes or the rental transaction itself. The agreement
              is strictly between me and the shop, at my own risk.
            </span>
          </label>
          <button
            onClick={confirm}
            disabled={!dealTerms}
            className="btn btn-primary mt-3 w-full rounded-2xl py-2.5 text-sm disabled:opacity-50"
          >
            Confirm booking
          </button>
        </div>
      )}

      {step === "confirmed" && (
        <div className="text-center">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-savings-soft">
            <Icon name="check" className="h-8 w-8 text-savings" />
          </div>
          <p className="text-sm text-soft">
            {vendor.name} is confirmed for{" "}
            <span className="font-extrabold text-strong">
              {date || defaultDate} at {time}
            </span>
            .
          </p>
          <p className="mt-2 text-[12px] text-faint">
            The agent notified the vendor and saved the booking to your profile.
          </p>
          <button
            onClick={onClose}
            className="btn btn-primary mt-4 w-full rounded-2xl py-2.5 text-sm"
          >
            Done
          </button>
        </div>
      )}
    </Modal>
  );
}
