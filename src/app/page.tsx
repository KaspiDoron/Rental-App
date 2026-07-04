"use client";

import { useCallbackRef } from "@/components/useCallbackRef";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Vendor, StructuredRFQ, Session, TrackerStage, Offer } from "@/lib/types";
import { vehicleLabel } from "@/lib/labels";
import { Icon } from "@/components/icons";
import { Filters, DEFAULT_FILTERS, type FilterState } from "@/components/Filters";
import { VendorCard } from "@/components/VendorCard";
import { BookingSheet } from "@/components/BookingSheet";
import { AnimatedNumber } from "@/components/SavingsTicker";
import { TabBar } from "@/components/TabBar";
import { FeedbackModal } from "@/components/FeedbackModal";
import { BrandMark } from "@/components/BrandMark";
import { OriginPicker, type Origin } from "@/components/OriginPicker";
import { ReviewsSheet } from "@/components/ReviewsSheet";
import { UpgradeSheet } from "@/components/UpgradeSheet";
import { BargainDraftModal } from "@/components/BargainDraftModal";
import { Onboarding } from "@/components/Onboarding";
import { AdBanner } from "@/components/AdBanner";
import { LoadingDots } from "@/components/LoadingDots";
import { LanguageButton } from "@/components/LanguageButton";
import { useI18n } from "@/lib/i18n";

const MapView = dynamic(() => import("@/components/MapView"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center">
      <LoadingDots label="Loading map" />
    </div>
  ),
});

const EXAMPLES = [
  "125cc automatic scooter with a phone mount, under 20,000 km, for 3 days",
  "Small automatic car, 5 days, GPS included, cheapest possible",
  "Manual motorcycle with helmet and storage box, cheapest possible, 1 week",
];

const DEFAULT_ORIGIN: Origin = {
  label: "Canggu, Bali, Indonesia",
  lat: -8.6478,
  lng: 115.1385,
};

