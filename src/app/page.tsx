"use client";

import { useCallbackRef } from "@/components/useCallbackRef";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Vendor, StructuredRFQ, Session, TrackerStage } from "@/lib/types";
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

const MapView = dynamic(() => import("@/components/MapView"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-faint">Loading map...</div>
  ),
});

const EXAMPLES = [
  "125cc automatic scooter with a phone mount, under 20,000 km, for 3 days",
  "Small automatic car, hotel delivery, 5 days, GPS included",
  "Manual motorcycle with helmet and storage box, cheapest possible, 1 week",
];

const DEFAULT_ORIGIN: Origin = {
  label: "Canggu, Bali, Indonesia",
  lat: -8.6478,
  lng: 115.1385,
};

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [origin, setOrigin] = useState<Origin>(DEFAULT_ORIGIN);
  const [radiusKm, setRadiusKm] = useState(8);
  const [rawText, setRawText] = useState(EXAMPLES[0]);
  const [rfq, setRfq] = useState<StructuredRFQ | null>(null);
  const [marketRate, setMarketRate] = useState<number | null>(null);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [source, setSource] = useState<"google" | "demo" | null>(null);
  const [phase, setPhase] = useState<"idle" | "profiling" | "running" | "done">("idle");
  const [view, setView] = useState<"list" | "map">("list");
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [bookingVendor, setBookingVendor] = useState<Vendor | null>(null);
  const [reviewsVendor, setReviewsVendor] = useState<Vendor | null>(null);
  const [aiOn, setAiOn] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        if (!d.session) window.location.href = "/login";
        else setSession(d.session);
      })
      .catch(() => {});
    return () => timers.current.forEach(clearTimeout);
  }, []);

  const patchVendor = useCallbackRef((id: string, patch: Partial<Vendor>) => {
    setVendors((vs) => vs.map((v) => (v.id === id ? { ...v, ...patch } : v)));
  });

  async function fetchOffer(vendor: Vendor, round: number, activeRfq: StructuredRFQ) {
    const res = await fetch("/api/negotiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendor, rfq: activeRfq, round }),
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.marketRate) setMarketRate(data.marketRate);
    if (data.pending) {
      // Real vendor: no invented price - we wait for the actual reply.
      patchVendor(vendor.id, { stage: "awaiting-response", sentiment: data.sentiment });
      return;
    }
    patchVendor(vendor.id, {
      stage: "offer-received",
      offer: data.offer,
      sentiment: data.sentiment,
    });
  }

  function runFunnel(list: Vendor[], activeRfq: StructuredRFQ) {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    const schedule = (fn: () => void, ms: number) =>
      timers.current.push(setTimeout(fn, ms));

    list.forEach((vendor, i) => {
      const base = i * 220;
      const stages: [TrackerStage, number][] = [
        ["locating-contact", base + 300],
        ["rfq-sent", base + 800],
        ["awaiting-response", base + 1300],
      ];
      stages.forEach(([stage, ms]) => schedule(() => patchVendor(vendor.id, { stage }), ms));

      if (!vendor.demo) {
        // Real vendors: fetch the market ESTIMATE only; real offers come from
        // actual replies once the RFQ is sent on WhatsApp.
        schedule(() => fetchOffer({ ...vendor }, 0, activeRfq), base + 1500);
        return;
      }

      const silent = vendor.rating < 3.8 && i % 3 === 0;
      if (silent) {
        schedule(() => patchVendor(vendor.id, { stage: "no-response" }), base + 2600);
        return;
      }
      schedule(() => patchVendor(vendor.id, { stage: "negotiating" }), base + 1900);
      schedule(() => fetchOffer({ ...vendor }, 0, activeRfq), base + 2700);
    });

    schedule(() => setPhase("done"), list.length * 220 + 3200);
  }

  async function startSearch() {
    if (!rawText.trim()) return;
    setPhase("profiling");
    setVendors([]);
    setRfq(null);
    setMarketRate(null);
    setSource(null);

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
    // The filter follows the request: searching for a motorcycle never shows
    // car chips as the active filter.
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
    setVendors(list);
    setPhase("running");
    runFunnel(list, pData.rfq);
  }

  async function bargain(vendorId: string) {
    const vendor = vendors.find((v) => v.id === vendorId);
    if (!vendor || !vendor.offer) return;
    patchVendor(vendorId, { stage: "negotiating" });
    const nextRound = vendor.offer.round + 1;
    const res = await fetch("/api/negotiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendor, rfq, round: nextRound }),
    });
    const data = await res.json();
    setTimeout(() => {
      if (data.offer) {
        patchVendor(vendorId, {
          stage: "offer-received",
          offer: data.offer,
          sentiment: data.sentiment,
        });
      }
    }, 650);
  }

  async function customMessage(vendorId: string, message: string) {
    const vendor = vendors.find((v) => v.id === vendorId);
    if (session && vendor?.whatsapp) {
      const res = await fetch("/api/outreach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: vendor.whatsapp, message }),
      });
      if (res.ok) return res.json();
    }
    const res = await fetch("/api/safety", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
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

  return (
    <main className="mx-auto min-h-[100dvh] max-w-md pb-36 sm:max-w-lg">
      {/* Section top bar */}
      <div className="topbar">
        <div className="flex items-center justify-between px-4 pb-2.5">
          <div className="flex items-center gap-2">
            <BrandMark size={34} />
            <div>
              <h1 className="font-display text-lg font-extrabold leading-none text-strong">
                Wheel<span className="text-brandblue">Deal</span>
              </h1>
              <p className="text-[10px] font-bold text-faint">
                Cheapest local rides, negotiated for you
              </p>
            </div>
          </div>
          <span
            className={`rounded-full px-2.5 py-1 text-[10px] font-extrabold ${
              aiOn ? "bg-savings-soft text-savings" : "bg-brandyellow-soft text-[#8a6100] dark:text-brandyellow"
            }`}
          >
            {aiOn ? "AI online" : "Demo AI"}
          </span>
        </div>
      </div>

      <div className="px-4">
        {/* Search panel */}
        <section className="surface mt-4 rounded-blob p-4">
          <label className="text-[12px] font-extrabold text-soft">Looking for...</label>
          <textarea
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            rows={2}
            className="mt-1 w-full resize-none rounded-2xl border-2 border-line bg-card p-3 text-sm text-strong placeholder:text-faint focus:border-brandblue focus:outline-none"
            placeholder="e.g. 125cc automatic scooter with phone mount, 3 days"
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
            Search radius · {radiusKm} km
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
            className="btn btn-primary mt-3 flex w-full items-center justify-center gap-2 rounded-2xl py-3.5 text-[15px] disabled:opacity-60"
          >
            {phase === "profiling" ? (
              "Structuring your request..."
            ) : phase === "running" ? (
              "Agents working..."
            ) : (
              <>
                <Icon name="bolt" className="h-5 w-5" /> Find my deal
              </>
            )}
          </button>
        </section>

        {/* Data source banner */}
        {source === "demo" && (
          <div className="mt-3 rounded-2xl bg-brandyellow-soft p-3 text-[12px] font-bold text-[#8a6100] dark:text-brandyellow animate-slide-up">
            You&apos;re seeing demo vendors. Add a Google Maps key (Admin → Keys) to
            search real rental places, prices and reviews.
          </div>
        )}
        {source === "google" && (
          <div className="mt-3 rounded-2xl bg-savings-soft p-3 text-[12px] font-bold text-savings animate-slide-up">
            ✓ Real rental places near your stay, live from Google Maps.
          </div>
        )}

        {/* RFQ summary */}
        {rfq && (
          <div className="surface mt-3 rounded-blob p-3 text-[12px] animate-slide-up">
            <div className="mb-1 flex items-center gap-1.5 font-extrabold text-brandblue">
              <Icon name="spark" className="h-3.5 w-3.5" /> Structured request
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Tag>{vehicleLabel(rfq.vehicleClass)}</Tag>
              {rfq.engineSizeCc && <Tag>{rfq.engineSizeCc}cc</Tag>}
              {rfq.maxMileageKm && <Tag>&lt;{rfq.maxMileageKm.toLocaleString()} km</Tag>}
              <Tag>{rfq.durationDays} days</Tag>
              {rfq.fulfillment !== "any" && <Tag>{rfq.fulfillment}</Tag>}
              {rfq.accessories.map((a) => (
                <Tag key={a}>{a}</Tag>
              ))}
            </div>
          </div>
        )}

        {/* Live stats */}
        {vendors.length > 0 && (
          <div className="mt-3 grid grid-cols-3 gap-2">
            <Stat label="Places found" value={vendors.length} />
            <Stat label="Offers in" value={offersIn} accent />
            <div className="surface rounded-blob p-3 text-center">
              <div className="text-[10px] font-extrabold uppercase tracking-wide text-savings">
                Savings
              </div>
              <div className="text-lg font-extrabold text-savings">
                $<AnimatedNumber value={Math.round(totalSavings)} />
              </div>
            </div>
          </div>
        )}

        {/* Best-deal banner */}
        {cheapest?.offer && (
          <div className="mt-3 flex items-center justify-between rounded-blob border-2 border-savings bg-savings-soft p-3 animate-slide-up">
            <div className="text-[12px]">
              <div className="font-bold text-soft">Cheapest right now</div>
              <div className="font-extrabold text-strong">{cheapest.name}</div>
            </div>
            <div className="text-right">
              <div className="text-xl font-extrabold text-savings">
                ${cheapest.offer.pricePerDay}
                <span className="text-xs text-soft">/day</span>
              </div>
              <button
                onClick={() => setBookingVendor(cheapest)}
                className="text-[11px] font-extrabold text-savings underline"
              >
                Lock it →
              </button>
            </div>
          </div>
        )}

        {/* View toggle + filters */}
        {vendors.length > 0 && (
          <>
            <div className="surface-strong sticky top-16 z-20 mt-4 flex items-center gap-1 rounded-2xl p-1">
              <ToggleBtn active={view === "list"} onClick={() => setView("list")}>
                <Icon name="list" className="h-4 w-4" /> List
              </ToggleBtn>
              <ToggleBtn active={view === "map"} onClick={() => setView("map")}>
                <Icon name="map" className="h-4 w-4" /> Map
              </ToggleBtn>
            </div>
            <div className="mt-3">
              <Filters
                filters={filters}
                onChange={setFilters}
                availableClasses={availableClasses}
              />
            </div>
          </>
        )}

        {/* Results */}
        {view === "map" && vendors.length > 0 ? (
          <div className="relative z-0 mt-3 h-[58vh] overflow-hidden rounded-blob border-2 border-line">
            <MapView
              origin={origin}
              radiusKm={radiusKm}
              vendors={filtered}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            {filtered.map((v) => (
              <VendorCard
                key={v.id}
                vendor={v}
                rfq={rfq}
                marketRate={marketRate}
                onBargain={bargain}
                onBook={setBookingVendor}
                onCustomMessage={customMessage}
                onReviews={setReviewsVendor}
              />
            ))}
            {phase === "running" && filtered.length < vendors.length && (
              <div className="surface rounded-blob p-4 text-center text-[12px] font-bold text-faint">
                More agents reporting in...
              </div>
            )}
          </div>
        )}

        {vendors.length === 0 && phase === "idle" && (
          <div className="mt-10 text-center">
            <div className="mx-auto mb-3 w-fit opacity-90">
              <BrandMark size={72} />
            </div>
            <p className="mx-auto max-w-[280px] text-sm text-soft">
              Tell us what you want to ride and where you&apos;re staying - the
              agents will find every rental place around you and chase the best
              price.
            </p>
          </div>
        )}
      </div>

      {bookingVendor && (
        <BookingSheet vendor={bookingVendor} rfq={rfq} onClose={() => setBookingVendor(null)} />
      )}
      {reviewsVendor && (
        <ReviewsSheet vendor={reviewsVendor} onClose={() => setReviewsVendor(null)} />
      )}
      {feedbackOpen && (
        <FeedbackModal email={session?.email} onClose={() => setFeedbackOpen(false)} />
      )}
      {upgradeOpen && <UpgradeSheet onClose={() => setUpgradeOpen(false)} />}

      <TabBar
        active={view === "map" ? "map" : "home"}
        onSelect={(t) => {
          if (t === "profile") window.location.href = "/profile";
          else if (t === "map") setView("map");
          else {
            setView("list");
            window.scrollTo({ top: 0, behavior: "smooth" });
          }
        }}
        onFeedback={() => setFeedbackOpen(true)}
        onUpgrade={() => setUpgradeOpen(true)}
        showUpgrade={!upgradeOpen}
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
