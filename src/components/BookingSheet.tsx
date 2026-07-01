"use client";

import { useEffect, useState } from "react";
import type { Vendor, StructuredRFQ } from "@/lib/types";
import { Icon } from "./icons";

type Step = "verify" | "schedule" | "confirmed";

export function BookingSheet({
  vendor,
  rfq,
  onClose,
}: {
  vendor: Vendor;
  rfq: StructuredRFQ | null;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>("verify");
  const [verification, setVerification] = useState<string>("");
  const [mode, setMode] = useState<"hotel-delivery" | "in-store">(
    vendor.fulfillment.includes("hotel-delivery") ? "hotel-delivery" : "in-store"
  );
  const [date, setDate] = useState("");
  const [time, setTime] = useState("10:00");

  useEffect(() => {
    // Ask the agent to run a final spec verification with the vendor.
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

  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  return (
    <div className="fixed inset-0 z-[1000] flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center">
      <div className="surface-strong w-full max-w-md rounded-t-3xl p-5 sm:rounded-3xl animate-slide-up">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-white">
            {step === "confirmed" ? "Booking confirmed" : "Lock your deal"}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            ✕
          </button>
        </div>

        <div className="mb-4 rounded-xl bg-ink/50 p-3 text-sm">
          <div className="font-semibold text-white">{vendor.name}</div>
          {vendor.offer && (
            <div className="text-slate-400">
              ${vendor.offer.pricePerDay}/day · ${vendor.offer.totalPrice} total
            </div>
          )}
        </div>

        {step === "verify" && (
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-savings">
              <Icon name="check" className="h-4 w-4" /> Agent spec verification
            </div>
            <div className="rounded-xl border border-slate-700/40 bg-ink/40 p-3 text-[13px] text-slate-300">
              {verification || "Requesting confirmation from the vendor…"}
            </div>
            <div className="mt-2 space-y-1 text-[12px] text-slate-400">
              <div className="flex items-center gap-1.5">
                <Icon name="check" className="h-3.5 w-3.5 text-savings" />
                {rfq?.vehicleClass}
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
              className="mt-4 w-full rounded-xl bg-savings py-2.5 text-sm font-semibold text-ink hover:bg-savings-bright"
            >
              Specs match - continue
            </button>
          </div>
        )}

        {step === "schedule" && (
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-slate-300">
              <Icon name="calendar" className="h-4 w-4 text-savings" /> Pickup or
              delivery
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                disabled={!vendor.fulfillment.includes("hotel-delivery")}
                onClick={() => setMode("hotel-delivery")}
                className={`rounded-xl border p-3 text-left text-sm transition disabled:opacity-40 ${
                  mode === "hotel-delivery"
                    ? "border-savings bg-savings/10 text-white"
                    : "border-slate-700/50 text-slate-300"
                }`}
              >
                <div className="font-semibold">Hotel delivery</div>
                <div className="text-[11px] text-slate-400">To your lobby</div>
              </button>
              <button
                onClick={() => setMode("in-store")}
                className={`rounded-xl border p-3 text-left text-sm transition ${
                  mode === "in-store"
                    ? "border-savings bg-savings/10 text-white"
                    : "border-slate-700/50 text-slate-300"
                }`}
              >
                <div className="font-semibold">In-store pickup</div>
                <div className="text-[11px] text-slate-400">At the shop</div>
              </button>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2">
              <label className="text-[12px] text-slate-400">
                Date
                <input
                  type="date"
                  min={tomorrow}
                  value={date || tomorrow}
                  onChange={(e) => setDate(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-700/50 bg-ink/60 p-2 text-sm text-white [color-scheme:dark]"
                />
              </label>
              <label className="text-[12px] text-slate-400">
                Time
                <input
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-700/50 bg-ink/60 p-2 text-sm text-white [color-scheme:dark]"
                />
              </label>
            </div>

            <button
              onClick={() => setStep("confirmed")}
              className="mt-4 w-full rounded-xl bg-savings py-2.5 text-sm font-semibold text-ink hover:bg-savings-bright"
            >
              Confirm booking
            </button>
          </div>
        )}

        {step === "confirmed" && (
          <div className="text-center">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-savings/15">
              <Icon name="check" className="h-8 w-8 text-savings-bright" />
            </div>
            <p className="text-sm text-slate-300">
              {vendor.name} is confirmed for{" "}
              <span className="font-semibold text-white">
                {(date || tomorrow)} at {time}
              </span>
              {mode === "hotel-delivery"
                ? " - delivered to your hotel lobby."
                : " - pickup in store."}
            </p>
            <p className="mt-2 text-[12px] text-slate-500">
              The agent has notified the vendor via the WhatsApp Cloud API and
              logged the agreement.
            </p>
            <button
              onClick={onClose}
              className="mt-4 w-full rounded-xl bg-slate-100/95 py-2.5 text-sm font-semibold text-ink"
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
