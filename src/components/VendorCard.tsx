"use client";

import { memo, useEffect, useRef, useState } from "react";
import type { Vendor, StructuredRFQ, VehicleOption } from "@/lib/types";
import { StageBadge, Pipeline, stageCaption } from "./Tracker";
import { Icon } from "./icons";
import { AnimatedNumber } from "./SavingsTicker";
import { LoadingDots } from "./LoadingDots";
import { PhotoGallery } from "./PhotoGallery";
import { ShopPhoto } from "./ShopPhoto";
import { friendlySendError } from "@/lib/wa/send-error";
import { useI18n } from "@/lib/i18n";
import { moneyLocal, convertApprox, savedCurrency, currencySymbol } from "@/lib/currency";
import { queueReasonLabel, queueEta } from "@/lib/queue-reason";
import { VENDOR_TAG_LABELS } from "@/lib/labels";
import { ThreadPeek } from "./ThreadPeek";
import { OptionList } from "./OptionList";
import { ShopAvatar } from "./ShopAvatar";

// A rental-shop card. Prices are NEVER invented - we first ask the shop, and
// only its real reply produces a price. Everything happens INSIDE the app:
// the RFQ is sent from here via the official WhatsApp Cloud API, and the
// shop's answer flows back into this card automatically through the webhook.
function VendorCardInner({
  vendor,
  rfq,
  plan,
  waConnected,
  localLang,
  region,
  searchEpoch,
  onBook,
  onReviews,
  onBargain,
  onStage,
  onQueued,
  onCustomMessage,
  onPickupConsent,
  onLocationRequest,
  whyDecisionId,
  onWhy,
  onOpenThread,
  riskNote,
}: {
  vendor: Vendor;
  rfq: StructuredRFQ | null;
  plan?: string;
  // null = still checking the link on first paint; treated the same as false
  // for gating (send disabled) but lets the parent avoid a "not connected" flash.
  waConnected: boolean | null;
  localLang?: boolean;
  region?: string;
  searchEpoch?: number;
  // The chosen tier travels with the action. Without it, locking the "older
  // 200" tier would book the headline price of the "newer 250" one, because
  // BookingSheet reads vendor.offer.pricePerDay directly.
  onBook: (vendor: Vendor, option?: VehicleOption) => void;
  onReviews: (vendor: Vendor) => void;
  onBargain: (vendor: Vendor, option?: VehicleOption) => void;
  onStage: (vendorId: string, stage: Vendor["stage"]) => void;
  // A send was parked in the outbox - stamp queuedUntil + the guard's real
  // reason instantly so every surface agrees without waiting for a poll.
  onQueued?: (vendorId: string, queuedUntil?: string, queuedReason?: string) => void;
  onCustomMessage: (
    vendorId: string,
    message: string
  ) => Promise<{ allowed: boolean; reason?: string; suggestion?: string }>;
  // Pickup consent: the shop offered to pick the traveller up; sending the
  // exact location happens ONLY after the traveller approves it here.
  onPickupConsent?: (vendor: Vendor, sharePlace?: string) => Promise<{ ok: boolean; reason?: string }>;
  /** Opens the location-share sheet: the shop asked WHERE the traveller is. */
  onLocationRequest?: (vendor: Vendor) => void;
  // "Why this move?" - the latest director decision for this shop (live data).
  whyDecisionId?: string;
  onWhy?: (decisionId: string) => void;
  // Open the full-screen per-agency dashboard (transcript + map + offer + state).
  onOpenThread?: (vendor: Vendor) => void;
  // Inbound-risk warning from the safety screen ("asked for your passport...").
  riskNote?: string;
}) {
  const { t } = useI18n();
  const [chatOpen, setChatOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [chatState, setChatState] = useState<{
    status: "idle" | "checking" | "sent" | "queued" | "blocked";
    reason?: string;
    suggestion?: string;
  }>({ status: "idle" });
  const [rfqState, setRfqState] = useState<
    "idle" | "sending" | "sent" | "queued" | "no-phone" | "not-connected" | "rate-limited"
  >("idle");
  const [rfqError, setRfqError] = useState<string | null>(null);
  // Every deferred UI step is tracked and cleared on unmount - an untracked
  // setTimeout kept firing stage changes after the card was gone.
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timersRef.current.forEach(clearTimeout), []);
  // B3: a SYNCHRONOUS in-flight guard. `disabled` derives from React state that
  // only lands after a render commit, leaving a window where two near-instant
  // taps both dispatch a fetch (-> two outbox rows / a double send). This ref
  // flips before the first await, so the second tap is dropped immediately.
  const rfqInFlight = useRef(false);
  // "Already asked" survives navigation: it derives from the vendor's stage
  // (persisted with the search), not from this component's local state.
  const alreadyAsked = ["rfq-sent", "awaiting-response", "negotiating"].includes(
    vendor.stage ?? ""
  );
  const askDone = alreadyAsked || rfqState === "sent" || rfqState === "queued";
  // The user removed the queued message (server truth cleared queuedUntil):
  // this card's local "queued" latch must release too, so the button honestly
  // returns to "Ask for price" instead of staying stuck on a dead queue.
  useEffect(() => {
    if (rfqState === "queued" && !vendor.queuedUntil) setRfqState("idle");
  }, [rfqState, vendor.queuedUntil]);
  // TRUTH RULE: a message held in the outbox is QUEUED, never "Sent".
  // vendor.queuedUntil is the server-reconciled source (survives remounts),
  // rfqState covers the instant before the first poll.
  // PRESENCE, not a future timestamp: a committed outbox row means "do not
  // re-fire" whether its ETA is still in the future or already elapsed (a slow
  // drain / host blip leaves not_before in the past while the row is still
  // parked). Gating on `> now` re-enabled the button + relabelled it "Ask for
  // price" while the queued badge still showed - a self-contradiction that let
  // a tap enqueue a DUPLICATE. This matches the badge (vendor.queuedUntil &&
  // !offer) and the queue panel; the local latch releases via the effect above
  // once the server clears queuedUntil (delivered or removed).
  const queuedActive = rfqState === "queued" || Boolean(vendor.queuedUntil && !vendor.offer);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [pickupState, setPickupState] = useState<"idle" | "sending" | "shared" | "failed">("idle");

  const offer = vendor.offer;
  // The offer's own currency symbol - prices display in the shop's money.
  const curSymbol = offer ? currencySymbol(offer.currency) : "$";
  // Traveller's own currency (item #6) - set after mount so SSR markup stays
  // deterministic. Used only for the "≈ in your money" hint under the total.
  const [myCur, setMyCur] = useState<string | null>(null);
  useEffect(() => setMyCur(savedCurrency()), []);
  const approxTotal =
    offer && myCur ? convertApprox(offer.totalPrice, offer.currency, myCur) : null;
  const savings =
    offer && rfq
      ? Math.max(0, (offer.listPricePerDay - offer.pricePerDay) * rfq.durationDays)
      : 0;

  // Send the RFQ WITHOUT leaving the app: safety-screened, dispatched via the
  // official Cloud API, thread logged so the reply lands here automatically.
  async function sendRfq() {
    if (!rfq) return;
    if (rfqInFlight.current) return; // B3: drop a double-tap before the first await
    rfqInFlight.current = true;
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
          region,
          openNow: vendor.openNow,
          localLang: Boolean(localLang),
        }),
      });
      const d = await res.json();
      if (d.duplicate) {
        // B3: the server recognised this exact ask is already on its way. This
        // is NOT a failure - the old code fell through to the generic "brief
        // hiccup" toast (the response has no `error` field), scaring the user.
        // Reflect the real state: the shop was already contacted.
        setRfqState("sent");
        onStage(vendor.id, "awaiting-response");
      } else if (d.sent) {
        setRfqState("sent");
        onStage(vendor.id, "rfq-sent");
        timersRef.current.push(setTimeout(() => onStage(vendor.id, "awaiting-response"), 1200));
      } else if (d.queued) {
        // The anti-ban engine parked the message (shop closed, safe pacing,
        // daily limit...). NOTHING was delivered, so the stage must NOT claim
        // "RFQ sent" - the queued badge is the whole truth. Stamp queuedUntil
        // + the real reason immediately so strip and card agree NOW.
        setRfqState("queued");
        onQueued?.(vendor.id, d.queuedUntil, d.queuedReason);
      } else if (d.halted) {
        // Already asked and awaiting the reply (server-side truth).
        setRfqState("sent");
        onStage(vendor.id, "awaiting-response");
      } else if (d.reason === "no-phone") {
        // Honest terminal state: this shop cannot be messaged at all.
        setRfqState("no-phone");
        onStage(vendor.id, "no-contact");
      } else if (d.rateLimited) {
        setRfqState("rate-limited");
        // Never render an upstream string: the traveller once read
        // `instance requires property "text"` - our own request-body bug -
        // inside their shop card.
        setRfqError(d.error ? friendlySendError(d.error).text : null);
      } else if (d.reconnecting) {
        // Transient drop (server waking) - no re-link needed, just retry.
        setRfqState("rate-limited");
        setRfqError(d.error ? friendlySendError(d.error).text : null);
      } else if (d.configured === false || d.connect) {
        // The server SAYS WhatsApp is not linked - only then do we ask the user
        // to connect. Never inferred from a generic failure.
        setRfqState("not-connected");
      } else {
        // Anything else (an individual send that failed while WhatsApp IS
        // linked - a host 5xx, a number hiccup) is a TRANSIENT problem, not a
        // disconnect. Say so honestly and keep WhatsApp shown as connected.
        setRfqState("rate-limited");
        setRfqError(
          d.error
            ? friendlySendError(d.error).text
            : t("Not sent - a brief hiccup reaching WhatsApp. It retries on its own; try again in a few seconds.")
        );
      }
    } catch {
      // A thrown/timed-out request means WE couldn't reach OUR server - that is
      // never proof the user's WhatsApp is unlinked. Transient hiccup.
      setRfqState("rate-limited");
      setRfqError(t("Couldn't reach the server just now - it retries automatically. Try again in a moment."));
    } finally {
      rfqInFlight.current = false; // B3: release the synchronous lock
    }
  }

  async function sendCustom() {
    if (!draft.trim()) return;
    setChatState({ status: "checking" });
    const verdict = (await onCustomMessage(vendor.id, draft.trim())) as {
      allowed: boolean;
      sent?: boolean;
      configured?: boolean;
      queued?: boolean;
      reconnecting?: boolean;
      rateLimited?: boolean;
      error?: string;
      reason?: string;
      suggestion?: string;
    };
    if (verdict.allowed && !verdict.sent) {
      if (verdict.queued) {
        // Anti-ban queue (shop closed / pacing): NOTHING was delivered yet -
        // saying "Sent" here was a lie the queue card immediately disproved.
        setChatState({ status: "queued" });
        setDraft("");
        timersRef.current.push(
          setTimeout(() => {
            setChatOpen(false);
            setChatState({ status: "idle" });
          }, 2600)
        );
        return;
      }
      // Only claim "connect WhatsApp" when that is actually the problem -
      // a temporary reconnect or rate pause must never masquerade as it.
      setChatState({
        status: "blocked",
        reason:
          verdict.configured === false
            ? t("Not sent: connect your WhatsApp in Profile first - messages leave WheelDeal only through WhatsApp.")
            : verdict.error ??
              t("Not sent - a temporary hiccup on the WhatsApp connection. Try again in a few seconds."),
      });
      return;
    }
    if (verdict.allowed) {
      setChatState({ status: "sent" });
      setDraft("");
      timersRef.current.push(
        setTimeout(() => {
          setChatOpen(false);
          setChatState({ status: "idle" });
        }, 1600)
      );
    } else {
      setChatState({
        status: "blocked",
        reason: verdict.reason,
        suggestion: verdict.suggestion,
      });
    }
  }

  return (
    <div
      className={`surface lift overflow-hidden rounded-blob ${
        vendor.sponsored ? "sponsored-glow" : ""
      }`}
    >
      {vendor.sponsored && (
        <div className="flex items-center justify-center gap-1 bg-gradient-to-r from-brandblue via-[#7c5cff] to-brandred py-1 text-[10px] font-extrabold uppercase tracking-wide text-white">
          ⭐ {t("Recommended shop")}
        </div>
      )}
      {vendor.photoUrl && (
        <div className="relative h-32 w-full">
          <ShopPhoto src={vendor.photoUrl} className="h-full w-full" />
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
              {/* Only resolves for shops we have actually messaged, and only
                  while this search is open - see ShopAvatar. */}
              <ShopAvatar name={vendor.name} phone={vendor.whatsapp} />
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
              {vendor.fastResponder && (
                <span className="rounded-md bg-brandyellow-soft px-1.5 py-0.5 text-[10px] font-extrabold text-[#8a6100] dark:text-brandyellow">
                  ⚡ {t("Fast responder")}
                </span>
              )}
              {/* Reply-VERIFIED facts (item #13): the shop stated each of these
                  in at least TWO different replies before it earns a badge. */}
              {(vendor.verifiedTags ?? []).map((tg) => {
                const meta = VENDOR_TAG_LABELS[tg];
                if (!meta) return null;
                return (
                  <span
                    key={tg}
                    title={t("Confirmed by the shop in multiple replies")}
                    className="rounded-md bg-savings-soft px-1.5 py-0.5 text-[10px] font-extrabold text-savings"
                  >
                    {meta.emoji} {t(meta.label)} ✓
                  </span>
                );
              })}
            </div>
            {vendor.address && (
              <div className="mt-1 truncate text-[12px] text-faint">{vendor.address}</div>
            )}
          </div>
          {vendor.stage && <StageBadge stage={vendor.stage} />}
        </div>

        <div className="mt-3">
          {/* A held message shows the guard's REAL reason (shop closed / safe
              pacing / daily limit) + an honest ETA. The user can remove it
              from the status panel above. */}
          {vendor.queuedUntil && !offer && (
            <div className="mb-2 flex items-center gap-1.5 rounded-xl bg-brandyellow-soft p-2 text-[11px] font-bold text-[#8a6100] dark:text-brandyellow">
              🕘 {t(queueReasonLabel(vendor.queuedReason))}
              {queueEta(vendor.queuedUntil) ? ` · ${t(queueEta(vendor.queuedUntil))}` : ""}
            </div>
          )}
          {/* The user removed this shop's queued messages: honest paused
              state - agents stay silent until a fresh send re-opens it. */}
          {vendor.cancelled && !vendor.queuedUntil && !offer && (
            <div className="mb-2 flex items-center gap-1.5 rounded-xl bg-card2 p-2 text-[11px] font-bold text-soft">
              ⏸ {t("Paused by you - sending a new message re-opens this shop")}
            </div>
          )}
          {riskNote && (
            <div className="mt-2 flex items-start gap-1.5 rounded-xl border-2 border-brandred/40 bg-brandred-soft p-2 text-[11px] font-bold text-brandred">
              <Icon name="alert" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                {t("Will flagged this shop's reply")}: {riskNote}{" "}
                {t("Nothing was sent - review before you act.")}
              </span>
            </div>
          )}
          <Pipeline stage={vendor.stage ?? "queued"} />
          {vendor.stage && vendor.stage !== "offer-received" && (
            <div className="mt-2 flex items-start gap-1.5 rounded-xl bg-card2 p-2 text-[11px] font-bold text-soft">
              <span className="shrink-0">{stageCaption(vendor.stage).emoji}</span>
              <span className="flex-1">{t(stageCaption(vendor.stage).text)}</span>
              {whyDecisionId && onWhy && (
                <button
                  onClick={() => onWhy(whyDecisionId)}
                  className="chip shrink-0 rounded-full border border-line px-2 py-0.5 text-[10px] font-extrabold text-brandblue"
                >
                  {t("Why?")}
                </button>
              )}
            </div>
          )}
          {/* Control: the last message we sent + the shop's last reply, each
              collapsible on its own, newest at the bottom. Server truth ONLY -
              the card never shows a client draft as "sent" (the real message
              may be localized/rewritten before it leaves). */}
          {vendor.stage &&
            !["queued", "locating-contact", "found", "no-contact"].includes(vendor.stage) && (
              <>
                <ThreadPeek
                  vendorId={vendor.id}
                  fallbackReceived={offer?.message}
                  since={searchEpoch}
                />
                {onOpenThread && (
                  <button
                    onClick={() => onOpenThread(vendor)}
                    className="mt-1.5 w-full rounded-xl border-2 border-line py-1.5 text-[11px] font-extrabold text-brandblue lift"
                  >
                    💬 Full conversation
                  </button>
                )}
              </>
            )}
        </div>

        {offer ? (
          <div className="mt-3 rounded-2xl bg-card2 p-3">
            <div className="flex items-end justify-between">
              <div>
                <div className="flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-wide text-faint">
                  {t("Shop's offer")}
                  {/* BUG 1B: an offer row is ALWAYS a real price a real shop
                      quoted for the requested vehicle - so the fallback is a
                      calm "Shop quote", never a scary "UNCONFIRMED" that made
                      genuine offers look fake. VERIFIED is the premium state
                      (exact vehicle match + high-confidence read); DIFFERENT
                      VEHICLE flags a mismatched quote. */}
                  {offer.matchesSpec === false ? (
                    <span className="rounded bg-brandred-soft px-1.5 py-0.5 text-[9px] font-extrabold text-brandred">
                      {t("DIFFERENT VEHICLE")}
                    </span>
                  ) : offer.verified ? (
                    <span className="rounded bg-savings-soft px-1.5 py-0.5 text-[9px] font-extrabold text-savings">
                      {t("VERIFIED")}
                    </span>
                  ) : (
                    <span className="rounded bg-card2 px-1.5 py-0.5 text-[9px] font-extrabold text-soft">
                      {t("SHOP QUOTE")}
                    </span>
                  )}
                </div>
                <div className="text-2xl font-extrabold text-strong">
                  {curSymbol}
                  <AnimatedNumber value={offer.pricePerDay} />
                  <span className="text-sm font-bold text-faint">/{t("day")}</span>
                </div>
                <div className="text-[12px] text-soft">
                  {moneyLocal(offer.totalPrice, offer.currency)} {t("total")} · {rfq?.durationDays}d
                  {approxTotal !== null && myCur && (
                    <span className="ml-1 text-[11px] font-bold text-faint">
                      ≈ {moneyLocal(approxTotal, myCur)}
                    </span>
                  )}
                </div>
                {/* Shop-CONFIRMED conditions only - never guessed */}
                {(offer.deposit || offer.depositType || offer.includesDelivery || offer.includesInsurance || offer.deliveryFee != null) && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {(() => {
                      // Special deposit tag by the price: the exact kind the shop
                      // wants held (cash amount / passport / etc.), from the
                      // structured deposit, falling back to the raw label.
                      const type = offer.depositType;
                      const amt = offer.depositAmount;
                      const dCur = offer.depositCurrency || offer.currency;
                      if (!type && !offer.deposit) return null;
                      if (type === "none") {
                        return (
                          <span className="rounded-full bg-savings-soft px-2 py-0.5 text-[9px] font-extrabold text-savings">
                            ✅ {t("No deposit")}
                          </span>
                        );
                      }
                      const doc =
                        type === "passport" ? t("Passport")
                        : type === "id" ? t("ID card")
                        : type === "license" ? t("Licence")
                        : "";
                      const parts: string[] = [];
                      if (doc) parts.push(doc);
                      if (amt) parts.push(`${moneyLocal(amt, dCur)} ${t("cash")}`);
                      const text = parts.length ? parts.join(` ${t("or")} `) : offer.deposit;
                      const emoji = doc ? "🛂" : "🔒";
                      return (
                        <span className="rounded-full bg-brandblue-soft px-2 py-0.5 text-[9px] font-extrabold text-brandblue">
                          {emoji} {t("Deposit:")} {text}
                        </span>
                      );
                    })()}
                    {offer.includesDelivery && (
                      <span className="rounded-full bg-savings-soft px-2 py-0.5 text-[9px] font-extrabold text-savings">
                        🛵 {offer.deliveryFee != null && offer.deliveryFee > 0
                          ? `${t("Delivery")} ${moneyLocal(offer.deliveryFee, offer.currency)}`
                          : t("Free delivery")}
                      </span>
                    )}
                    {/* How the traveller gets the vehicle - only when the shop
                        confirmed it. Delivery already shows via includesDelivery. */}
                    {offer.fulfillment === "on-shop" && (
                      <span className="rounded-full bg-card px-2 py-0.5 text-[9px] font-extrabold text-soft">
                        🏪 {t("On shop")}
                      </span>
                    )}
                    {offer.fulfillment === "pickup" && (
                      <span className="rounded-full bg-brandblue-soft px-2 py-0.5 text-[9px] font-extrabold text-brandblue">
                        🚗 {t("Pickup offered")}
                      </span>
                    )}
                    {offer.includesInsurance && (
                      <span className="rounded-full bg-savings-soft px-2 py-0.5 text-[9px] font-extrabold text-savings">
                        🛡 {t("Insurance included")}
                      </span>
                    )}
                  </div>
                )}
              </div>
              {savings > 0 && (
                <div className="text-right">
                  <div className="badge-flash rounded-full px-2 py-0.5 text-[10px] font-extrabold">
                    🤝 {t("Authentic bargain")}
                  </div>
                  <div className="mt-1 text-lg font-extrabold text-savings">
                    -{curSymbol}
                    <AnimatedNumber value={Math.round(savings)} />
                  </div>
                </div>
              )}
            </div>

            {/* THE SHOP'S MENU. When a shop offers a choice ("some models 200
                and some new 250/day"), showing only the one price the app
                picked hides the actual decision from the traveller. Each tier
                gets its own lock/bargain/ask, so the choice is theirs. */}
            {offer.options && offer.options.length >= 2 && (
              <OptionList
                options={offer.options}
                currency={offer.currency}
                durationDays={rfq?.durationDays}
                onLock={(o) => onBook(vendor, o)}
                onBargain={(o) => onBargain(vendor, o)}
                onAsk={(o) => {
                  // Reuse the composer the card already owns, pre-filled with
                  // the tier so the traveller edits rather than types.
                  setChatOpen(true);
                  setDraft(
                    `${t("About the")} ${o.model || o.label} ${t("at")} ${o.pricePerDay}/${t("day")} - `
                  );
                }}
              />
            )}

            {/* Deal completeness: the agents keep confirming the deposit and
                how you get the vehicle before the deal is fully ready. We never
                hide the price - just flag what is still being confirmed. */}
            {vendor.stage === "declined" ? (
              <div className="mt-2 rounded-xl bg-card2 p-2 text-[11px] font-bold text-soft">
                🚫 {t("This shop passed on the deal - the offer above was their last word. Other shops are still in play.")}
              </div>
            ) : offer.matchesSpec === false ? (
              <div className="mt-2 rounded-xl bg-brandred-soft p-2 text-[11px] font-bold text-brandred">
                ⚠️ {t("This price is for a different vehicle than you asked for - your agent is checking whether they have the one you want.")}
              </div>
            ) : (
              offer.presentable === false && (
                <div className="mt-2 rounded-xl bg-brandblue-soft p-2 text-[11px] font-bold text-brandblue">
                  💬 {t("Your agent is still confirming the deposit and how you get the vehicle.")}
                </div>
              )
            )}

            {/* THE SHOP ASKED WHERE YOU ARE. Distinct from the pickup offer
                below: this is their question, quoted back, so the traveller
                knows why anyone wants their location before deciding what to
                share. Nothing is sent until they choose in the sheet. */}
            {offer.askedLocationQuote && !offer.pickupConsent && onLocationRequest && (
              <button
                onClick={() => onLocationRequest(vendor)}
                className="mt-2 w-full rounded-xl border-2 border-brandyellow/40 bg-brandyellow-soft p-2.5 text-left"
              >
                <div className="text-[12px] font-extrabold text-[#8a6100] dark:text-brandyellow">
                  📍 {t("This shop asked where you are")}
                </div>
                <div className="mt-0.5 line-clamp-2 text-[11px] italic text-soft">
                  &ldquo;{offer.askedLocationQuote}&rdquo;
                </div>
                <div className="mt-1 text-[11px] font-bold text-brandblue">
                  {t("Choose what to share")} →
                </div>
              </button>
            )}

            {/* Pickup consent: the shop offered to come get you. We share your
                EXACT location only after you approve it here. */}
            {offer.pickupOffered && !offer.pickupConsent && onPickupConsent && (
              <div className="mt-2 rounded-xl border-2 border-brandblue/30 bg-brandblue-soft p-2.5">
                <div className="text-[12px] font-bold text-brandblue">
                  🚗 {t("This shop offers to pick you up. Share your exact location so they can come to you?")}
                </div>
                {pickupState === "shared" ? (
                  <div className="mt-1.5 text-[11px] font-bold text-savings">
                    ✓ {t("Location shared - the shop will arrange your pickup.")}
                  </div>
                ) : (
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={async () => {
                        setPickupState("sending");
                        const r = await onPickupConsent(vendor);
                        setPickupState(r.ok ? "shared" : "failed");
                      }}
                      disabled={pickupState === "sending"}
                      className="btn btn-primary flex-1 rounded-xl py-2 text-[12px] disabled:opacity-60"
                    >
                      {pickupState === "sending" ? (
                        <LoadingDots light label={t("Sharing")} />
                      ) : (
                        `📍 ${t("Share my location")}`
                      )}
                    </button>
                    <button
                      onClick={() => setPickupState("idle")}
                      className="btn btn-sm rounded-xl border-2 border-line px-3 py-2 text-[12px] font-bold text-soft"
                    >
                      {t("No thanks")}
                    </button>
                  </div>
                )}
                {pickupState === "failed" && (
                  <div className="mt-1.5 text-[11px] font-bold text-brandred">
                    {t("Could not share your location - allow location access and retry.")}
                  </div>
                )}
              </div>
            )}

            <div className="mt-3 flex items-center gap-2">
              {/* You can never LOCK a price that is for the wrong vehicle. Until
                  the shop confirms the vehicle you asked for, the only action is
                  to keep pressing them (the agent is already clarifying). */}
              {offer.matchesSpec === false ? (
                <button
                  onClick={() => onBargain(vendor)}
                  className="btn btn-primary flex-1 rounded-2xl px-3 py-2.5 text-sm"
                >
                  🔎 {t("Ask for the right vehicle")}
                </button>
              ) : (
                <>
                  <button
                    onClick={() => onBook(vendor)}
                    className="btn btn-primary flex-1 rounded-2xl px-3 py-2.5 text-sm"
                  >
                    {t("Lock this deal")}
                  </button>
                  {vendor.stage !== "declined" && (
                    <button
                      onClick={() => onBargain(vendor)}
                      className="btn btn-sm chip rounded-2xl border-2 border-brandred/30 bg-brandred-soft px-3 py-2.5 text-[12px] font-extrabold text-brandred"
                    >
                      🥊 {t("Bargain")}
                    </button>
                  )}
                </>
              )}
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
                // A message that is sending OR already queued/sent can NEVER be
                // re-fired: queuedActive must gate the button (a queued row is
                // committed - tapping again would enqueue a duplicate).
                disabled={!waConnected || rfqState === "sending" || askDone || queuedActive}
                aria-disabled={!waConnected || rfqState === "sending" || askDone || queuedActive}
                className={`btn w-full rounded-2xl py-2.5 text-[13px] font-extrabold ${
                  queuedActive
                    ? // Queued is a STATUS, not a call to action: a muted,
                      // clearly non-interactive chip, never the green primary.
                      "cursor-default bg-card2 text-soft disabled:opacity-100"
                    : `text-white disabled:opacity-60 ${
                        waConnected ? "bg-savings hover:brightness-95" : "bg-faint"
                      }`
                }`}
              >
                {rfqState === "sending" ? (
                  <LoadingDots light label={t("Sending")} />
                ) : queuedActive ? (
                  // Queued is queued - it must NEVER read as "Sent", even
                  // after a remount (queuedActive derives from server state),
                  // and the reason is the guard's real one, never a guess.
                  `🕘 ${t(queueReasonLabel(vendor.queuedReason))}`
                ) : askDone ? (
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
                {rfqError ?? t("Taking a short break - try again in a few minutes.")}
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
              {waConnected
                ? t("Message this shop yourself")
                : `🔒 ${t("Message this shop yourself")}`}
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
          <div className="mt-2 rounded-2xl border-2 border-brandblue/40 bg-card p-3">
            {/* THIS IS NOT A NOTE TO YOUR AGENT.
                What the traveller types here goes to the shop word for word,
                on WhatsApp, from their own number - and they were not told.
                One typed "Ask if he can give me 2 helmets" expecting Will to
                relay it, and the shop received exactly that sentence. So say
                it plainly, show the words as the shop will see them, and put
                the shop's name on the send button. */}
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-extrabold text-strong">
              <Icon name="whatsapp" className="h-3.5 w-3.5 text-[#25D366]" />
              {t("Your words go straight to the shop")}
            </div>
            <p className="mb-2 text-[10.5px] font-semibold leading-snug text-soft">
              {t(
                "Type it the way you want them to read it - we send this exact text to the shop on WhatsApp, from your number. To tell your agent what to do instead, use Ask Will."
              )}
            </p>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={2}
              maxLength={600}
              placeholder={t("e.g. Can you include 2 helmets at that price?")}
              className="w-full resize-none rounded-xl border-2 border-line bg-card2 p-2 text-sm text-strong placeholder:text-faint focus:border-brandblue focus:outline-none"
            />
            {/* Exactly what will land in their chat - no surprises. */}
            {draft.trim() && (
              <div className="mt-1.5 rounded-xl bg-[#25D366]/10 p-2">
                <div className="text-[9.5px] font-extrabold uppercase tracking-wide text-savings">
                  {t("The shop will receive")}
                </div>
                <div className="mt-0.5 whitespace-pre-wrap break-words text-[11.5px] font-semibold text-strong">
                  {draft.trim()}
                </div>
              </div>
            )}
            <div className="mt-1.5 flex items-center gap-1.5 text-[10px] font-bold text-soft">
              <Icon name="shield" className="h-3 w-3 text-savings" />
              {t("Checked for anything unsafe first - nothing else is changed.")}
            </div>
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
            {chatState.status === "queued" && (
              <div className="mt-1 text-[12px] font-bold text-brandblue">
                🕘 {t("Queued - it goes out automatically, you'll see it in the queue below")}
              </div>
            )}
            <button
              onClick={sendCustom}
              disabled={chatState.status === "checking" || !draft.trim()}
              className="btn btn-primary mt-2 w-full rounded-xl py-2 text-sm disabled:opacity-50"
            >
              {chatState.status === "checking" ? (
                <LoadingDots light label={t("Screening")} />
              ) : (
                `${t("Send to")} ${vendor.name}`
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Memoised: with stable handler identities from the page, a card only
// re-renders when ITS vendor object (or the search context) changes - key for
// long result lists on low-end phones.
export const VendorCard = memo(VendorCardInner);
