"use client";

import { useCallbackRef } from "@/components/useCallbackRef";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Vendor,
  StructuredRFQ,
  Session,
  TrackerStage,
} from "@/lib/types";
import { ORIGIN_PRESETS } from "@/lib/vendors";
import { Icon } from "@/components/icons";
import { Filters, DEFAULT_FILTERS, type FilterState } from "@/components/Filters";
import { VendorCard } from "@/components/VendorCard";
import { BookingSheet } from "@/components/BookingSheet";
import { AnimatedNumber } from "@/components/SavingsTicker";

const MapView = dynamic(() => import("@/components/MapView"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-slate-500">
      Loading map…
    </div>
  ),
});

const EXAMPLES = [
  "125cc automatic scooter with a phone mount, under 20,000 km, for 3 days",
  "Small automatic car, hotel delivery, 5 days, GPS included",
  "Motorbike with helmet and storage box, cheapest possible, 1 week",
];

export default function Home() {
  const [session, setSession] = useState<Session | null>(null);
  const [origin, setOrigin] = useState(ORIGIN_PRESETS[0]);
  const [radiusKm, setRadiusKm] = useState(8);
  const [rawText, setRawText] = useState(EXAMPLES[0]);
  const [rfq, setRfq] = useState<StructuredRFQ | null>(null);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [phase, setPhase] = useState<"idle" | "profiling" | "running" | "done">(
    "idle"
  );
  const [view, setView] = useState<"list" | "map">("list");
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [bookingVendor, setBookingVendor] = useState<Vendor | null>(null);
  const [aiOn, setAiOn] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => setSession(d.session))
      .catch(() => {});
    return () => timers.current.forEach(clearTimeout);
  }, []);

  const patchVendor = useCallbackRef((id: string, patch: Partial<Vendor>) => {
    setVendors((vs) => vs.map((v) => (v.id === id ? { ...v, ...patch } : v)));
  });

  async function fetchOffer(
    vendor: Vendor,
    round: number,
    activeRfq: StructuredRFQ
  ) {
    const res = await fetch("/api/negotiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vendor, rfq: activeRfq, round }),
    });
    if (!res.ok) return;
    const data = await res.json();
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

      // A couple of low-rated vendors stay silent — realistic funnel drop-off.
      const silent = vendor.rating < 3.8 && i % 3 === 0;
      if (silent) {
        schedule(() => patchVendor(vendor.id, { stage: "no-response" }), base + 2600);
        return;
      }
      schedule(() => patchVendor(vendor.id, { stage: "negotiating" }), base + 1900);
      schedule(() => fetchOffer({ ...vendor }, 0, activeRfq), base + 2700);
    });

    const total = list.length * 220 + 3200;
    schedule(() => setPhase("done"), total);
  }

  async function startSearch() {
    if (!rawText.trim()) return;
    setPhase("profiling");
    setVendors([]);
    setRfq(null);

    // 1) Profiler agent structures the request.
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

    // 2) Vendor discovery within radius.
    const vRes = await fetch("/api/vendors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        origin,
        radiusKm,
        vehicleClass: pData.rfq.vehicleClass,
        fulfillment:
          pData.rfq.fulfillment === "any" ? undefined : pData.rfq.fulfillment,
      }),
    });
    const vData = await vRes.json();
    const list: Vendor[] = (vData.vendors ?? []).map((v: Vendor) => ({
      ...v,
      stage: "queued" as TrackerStage,
    }));
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
    setTimeout(
      () =>
        patchVendor(vendorId, {
          stage: "offer-received",
          offer: data.offer,
          sentiment: data.sentiment,
        }),
      650
    );
  }

  async function customMessage(vendorId: string, message: string) {
    const vendor = vendors.find((v) => v.id === vendorId);
    // Signed-in users dispatch via the official WhatsApp path (safety-screened
    // server-side). Otherwise fall back to a screen-only check for the demo.
    if (session && vendor) {
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
        sum +
        Math.max(0, (v.offer.listPricePerDay - v.offer.pricePerDay) * rfq.durationDays)
      );
    }, 0);
  }, [vendors, rfq]);

  const cheapest = useMemo(
    () =>
      vendors
        .filter((v) => v.offer)
        .sort((a, b) => (a.offer!.pricePerDay - b.offer!.pricePerDay))[0],
    [vendors]
  );

  return (
    <main className="mx-auto min-h-screen max-w-md px-4 pb-28 pt-5 sm:max-w-lg">
      {/* Header */}
      <header className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-savings/15">
            <Icon name="bolt" className="h-5 w-5 text-savings-bright" />
          </div>
          <div>
            <h1 className="text-lg font-extrabold leading-none tracking-tight text-white">
              Wheel<span className="text-savings-bright">Deal</span>
            </h1>
            <p className="text-[11px] text-slate-500">
              Cheapest local rides, negotiated for you
            </p>
          </div>
        </div>
        <nav className="flex items-center gap-2">
          {session?.isAdmin && (
            <a
              href="/admin"
              className="rounded-lg border border-slate-700/50 px-2.5 py-1.5 text-[12px] text-slate-300 hover:bg-slate-700/30"
            >
              Admin
            </a>
          )}
          {session ? (
            <span className="max-w-[110px] truncate rounded-lg bg-ink/50 px-2.5 py-1.5 text-[12px] text-slate-400">
              {session.email}
            </span>
          ) : (
            <a
              href="/login"
              className="rounded-lg bg-savings px-3 py-1.5 text-[12px] font-semibold text-ink"
            >
              Sign in
            </a>
          )}
        </nav>
      </header>

      {/* Search panel */}
      <section className="surface rounded-2xl p-4">
        <div className="mb-2 flex items-center justify-between">
          <label className="text-[12px] font-medium text-slate-300">
            What are you after?
          </label>
          <span
            className={`text-[10px] ${aiOn ? "text-savings" : "text-slate-500"}`}
          >
            {aiOn ? "AI agents online" : "Demo mode"}
          </span>
        </div>
        <textarea
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          rows={2}
          className="w-full resize-none rounded-xl border border-slate-700/50 bg-ink/60 p-3 text-sm text-white placeholder:text-slate-600 focus:border-savings/50 focus:outline-none"
          placeholder="e.g. 125cc scooter with phone mount, under 20,000 km, 3 days"
        />
        <div className="no-scrollbar mt-2 flex gap-2 overflow-x-auto">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              onClick={() => setRawText(ex)}
              className="whitespace-nowrap rounded-full border border-slate-700/50 px-2.5 py-1 text-[11px] text-slate-400 hover:bg-slate-700/30"
            >
              {ex.length > 34 ? ex.slice(0, 34) + "…" : ex}
            </button>
          ))}
        </div>

        {/* Origin + radius */}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <label className="text-[11px] text-slate-400">
            Your stay
            <select
              value={origin.label}
              onChange={(e) =>
                setOrigin(
                  ORIGIN_PRESETS.find((o) => o.label === e.target.value) ??
                    ORIGIN_PRESETS[0]
                )
              }
              className="mt-1 w-full rounded-lg border border-slate-700/50 bg-ink/60 p-2 text-sm text-white [color-scheme:dark]"
            >
              {ORIGIN_PRESETS.map((o) => (
                <option key={o.label} value={o.label}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[11px] text-slate-400">
            Radius · {radiusKm} km
            <input
              type="range"
              min={2}
              max={25}
              value={radiusKm}
              onChange={(e) => setRadiusKm(Number(e.target.value))}
              className="mt-3 w-full accent-savings"
            />
          </label>
        </div>

        <button
          onClick={startSearch}
          disabled={phase === "profiling" || phase === "running"}
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-savings py-3 text-sm font-bold text-ink transition hover:bg-savings-bright active:scale-[0.98] disabled:opacity-60"
        >
          {phase === "profiling" ? (
            "Profiler agent structuring your request…"
          ) : phase === "running" ? (
            "Agents negotiating…"
          ) : (
            <>
              <Icon name="bolt" className="h-4 w-4" /> Deploy agents & find deals
            </>
          )}
        </button>
      </section>

      {/* RFQ summary */}
      {rfq && (
        <div className="mt-3 rounded-xl border border-slate-700/40 bg-ink/40 p-3 text-[12px] text-slate-300 animate-slide-up">
          <div className="mb-1 flex items-center gap-1.5 font-medium text-savings">
            <Icon name="spark" className="h-3.5 w-3.5" /> Structured RFQ
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Tag>{rfq.vehicleClass}</Tag>
            {rfq.engineSizeCc && <Tag>{rfq.engineSizeCc}cc</Tag>}
            {rfq.transmission !== "any" && <Tag>{rfq.transmission}</Tag>}
            {rfq.maxMileageKm && <Tag>&lt;{rfq.maxMileageKm.toLocaleString()} km</Tag>}
            <Tag>{rfq.durationDays} days</Tag>
            {rfq.fulfillment !== "any" && <Tag>{rfq.fulfillment}</Tag>}
            {rfq.accessories.map((a) => (
              <Tag key={a}>{a}</Tag>
            ))}
          </div>
        </div>
      )}

      {/* Live stats bar */}
      {vendors.length > 0 && (
        <div className="mt-3 grid grid-cols-3 gap-2">
          <Stat label="Vendors reached" value={vendors.length} />
          <Stat label="Offers in" value={offersIn} accent />
          <div className="surface rounded-xl p-3 text-center">
            <div className="text-[10px] uppercase tracking-wide text-savings">
              Negotiated savings
            </div>
            <div className="text-lg font-bold text-savings-bright">
              $<AnimatedNumber value={Math.round(totalSavings)} />
            </div>
          </div>
        </div>
      )}

      {/* Best-deal banner */}
      {cheapest?.offer && (
        <div className="mt-3 flex items-center justify-between rounded-xl border border-savings/30 bg-savings/10 p-3 animate-slide-up">
          <div className="text-[12px]">
            <div className="text-slate-400">Cheapest right now</div>
            <div className="font-semibold text-white">{cheapest.name}</div>
          </div>
          <div className="text-right">
            <div className="text-xl font-bold text-savings-bright">
              ${cheapest.offer.pricePerDay}
              <span className="text-xs text-slate-400">/day</span>
            </div>
            <button
              onClick={() => setBookingVendor(cheapest)}
              className="text-[11px] font-semibold text-savings underline"
            >
              Lock it →
            </button>
          </div>
        </div>
      )}

      {/* View toggle + filters */}
      {vendors.length > 0 && (
        <>
          <div className="sticky top-2 z-20 mt-4">
            <div className="surface-strong flex items-center gap-1 rounded-xl p-1">
              <ToggleBtn active={view === "list"} onClick={() => setView("list")}>
                <Icon name="list" className="h-4 w-4" /> List
              </ToggleBtn>
              <ToggleBtn active={view === "map"} onClick={() => setView("map")}>
                <Icon name="map" className="h-4 w-4" /> Map
              </ToggleBtn>
            </div>
          </div>

          <div className="mt-3">
            <Filters filters={filters} onChange={setFilters} />
          </div>
        </>
      )}

      {/* Results */}
      {view === "map" && vendors.length > 0 ? (
        <div className="mt-3 h-[62vh] overflow-hidden rounded-2xl border border-slate-700/40">
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
              onBargain={bargain}
              onBook={setBookingVendor}
              onCustomMessage={customMessage}
            />
          ))}
          {phase === "running" && filtered.length < vendors.length && (
            <div className="rounded-2xl border border-slate-700/40 p-4 text-center text-[12px] text-slate-500">
              More agents reporting in…
            </div>
          )}
        </div>
      )}

      {vendors.length === 0 && phase === "idle" && (
        <div className="mt-8 text-center text-slate-500">
          <Icon name="bolt" className="mx-auto mb-2 h-8 w-8 text-slate-700" />
          <p className="text-sm">
            Describe your ideal ride and deploy the agents. They&apos;ll ping
            every partner vendor near your stay and negotiate the price down —
            live.
          </p>
        </div>
      )}

      {bookingVendor && (
        <BookingSheet
          vendor={bookingVendor}
          rfq={rfq}
          onClose={() => setBookingVendor(null)}
        />
      )}

      <footer className="mt-10 text-center text-[10px] leading-relaxed text-slate-600">
        Outreach uses the official WhatsApp Cloud API to opted-in partner
        vendors. Agents identify themselves as automated procurement assistants.
      </footer>
    </main>
  );
}