export default function Home() {
  const { t } = useI18n();
  const [session, setSession] = useState<Session | null>(null);
  const [origin, setOrigin] = useState<Origin>(DEFAULT_ORIGIN);
  const [radiusKm, setRadiusKm] = useState(8);
  const [rawText, setRawText] = useState(EXAMPLES[0]);
  const [rfq, setRfq] = useState<StructuredRFQ | null>(null);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [source, setSource] = useState<"google" | "demo" | "google-error" | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "profiling" | "running" | "done">("idle");
  const [view, setView] = useState<"list" | "map">("list");
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [bookingVendor, setBookingVendor] = useState<Vendor | null>(null);
  const [reviewsVendor, setReviewsVendor] = useState<Vendor | null>(null);
  const [bargainVendor, setBargainVendor] = useState<Vendor | null>(null);
  const [aiOn, setAiOn] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [onboarding, setOnboarding] = useState(false);
  const [waConnected, setWaConnected] = useState(false);
  const [massState, setMassState] = useState<"idle" | "running" | "done">("idle");
  const [massNote, setMassNote] = useState<string | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const appliedReplies = useRef<Set<number>>(new Set());

  useEffect(() => {
    // Middleware already gates unauthenticated visitors; here we just load the
    // session (with one retry - never cached).
    const loadMe = async (attempt = 0) => {
      try {
        const r = await fetch("/api/auth/me", { cache: "no-store" });
        const d = await r.json();
        if (d.session) setSession(d.session);
        else if (attempt < 2) setTimeout(() => loadMe(attempt + 1), 700);
        else window.location.href = "/login";
      } catch {
        if (attempt < 2) setTimeout(() => loadMe(attempt + 1), 700);
      }
    };
    loadMe();

    const params = new URLSearchParams(window.location.search);
    // First-run walkthrough (or explicitly requested with ?welcome=1).
    try {
      if (params.get("welcome") === "1" || !localStorage.getItem("wd_onboarded")) {
        setOnboarding(true);
      }
    } catch {}
    // Returning from Stripe Checkout.
    const plan = params.get("plan");
    if (params.get("billing") === "success" && plan) {
      fetch("/api/billing/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      }).then(() => window.history.replaceState({}, "", "/"));
    }

    return () => timers.current.forEach(clearTimeout);
  }, []);

  // Default the search to the phone's location once signed in (covered by the
  // Terms of Use the user accepted at signup).
  useEffect(() => {
    if (!session) return;
    fetch("/api/wa/status")
      .then((r) => r.json())
      .then((d) => setWaConnected(Boolean(d.connected)))
      .catch(() => {});
    navigator.geolocation?.getCurrentPosition(
      (pos) =>
        setOrigin({
          label: "My current location",
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        }),
      () => {}
    );
  }, [session]);

  const patchVendor = useCallbackRef((id: string, patch: Partial<Vendor>) => {
    setVendors((vs) => vs.map((v) => (v.id === id ? { ...v, ...patch } : v)));
  });

  // Live loop: while agents are waiting on shops, poll the reply feed so
  // offers ingested by the WhatsApp webhook pop into the cards automatically.
  const waiting = vendors.some(
    (v) => v.stage === "rfq-sent" || v.stage === "awaiting-response"
  );
  useEffect(() => {
    if (!session || !waiting || !rfq) return;
    const tick = async () => {
      try {
        const res = await fetch("/api/replies", { cache: "no-store" });
        const d = await res.json();
        for (const r of d.replies ?? []) {
          if (!r.found || !r.pricePerDay || appliedReplies.current.has(r.id)) continue;
          appliedReplies.current.add(r.id);
          setVendors((vs) =>
            vs.map((v) =>
              v.id === r.vendorId
                ? {
                    ...v,
                    stage: "offer-received" as TrackerStage,
                    offer: {
                      pricePerDay: r.pricePerDay,
                      listPricePerDay: v.offer?.listPricePerDay ?? r.pricePerDay,
                      currency: "USD",
                      totalPrice: Math.round(r.pricePerDay * rfq.durationDays),
                      includesInsurance: false,
                      includesDelivery: false,
                      message: r.replyText?.slice(0, 200) ?? "",
                      round: v.offer ? v.offer.round + 1 : 0,
                      verified: Boolean(r.verified),
                      simulated: false,
                    },
                  }
                : v
            )
          );
        }
      } catch {}
    };
    tick();
    const id = setInterval(tick, 15000);
    return () => clearInterval(id);
  }, [session, waiting, rfq]);

  async function fetchStatus(vendor: Vendor, activeRfq: StructuredRFQ) {
    const res = await fetch("/api/negotiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendor, rfq: activeRfq, round: 0 }),
    });
    if (!res.ok) return;
    const data = await res.json();
    patchVendor(vendor.id, { sentiment: data.sentiment });
  }

  function runFunnel(list: Vendor[], activeRfq: StructuredRFQ) {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    const schedule = (fn: () => void, ms: number) =>
      timers.current.push(setTimeout(fn, ms));

    list.forEach((vendor, i) => {
      const base = i * 200;
      schedule(() => patchVendor(vendor.id, { stage: "locating-contact" }), base + 300);
      schedule(() => fetchStatus({ ...vendor }, activeRfq), base + 900);
    });
    schedule(() => setPhase("done"), list.length * 200 + 1400);
  }

  async function startSearch() {
    if (!rawText.trim()) return;
    setPhase("profiling");
    setVendors([]);
    setRfq(null);
    setSource(null);
    setSourceError(null);

    const pRes = await fetch("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: rawText }),
    });
    const pData = await pRes.json();
    if (!pRes.ok) {
      setPhase("idle");
      alert(pData.error ?? "Could not parse your request.");
      return;
    }
    setRfq(pData.rfq);
    setAiOn(Boolean(pData.aiEnabled));
    // The active filter always follows the requested vehicle class.
    setFilters({ ...DEFAULT_FILTERS, vehicleClass: pData.rfq.vehicleClass });

    const vRes = await fetch("/api/vendors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        origin: { lat: origin.lat, lng: origin.lng },
        radiusKm,
        vehicleClass: pData.rfq.vehicleClass,
        fulfillment: pData.rfq.fulfillment === "any" ? undefined : pData.rfq.fulfillment,
      }),
    });
    const vData = await vRes.json();
    const list: Vendor[] = (vData.vendors ?? []).map((v: Vendor) => ({
      ...v,
      stage: "queued" as TrackerStage,
    }));
    setSource(vData.source ?? "demo");
    setSourceError(vData.sourceError ?? null);
    setVendors(list);
    setPhase("running");
    runFunnel(list, pData.rfq);
  }

  function applyOffer(vendorId: string, offer: Offer) {
    patchVendor(vendorId, { stage: "offer-received", offer });
  }

  async function customMessage(vendorId: string, message: string) {
    const vendor = vendors.find((v) => v.id === vendorId);
    const res = await fetch("/api/outreach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: vendor?.whatsapp || undefined,
        placeId: vendor?.placeId,
        vendorId,
        vendorName: vendor?.name,
        message,
        kind: "custom",
        rfq,
      }),
    });
    return res.json();
  }

  const availableClasses = useMemo(() => {
    const set = new Set<Vendor["vehicleClasses"][number]>();
    vendors.forEach((v) => v.vehicleClasses.forEach((c) => set.add(c)));
    return [...set];
  }, [vendors]);

  const filtered = useMemo(
    () => applyFilters(vendors, filters, rfq?.durationDays ?? 1),
    [vendors, filters, rfq]
  );

  const offersIn = vendors.filter((v) => v.offer).length;
  const totalSavings = useMemo(() => {
    if (!rfq) return 0;
    return vendors.reduce((sum, v) => {
      if (!v.offer) return sum;
      return (
        sum + Math.max(0, (v.offer.listPricePerDay - v.offer.pricePerDay) * rfq.durationDays)
      );
    }, 0);
  }, [vendors, rfq]);

  const cheapest = useMemo(
    () =>
      vendors
        .filter((v) => v.offer)
        .sort((a, b) => a.offer!.pricePerDay - b.offer!.pricePerDay)[0],
    [vendors]
  );

  const paidPlan = session ? session.plan !== "free" : false;

  return (
    <main className="mx-auto min-h-[100dvh] max-w-md pb-36 sm:max-w-lg md:max-w-3xl">
      <div className="topbar">
        <div className="mx-auto flex max-w-md items-center justify-between px-4 pb-2.5 sm:max-w-lg md:max-w-3xl">
          <div className="flex items-center gap-2">
            <BrandMark size={34} />
            <div>
              <h1 className="font-display text-lg font-extrabold leading-none text-strong">
                Wheel<span className="text-brandblue">Deal</span>
              </h1>
              <p className="text-[10px] font-bold text-faint">
                {t("Authentic bargains, negotiated for you")}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {session && session.plan !== "free" && (
              <span
                className={`rounded-full px-2 py-1 text-[10px] font-extrabold uppercase text-white ${
                  session.plan === "ultra" ? "badge-ultra" : "bg-brandblue"
                }`}
              >
                {session.plan}
              </span>
            )}
            <span
              className={`rounded-full px-2.5 py-1 text-[10px] font-extrabold ${
                aiOn
                  ? "bg-savings-soft text-savings"
                  : "bg-brandyellow-soft text-[#8a6100] dark:text-brandyellow"
              }`}
            >
              {aiOn ? t("AI online") : t("Demo AI")}
            </span>
            <LanguageButton />
          </div>
        </div>
      </div>

      <div className="px-4">
        <section className="surface mt-4 rounded-blob p-4">
          <label className="text-[12px] font-extrabold text-soft">
            {t("What do you want to ride?")}
          </label>
          <textarea
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            rows={2}
            className="mt-1 w-full resize-none rounded-2xl border-2 border-line bg-card p-3 text-sm text-strong placeholder:text-faint focus:border-brandblue focus:outline-none"
            placeholder={t("e.g. 125cc automatic scooter with phone mount, 3 days")}
          />
          <div className="no-scrollbar mt-2 flex gap-2 overflow-x-auto">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                onClick={() => setRawText(ex)}
                className="chip whitespace-nowrap rounded-full border-2 border-line bg-card px-2.5 py-1 text-[11px] font-bold text-faint hover:border-brandblue/40 hover:text-soft"
              >
                {ex.length > 36 ? ex.slice(0, 36) + "..." : ex}
              </button>
            ))}
          </div>

          <div className="mt-3">
            <OriginPicker origin={origin} onChange={setOrigin} />
          </div>

          <label className="mt-3 block text-[12px] font-extrabold text-soft">
            {t("Search radius")} · {radiusKm} km
            <input
              type="range"
              min={2}
              max={25}
              value={radiusKm}
              onChange={(e) => setRadiusKm(Number(e.target.value))}
              className="mt-2 w-full accent-[var(--blue)]"
            />
          </label>

          <button
            onClick={startSearch}
            disabled={phase === "profiling" || phase === "running"}
            className="btn btn-primary mt-3 flex w-full items-center justify-center gap-2 rounded-2xl py-3.5 text-[15px] disabled:opacity-70"
          >
            {phase === "profiling" ? (
              <LoadingDots light label={t("Structuring your request")} />
            ) : phase === "running" ? (
              <LoadingDots light label={t("Agents contacting shops")} />
            ) : (
              <>
                <Icon name="bolt" className="h-5 w-5" /> {t("Find my deal")}
              </>
            )}
          </button>
          {session?.plan === "free" && (
            <p className="mt-2 text-center text-[11px] font-bold text-faint">
              {t("Free plan: pickups can be scheduled for today only.")}{" "}
              <button onClick={() => setUpgradeOpen(true)} className="text-brandblue underline">
                {t("Upgrade")}
              </button>
            </p>
          )}
        </section>

        {source === "demo" && (
          <div className="mt-3 rounded-2xl bg-brandyellow-soft p-3 text-[12px] font-bold text-[#8a6100] dark:text-brandyellow animate-slide-up">
            {t("Demo shop list - no Google Maps key is set yet (owner: Admin -> Keys). Prices are never invented either way: we first ask each shop.")}
          </div>
        )}
        {source === "google-error" && (
          <div className="mt-3 rounded-2xl border-2 border-brandred bg-brandred-soft p-3 text-[12px] font-bold text-brandred animate-slide-up">
            {t("Your Google Maps key is set but Google rejected the request:")}{" "}
            <span className="font-mono text-[11px]">{sourceError}</span>
            <div className="mt-1 font-semibold">
              {t("Owner: open Admin -> Keys -> Test Google key for a one-tap diagnosis.")}
            </div>
          </div>
        )}
        {source === "google" && (
          <div className="mt-3 rounded-2xl bg-savings-soft p-3 text-[12px] font-bold text-savings animate-slide-up">
            ✓ {t("Real rental shops near your stay, live from Google Maps.")}
          </div>
        )}

        {rfq && (
          <div className="surface mt-3 rounded-blob p-3 text-[12px] animate-slide-up">
            <div className="mb-1 flex items-center gap-1.5 font-extrabold text-brandblue">
              <Icon name="spark" className="h-3.5 w-3.5" /> {t("Structured request")}
              {session && session.plan !== "free" && phase === "running" && (
                <span className="ml-auto font-bold text-faint">
                  <LoadingDots label={t("Order status: contacting shops")} />
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Tag>{vehicleLabel(rfq.vehicleClass)}</Tag>
              {rfq.engineSizeCc && <Tag>{rfq.engineSizeCc}cc</Tag>}
              {rfq.maxMileageKm && <Tag>&lt;{rfq.maxMileageKm.toLocaleString()} km</Tag>}
              <Tag>
                {rfq.durationDays} {t("days")}
              </Tag>
              {rfq.fulfillment !== "any" && <Tag>{rfq.fulfillment}</Tag>}
              {rfq.accessories.map((a) => (
                <Tag key={a}>{a}</Tag>
              ))}
            </div>
          </div>
        )}

        {vendors.length > 0 && (
          <div className="mt-3 grid grid-cols-3 gap-2">
            <Stat label={t("Shops found")} value={vendors.length} />
            <Stat label={t("Offers in")} value={offersIn} accent />
            <div className="surface rounded-blob p-3 text-center">
              <div className="text-[10px] font-extrabold uppercase tracking-wide text-savings">
                {t("Bargained")}
              </div>
              <div className="text-lg font-extrabold text-savings">
                $<AnimatedNumber value={Math.round(totalSavings)} />
              </div>
            </div>
          </div>
        )}

        {cheapest?.offer && (
          <div className="mt-3 flex items-center justify-between rounded-blob border-2 border-savings bg-savings-soft p-3 animate-slide-up">
            <div className="text-[12px]">
              <div className="font-bold text-soft">{t("Cheapest confirmed price")}</div>
              <div className="font-extrabold text-strong">{cheapest.name}</div>
            </div>
            <div className="text-right">
              <div className="text-xl font-extrabold text-savings">
                ${cheapest.offer.pricePerDay}
                <span className="text-xs text-soft">/{t("day")}</span>
              </div>
              <button
                onClick={() => setBookingVendor(cheapest)}
                className="text-[11px] font-extrabold text-savings underline"
              >
                {t("Lock it")} →
              </button>
            </div>
          </div>
        )}

        <AdBanner plan={session?.plan} />

        {/* Mass bargain: one tap asks several shops at once (Pro/Ultra) */}
        {vendors.length > 1 && rfq && (
          <div className="mt-3">
            <button
              onClick={async () => {
                if (session?.plan === "free") {
                  setUpgradeOpen(true);
                  return;
                }
                setMassState("running");
                setMassNote(null);
                try {
                  const targets = filtered
                    .filter((v) => !v.offer && v.stage !== "rfq-sent" && v.stage !== "awaiting-response")
                    .slice(0, 6)
                    .map((v) => ({ id: v.id, name: v.name, whatsapp: v.whatsapp, placeId: v.placeId }));
                  const res = await fetch("/api/outreach/mass", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      vendors: targets,
                      message: rfq.vendorMessage,
                      rfq,
                      region: origin.label,
                    }),
                  });
                  const d = await res.json();
                  if (d.results) {
                    for (const r of d.results) {
                      if (r.sent) {
                        patchVendor(r.id, { stage: "awaiting-response" });
                      }
                    }
                    setMassNote(
                      d.sent > 0
                        ? `${t("Agents are on it - shops asked:")} ${d.sent}`
                        : d.connect
                        ? t("Connect your WhatsApp in Profile first.")
                        : t("No shops could be messaged right now.")
                    );
                  } else {
                    setMassNote(d.error ?? t("Could not start the mass bargain."));
                    if (d.upgrade) setUpgradeOpen(true);
                  }
                } finally {
                  setMassState("done");
                }
              }}
              disabled={massState === "running"}
              className={`btn w-full rounded-2xl py-3 text-[14px] font-extrabold text-white disabled:opacity-70 ${
                session?.plan === "free" ? "bg-faint" : "badge-flash"
              }`}
            >
              {massState === "running" ? (
                <LoadingDots light label={t("Agents contacting every shop")} />
              ) : (
                <>⚡ {t("Mass bargain - ask all shops at once")}{session?.plan === "free" ? " 🔒" : ""}</>
              )}
            </button>
            {massNote && (
              <p className="mt-1 text-center text-[11px] font-bold text-soft">{massNote}</p>
            )}
          </div>
        )}

        {vendors.length > 0 && (
          <>
            <div className="surface-strong sticky top-16 z-20 mt-4 flex items-center gap-1 rounded-2xl p-1">
              <ToggleBtn active={view === "list"} onClick={() => setView("list")}>
                <Icon name="list" className="h-4 w-4" /> {t("List")}
              </ToggleBtn>
              <ToggleBtn active={view === "map"} onClick={() => setView("map")}>
                <Icon name="map" className="h-4 w-4" /> {t("Map")}
              </ToggleBtn>
            </div>
            <div className="mt-3">
              <Filters filters={filters} onChange={setFilters} availableClasses={availableClasses} />
            </div>
          </>
        )}

        {view === "map" && vendors.length > 0 ? (
          <div className="relative z-0 mt-3 h-[58vh] overflow-hidden rounded-blob border-2 border-line md:h-[64vh]">
            <MapView
              origin={origin}
              radiusKm={radiusKm}
              vendors={filtered}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onOpenVendor={(v) => {
                setView("list");
                setSelectedId(v.id);
              }}
            />
          </div>
        ) : (
          <div className="mt-3 space-y-3 md:grid md:grid-cols-2 md:gap-3 md:space-y-0">
            {filtered.map((v) => (
              <VendorCard
                key={v.id}
                vendor={v}
                rfq={rfq}
                plan={session?.plan}
                onBook={setBookingVendor}
                onReviews={setReviewsVendor}
                waConnected={waConnected}
                onBargain={setBargainVendor}
                onStage={(id, stage) => patchVendor(id, { stage })}
                onCustomMessage={customMessage}
              />
            ))}
            {phase === "running" && filtered.length < vendors.length && (
              <div className="surface flex justify-center rounded-blob p-4">
                <LoadingDots label={t("More agents reporting in")} />
              </div>
            )}
          </div>
        )}

        {/* Meta-style skeleton cards while the agents search */}
        {phase === "profiling" && (
          <div className="mt-3 space-y-3 md:grid md:grid-cols-2 md:gap-3 md:space-y-0">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="surface overflow-hidden rounded-blob">
                <div className="skeleton h-24 w-full" />
                <div className="space-y-2 p-4">
                  <div className="skeleton h-4 w-2/3 rounded-full" />
                  <div className="skeleton h-3 w-1/2 rounded-full" />
                  <div className="skeleton h-9 w-full rounded-2xl" />
                </div>
              </div>
            ))}
          </div>
        )}

        {vendors.length > 3 && view === "list" && <AdBanner plan={session?.plan} />}

        {vendors.length === 0 && phase === "idle" && (
          <div className="mt-10 text-center">
            <div className="mx-auto mb-3 w-fit opacity-90 animate-slide-up">
              <BrandMark size={72} />
            </div>
            <p className="mx-auto max-w-[280px] text-sm text-soft">
              {t("Tell us what you want to ride and where you're staying - the agents will find every rental shop around you and bargain authentically for the best price.")}
            </p>
          </div>
        )}
      </div>

      {bookingVendor && (
        <BookingSheet
          vendor={bookingVendor}
          rfq={rfq}
          plan={session?.plan}
          onClose={() => setBookingVendor(null)}
        />
      )}
      {reviewsVendor && <ReviewsSheet vendor={reviewsVendor} onClose={() => setReviewsVendor(null)} />}
      {bargainVendor && rfq && (
        <BargainDraftModal
          vendor={bargainVendor}
          rfq={rfq}
          region={origin.label}
          round={bargainVendor.offer ? bargainVendor.offer.round + 1 : 0}
          plan={session?.plan}
          currentPricePerDay={bargainVendor.offer?.pricePerDay}
          rivalPricePerDay={
            cheapest && cheapest.id !== bargainVendor.id
              ? cheapest.offer?.pricePerDay
              : undefined
          }
          onClose={() => setBargainVendor(null)}
        />
      )}
      {feedbackOpen && <FeedbackModal email={session?.email} onClose={() => setFeedbackOpen(false)} />}
      {upgradeOpen && <UpgradeSheet onClose={() => setUpgradeOpen(false)} />}
      {onboarding && <Onboarding onClose={() => setOnboarding(false)} />}

      <TabBar
        active="home"
        onSelect={(t) => {
          if (t === "profile") window.location.href = "/profile";
          else {
            setView("list");
            window.scrollTo({ top: 0, behavior: "smooth" });
          }
        }}
        onFeedback={() => setFeedbackOpen(true)}
        onUpgrade={() => setUpgradeOpen(true)}
        showUpgrade={!upgradeOpen && !paidPlan && !onboarding}
      />
    </main>
  );
}

