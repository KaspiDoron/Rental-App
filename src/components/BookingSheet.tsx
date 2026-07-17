"use client";

import { useEffect, useState } from "react";
import type { Vendor, StructuredRFQ } from "@/lib/types";
import { vehicleLabel } from "@/lib/labels";
import { moneyLocal } from "@/lib/currency";
import { Modal } from "./Modal";
import { Icon } from "./icons";
import { PlaceAutocomplete } from "./PlaceAutocomplete";
import { LoadingDots } from "./LoadingDots";
import { digitsOnly } from "@/lib/phone";

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
  // Fulfillment defaults from the request: a hotel-delivery RFQ pre-selects
  // delivery so the booking (and the shop message) match what was negotiated.
  const [fulfillment, setFulfillment] = useState<"in-store" | "hotel-delivery">(
    rfq?.fulfillment === "hotel-delivery" ? "hotel-delivery" : "in-store"
  );
  const [address, setAddress] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("10:00");
  const [dealTerms, setDealTerms] = useState(false);
  // Honest notify state: we only SAY the shop was told if it really was.
  const [notify, setNotify] = useState<"sending" | "sent" | "queued" | "failed" | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // The wa.me deep link to the shop's chat + whether WheelDeal disconnected the
  // traveller's WhatsApp on close (they continue in their own app).
  const [waLink, setWaLink] = useState<string | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  // Commitment-lock refusal from the server (double-booking guard).
  const [lockError, setLockError] = useState<string | null>(null);

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

  const pickupDate = date || defaultDate;
  const durationDays = rfq?.durationDays ?? 1;
  // Return date derived from the pickup date + the rental length (shop-local).
  const returnDate = new Date(`${pickupDate}T00:00:00`);
  returnDate.setDate(returnDate.getDate() + Math.max(0, durationDays));
  const returnDateStr = returnDate.toISOString().slice(0, 10);
  const deliveryReady = fulfillment !== "hotel-delivery" || address.trim().length > 2;

  async function confirm() {
    if (submitting) return; // guard against a double-tap firing two bookings
    setSubmitting(true);
    setLockError(null);
    const when = `${pickupDate}T${time}:00`;
    // Persist the booking FIRST and respect the server's commitment lock: if
    // another shop was just booked, we stop HERE - no closing message, no
    // second "yes" to a second shop. total_price is recomputed server-side.
    // No trailing Z: the pickup time is the SHOP's local wall-clock, not UTC.
    try {
      const bRes = await fetch("/api/bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendorId: vendor.id,
          vendorName: vendor.name,
          pricePerDay: vendor.offer?.pricePerDay ?? 0,
          durationDays,
          currency: vendor.offer?.currency ?? "USD",
          fulfillment,
          deliveryAddress: fulfillment === "hotel-delivery" ? address.trim() : undefined,
          oneWayDropOff: rfq?.oneWayDropOff,
          scheduledAt: when,
          returnDate: returnDateStr,
        }),
      });
      if (bRes.status === 409) {
        const bd = await bRes.json().catch(() => ({}));
        setLockError(
          bd.error ??
            "You just locked a deal with another shop - remove that booking first if you changed your mind."
        );
        setSubmitting(false);
        return;
      }
    } catch {
      /* booking storage is retried by the user; the flow continues */
    }
    setStep("confirmed");

    // Close the deal: the engine's closing-message node tells the shop, then we
    // DISCONNECT the traveller's WhatsApp so they continue in their own app.
    setNotify("sending");
    try {
      const res = await fetch("/api/negotiate/close-deal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: vendor.whatsapp || undefined,
          placeId: vendor.placeId,
          vendorId: vendor.id,
          // Google "open now" - a deal-close on an open shop is never queued.
          openNow: vendor.openNow,
          pricePerDay: vendor.offer?.pricePerDay,
          currency: vendor.offer?.currency,
          fulfillment:
            fulfillment === "hotel-delivery"
              ? "delivery"
              : vendor.offer?.fulfillment ?? "on-shop",
          when: `${pickupDate} around ${time}`,
          address: fulfillment === "hotel-delivery" ? address.trim() : undefined,
        }),
      });
      const d = await res.json();
      setNotify(d.sent ? "sent" : "queued");
      setDisconnected(Boolean(d.disconnected));
      setWaLink(d.waLink ?? (vendor.whatsapp ? `https://wa.me/${digitsOnly(vendor.whatsapp)}` : null));
    } catch {
      setNotify("failed");
    }
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
            {moneyLocal(vendor.offer.pricePerDay, vendor.offer.currency)}/day ·{" "}
            {moneyLocal(vendor.offer.totalPrice, vendor.offer.currency)} total
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

          {/* Fulfillment: pickup at the shop vs delivery to your stay */}
          <div className="mt-3 grid grid-cols-2 gap-2">
            {(
              [
                { id: "in-store", label: "🏪 I'll pick up" },
                { id: "hotel-delivery", label: "🛵 Deliver to me" },
              ] as { id: "in-store" | "hotel-delivery"; label: string }[]
            ).map((o) => (
              <button
                key={o.id}
                onClick={() => setFulfillment(o.id)}
                className={`btn chip rounded-2xl border-2 p-2.5 text-[13px] font-extrabold ${
                  fulfillment === o.id
                    ? "border-brandblue bg-brandblue-soft text-brandblue"
                    : "border-line text-soft"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
          {fulfillment === "hotel-delivery" && (
            <div className="mt-2">
              <PlaceAutocomplete
                label="Delivery address"
                placeholder="Hotel name / address for delivery"
                value={address}
                onText={setAddress}
              />
            </div>
          )}

          {/* Rental period the shop is being asked to hold */}
          <div className="mt-3 rounded-2xl bg-card2 p-2.5 text-[12px] text-soft">
            📅 {durationDays} day{durationDays === 1 ? "" : "s"} · pick up{" "}
            <span className="font-bold text-strong">{pickupDate}</span> · return{" "}
            <span className="font-bold text-strong">{returnDateStr}</span>
            <div className="mt-0.5 text-[10px] text-faint">Times are the shop&apos;s local time.</div>
          </div>

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

          {/* The full deal you are about to close, so there are no surprises. */}
          <div className="mt-3 rounded-2xl border-2 border-brandblue/30 bg-brandblue-soft p-3 text-[12px]">
            <div className="font-extrabold text-strong">Do you really want to close this deal?</div>
            <div className="mt-1.5 space-y-0.5 text-soft">
              {vendor.offer && (
                <div>
                  💰 <span className="font-bold text-strong">{moneyLocal(vendor.offer.pricePerDay, vendor.offer.currency)}/day</span>
                  {" · "}
                  {moneyLocal(vendor.offer.totalPrice, vendor.offer.currency)} total ({durationDays}d)
                </div>
              )}
              {vendor.offer?.deposit && <div>🔒 Deposit: {vendor.offer.deposit}</div>}
              <div>
                {fulfillment === "hotel-delivery"
                  ? `🛵 Delivery to ${address.trim() || "your stay"}`
                  : vendor.offer?.fulfillment === "pickup"
                  ? "🚗 The shop picks you up"
                  : "🏪 Pick up at the shop"}
              </div>
              <div>📅 {pickupDate} around {time}</div>
            </div>
            <div className="mt-2 rounded-xl bg-card p-2 text-[11px] font-bold text-brandblue">
              After you confirm, we send the shop a final message and disconnect
              WheelDeal from your WhatsApp - you continue the chat in your own
              WhatsApp. You can reconnect anytime from Profile.
            </div>
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
              damages, disputes or the rental transaction itself. AI-negotiated
              summaries may contain errors - I will verify all terms with the
              shop. The agreement is strictly between me and the shop, at my own
              risk.
            </span>
          </label>
          {lockError && (
            <div className="mt-2 rounded-2xl bg-brandred-soft p-2.5 text-[12px] font-bold text-brandred">
              {lockError}
            </div>
          )}
          <button
            onClick={confirm}
            disabled={!dealTerms || !deliveryReady || submitting}
            className="btn btn-primary mt-3 flex w-full items-center justify-center gap-2 rounded-2xl py-2.5 text-sm disabled:opacity-50"
          >
            {submitting ? (
              <LoadingDots light label="Closing the deal & messaging the shop" />
            ) : fulfillment === "hotel-delivery" && !deliveryReady ? (
              "Add a delivery address"
            ) : (
              "Yes, close this deal"
            )}
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
          {/* HONEST notify status - we never claim the shop was told unless it was */}
          {notify === "sending" && (
            <p className="mt-2 text-[12px] text-faint">
              Saving your booking and messaging the shop your pickup time...
            </p>
          )}
          {notify === "sent" && (
            <p className="mt-2 text-[12px] font-bold text-savings">
              ✓ The shop was messaged that you want the deal. Booking saved to your profile.
            </p>
          )}
          {notify === "queued" && (
            <p className="mt-2 rounded-xl bg-brandblue-soft p-2 text-[12px] font-bold text-brandblue">
              🕒 The shop looks closed - your message is queued and sends when
              they open. Booking saved to your profile.
            </p>
          )}
          {notify === "failed" && (
            <p className="mt-2 rounded-xl bg-brandyellow-soft p-2 text-[12px] font-bold text-[#8a6100] dark:text-brandyellow">
              Booking saved, but the message could not be sent - open the chat
              below and tell the shop yourself.
            </p>
          )}

          {/* Handoff: continue in your OWN WhatsApp. WheelDeal has stepped out. */}
          <div className="mt-3 rounded-2xl bg-card2 p-3 text-left text-[12px] text-soft">
            <div className="font-extrabold text-strong">Finish in your WhatsApp 💬</div>
            <p className="mt-1">
              {disconnected
                ? "WheelDeal has disconnected from your WhatsApp - the rest of the conversation is just you and the shop. You can reconnect the agents anytime from "
                : "Your WhatsApp stays linked and the agents have stepped back from this chat - the rest of the conversation is just you and the shop. Manage the connection anytime from "}
              <a href="/profile" className="font-bold text-brandblue underline">
                Profile
              </a>
              .
            </p>
            {waLink && (
              <a
                href={waLink}
                target="_blank"
                rel="noopener noreferrer"
                className="btn mt-2 block w-full rounded-xl bg-wagreen-deep py-2.5 text-center text-[13px] font-extrabold text-white shadow-md hover:opacity-90"
              >
                Open WhatsApp chat with {vendor.name}
              </a>
            )}
          </div>

          <button
            onClick={onClose}
            className="btn mt-3 w-full rounded-2xl border-2 border-line py-2.5 text-sm font-bold text-soft"
          >
            Done
          </button>
        </div>
      )}
    </Modal>
  );
}
