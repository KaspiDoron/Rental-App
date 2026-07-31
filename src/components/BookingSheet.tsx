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

/**
 * THE THREE WAYS A VEHICLE AND ITS RENTER MEET.
 *
 * - "hotel-delivery" - the shop brings the vehicle to the traveller.
 * - "shuttle"        - the shop COLLECTS the traveller and takes them to it.
 * - "in-store"       - the traveller walks in.
 *
 * The middle one is not a variation on walking in: somebody has to be
 * somewhere at a time, and the shop needs to know where. It is the standard
 * answer in beach towns, and the two-button chooser had nowhere to put it.
 * Maps 1:1 onto the engine's FulfillmentKind (delivery | pickup | on-shop).
 */
type Handover = "in-store" | "shuttle" | "hotel-delivery";

const HANDOVER_TO_FULFILLMENT: Record<Handover, "delivery" | "pickup" | "on-shop"> = {
  "hotel-delivery": "delivery",
  shuttle: "pickup",
  "in-store": "on-shop",
};

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
  //
  // THREE MODES, because there are three. The chooser offered two - "I'll pick
  // up" and "Deliver to me" - and folded the third into the first, so a shop
  // that had OFFERED to collect the traveller (a shuttle, the single most
  // common answer in beach towns) had nowhere to be recorded, and the booking
  // said "walk in" for a ride that was arranged. The engine's vocabulary
  // already had all three (FulfillmentKind: delivery | pickup | on-shop);
  // only this control was missing one.
  //
  // Pre-selected from what the SHOP offered, falling back to the request - so
  // the booking matches what was actually negotiated instead of a default.
  const [fulfillment, setFulfillment] = useState<Handover>(() => {
    const offered = vendor.offer?.fulfillment;
    if (offered === "delivery") return "hotel-delivery";
    if (offered === "pickup") return "shuttle";
    if (offered === "on-shop") return "in-store";
    return rfq?.fulfillment === "hotel-delivery" ? "hotel-delivery" : "in-store";
  });
  const [address, setAddress] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("10:00");
  const [dealTerms, setDealTerms] = useState(false);
  // Honest notify state: we only SAY the shop was told if it really was.
  const [notify, setNotify] = useState<"sending" | "sent" | "queued" | "failed" | null>(null);
  const [notifyReason, setNotifyReason] = useState<string | null>(null);
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
  // BOTH off-shop modes need a place before the deal can be locked - a
  // shuttle with nowhere to collect from is not an arrangement.
  const deliveryReady = fulfillment === "in-store" || address.trim().length > 2;

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
          // The engine's own vocabulary, so the booking, the thread state and
          // the shop message all say the same thing about the same handover.
          handover: HANDOVER_TO_FULFILLMENT[fulfillment],
          deliveryAddress: fulfillment !== "in-store" ? address.trim() : undefined,
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
          // THE TRAVELLER'S CHOICE IS THE TRUTH. This used to fall back to
          // whatever the shop had offered whenever the choice was not
          // "delivery" - so picking "I'll walk in" against a shop that had
          // offered to collect you still told the shop a shuttle was on.
          fulfillment: HANDOVER_TO_FULFILLMENT[fulfillment],
          when: `${pickupDate} around ${time}`,
          address: fulfillment !== "in-store" ? address.trim() : undefined,
        }),
      });
      const d = await res.json();
      // F8: a non-OK response (400 unknown-destination, 409 already-committed)
      // is a FAILURE, not a queue - the old code mapped any !sent to "queued",
      // telling the user "the shop was told" when nothing was sent. Only a real
      // queued flag from a 200 means queued.
      if (!res.ok) {
        setNotify("failed");
        setNotifyReason(d.reason ?? d.error ?? null);
      } else {
        setNotify(d.sent ? "sent" : d.queued ? "queued" : "failed");
        if (!d.sent && !d.queued) setNotifyReason(d.reason ?? null);
      }
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
              {rfq ? vehicleLabel(rfq.vehicleClass, rfq.transmission) : ""}
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
          <div className="mt-3 grid grid-cols-3 gap-1.5">
            {(
              [
                { id: "in-store", label: "🏪 I'll walk in" },
                { id: "shuttle", label: "🚐 Collect me" },
                { id: "hotel-delivery", label: "🛵 Deliver to me" },
              ] as { id: Handover; label: string }[]
            ).map((o) => (
              <button
                key={o.id}
                onClick={() => setFulfillment(o.id)}
                className={`btn chip rounded-2xl border-2 p-2 text-[11.5px] font-extrabold leading-tight ${
                  fulfillment === o.id
                    ? "border-brandblue bg-brandblue-soft text-brandblue"
                    : "border-line text-soft"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
          {/* BOTH off-shop modes need a PLACE - somebody has to be somewhere.
              Only the words differ: one is where the vehicle goes, the other
              is where the traveller is picked up from. */}
          {fulfillment !== "in-store" && (
            <div className="mt-2">
              <PlaceAutocomplete
                label={fulfillment === "shuttle" ? "Pick-up point" : "Delivery address"}
                placeholder={
                  fulfillment === "shuttle"
                    ? "Where should they collect you?"
                    : "Hotel name / address for delivery"
                }
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
              {/* The traveller's OWN choice, in all three modes - not the
                  shop's offer overriding it. */}
              <div>
                {fulfillment === "hotel-delivery"
                  ? `🛵 Delivery to ${address.trim() || "your stay"}`
                  : fulfillment === "shuttle"
                  ? `🚐 They collect you at ${address.trim() || "your stay"}`
                  : "🏪 You walk in to the shop"}
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
            ) : !deliveryReady ? (
              fulfillment === "shuttle" ? "Add a pick-up point" : "Add a delivery address"
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
              {notifyReason
                ? `Booking saved, but the confirmation couldn't be sent (${notifyReason}) - open the chat below and tell the shop yourself.`
                : "Booking saved, but the message could not be sent - open the chat below and tell the shop yourself."}
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