/* ---- small presentational helpers ---- */

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-lg bg-card2 px-2 py-0.5 text-[11px] font-bold capitalize text-soft">
      {children}
    </span>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="surface rounded-blob p-3 text-center">
      <div className="text-[10px] font-extrabold uppercase tracking-wide text-faint">{label}</div>
      <div className={`text-lg font-extrabold ${accent ? "text-brandblue" : "text-strong"}`}>
        <AnimatedNumber value={value} />
      </div>
    </div>
  );
}

function ToggleBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`btn flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2 text-sm font-extrabold ${
        active ? "bg-brandblue text-white" : "text-soft hover:bg-card2"
      }`}
    >
      {children}
    </button>
  );
}

/* ---- filtering / sorting ---- */

function applyFilters(vendors: Vendor[], f: FilterState, days: number): Vendor[] {
  let list = [...vendors];

  if (f.vehicleClass !== "any")
    list = list.filter((v) => v.vehicleClasses.includes(f.vehicleClass as any));
  if (f.deliveryOnly) list = list.filter((v) => v.fulfillment.includes("hotel-delivery"));
  if (f.fulfillment === "in-store")
    list = list.filter((v) => v.fulfillment.includes("in-store"));
  if (f.openNowOnly) list = list.filter((v) => v.openNow !== false);
  if (f.minRating > 0) list = list.filter((v) => v.rating >= f.minRating);
  if (f.maxPricePerDay)
    list = list.filter((v) => v.offer && v.offer.pricePerDay <= (f.maxPricePerDay as number));

  if (f.agentStatus === "negotiating") list = list.filter((v) => v.stage === "negotiating");
  else if (f.agentStatus === "offer") list = list.filter((v) => v.offer);
  else if (f.agentStatus === "dropped")
    list = list.filter((v) => v.offer && v.offer.round > 0);

  const savingsOf = (v: Vendor) =>
    v.offer ? (v.offer.listPricePerDay - v.offer.pricePerDay) * days : -1;

  list.sort((a, b) => {
    switch (f.sort) {
      case "rating":
        return b.rating - a.rating;
      case "savings":
        return savingsOf(b) - savingsOf(a);
      case "status":
        return (b.offer ? 1 : 0) - (a.offer ? 1 : 0);
      default:
        return (a.distanceKm ?? 0) - (b.distanceKm ?? 0);
    }
  });
  return list;
}