/* ---- small presentational helpers ---- */

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-md bg-slate-700/30 px-2 py-0.5 text-[11px] capitalize text-slate-300">
      {children}
    </span>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: boolean;
}) {
  return (
    <div className="surface rounded-xl p-3 text-center">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div
        className={`text-lg font-bold ${accent ? "text-savings-bright" : "text-white"}`}
      >
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
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-medium transition ${
        active ? "bg-savings text-ink" : "text-slate-300 hover:bg-slate-700/30"
      }`}
    >
      {children}
    </button>
  );
}

/* ---- filtering / sorting ---- */

function applyFilters(
  vendors: Vendor[],
  f: FilterState,
  days: number
): Vendor[] {
  let list = [...vendors];

  if (f.vehicleClass !== "any")
    list = list.filter((v) => v.vehicleClasses.includes(f.vehicleClass as any));
  if (f.deliveryOnly)
    list = list.filter((v) => v.fulfillment.includes("hotel-delivery"));
  if (f.fulfillment === "in-store")
    list = list.filter((v) => v.fulfillment.includes("in-store"));
  if (f.minRating > 0) list = list.filter((v) => v.rating >= f.minRating);
  if (f.maxPricePerDay)
    list = list.filter(
      (v) => v.offer && v.offer.pricePerDay <= (f.maxPricePerDay as number)
    );

  if (f.agentStatus === "negotiating")
    list = list.filter((v) => v.stage === "negotiating");
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
