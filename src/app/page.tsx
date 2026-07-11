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
import { Modal } from "@/components/Modal";
import { BrandMark } from "@/components/BrandMark";
import { OriginPicker, type Origin } from "@/components/OriginPicker";
import { FaqSection } from "@/components/FaqSection";
import { ReviewsSheet } from "@/components/ReviewsSheet";
import { UpgradeSheet } from "@/components/UpgradeSheet";
import { BargainDraftModal } from "@/components/BargainDraftModal";
import { Onboarding } from "@/components/Onboarding";
import { AdBanner } from "@/components/AdBanner";
import { LoadingDots } from "@/components/LoadingDots";
import { LanguageButton } from "@/components/LanguageButton";
import { useI18n } from "@/lib/i18n";
import { moneyLocal } from "@/lib/currency";

const MapView = dynamic(() => import("@/components/MapView"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center">
      <LoadingDots label="Loading map" />
    </div>
  ),
});

// Dozens of ready-made searches; each visit shows a random 3-4 of them so the
// home screen always feels fresh.
const ALL_EXAMPLES = [
  "125cc automatic scooter with a phone mount, under 20,000 km, for 3 days",
  "Automatic SUV, 5 seats, 5 days, GPS + child seat, cheapest possible",
  "Economy automatic car, 7 days, hotel delivery, best price",
  "Manual motorcycle with helmet and storage box, cheapest possible, 1 week",
  "160cc scooter (NMax or PCX), 2 helmets, 5 days, delivery to my hotel",
  "Cheap 110cc scooter for 2 weeks, long-term discount",
  "Automatic scooter for 1 day, need it in the next hour",
  "300cc manual motorcycle, 3 days, helmet + gloves",
  "Big bike 650cc+, weekend ride, 2 days",
  "7-seater van, airport pickup, 4 days, cheapest",
  "Luxury sedan for 2 days, wedding, white if possible",
  "Small automatic car, 10 days, unlimited mileage",
  "Scooter with 2 helmets and a child seat, 4 days",
  "125cc scooter, month-long rental, best monthly rate",
  "4x4 SUV for a mountain trip, 3 days, full insurance",
  "Manual motorcycle 150cc, 5 days, phone mount + raincoat",
  "Electric scooter or small EV, 2 days, city only",
  "Automatic car with GPS, 6 days, hotel delivery, no deposit if possible",
  "Vespa-style scooter, 3 days, photo-friendly color",
  "Cheapest anything with 2 wheels for tomorrow, 1 day",
  "Sedan with driver-quality comfort, 8 days, best total price",
  "Scooter under 15,000 km with new tires, 1 week",
  "Motorbike for two people with top box, 5 days",
  "Compact car, 3 days, need child booster seat",
];

// Free plan is today-pickup only, so never suggest future-scheduling searches.
const FUTURE_HINT = /tomorrow|next (hour|day|week)|weekend|month|long-term|\d+ weeks?/i;
function pickExamples(plan?: string): string[] {
  const pool =
    plan === "free" ? ALL_EXAMPLES.filter((e) => !FUTURE_HINT.test(e)) : ALL_EXAMPLES;
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 3 + Math.floor(Math.random() * 2)); // 3-4 chips
}

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
  const [examples, setExamples] = useState<string[]>(ALL_EXAMPLES.slice(0, 4));
  const [rawText, setRawText] = useState(ALL_EXAMPLES[0]);
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
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [onboarding, setOnboarding] = useState(false);
  const [waConnected, setWaConnected] = useState(false);
  const [massState, setMassState] = useState<"idle" | "running" | "done">("idle");
  const [massNote, setMassNote] = useState<string | null>(null);
  // Ultra option: let the agents bargain in the shop's LOCAL language. OFF by
  // default (optional), persisted, and gated - free/pro see the upgrade sheet.
  const [localLang, setLocalLang] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [restored, setRestored] = useState(false);
  // Live status panel (expandable) + user-facing queued-message list (bug #1/#9).
  const [statusOpen, setStatusOpen] = useState(false);
  const [queueItems, setQueueItems] = useState<
    { id: number; vendorId: string | null; vendorName: string | null; toNumber: string; notBefore: string; due: boolean; reason: string }[]
  >([]);
  // Local going-rate hint (item #6): what the cheapest scooter / economy car
  // honestly costs per day around the chosen stay, in the LOCAL currency.
  const [priceHint, setPriceHint] = useState<{
    scooter: { floor: number; typical: number | null; currency: string } | null;
    car: { floor: number; typical: number | null; currency: string } | null;
  } | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const appliedReplies = useRef<Set<number>>(new Set());
  // ATOMIC SESSION: a monotonic epoch stamped when a search starts. Only shop
  // replies created AFTER this moment belong to THIS session - anything older
  // (a previous search's offers/threads) is rejected, so a "New search" can
  // never resurrect a stale bargain from a shop you already left.
  const [searchEpoch, setSearchEpoch] = useState<number>(0);

  // Restore the local-language preference.
  useEffect(() => {
    try {
      setLocalLang(localStorage.getItem("wd_local_lang") === "1");
    } catch {}
  }, []);

  // Refresh the going-rate hint whenever the stay changes. Best-effort only -
  // a missing hint never blocks the search.
  useEffect(() => {
    const label = origin?.label?.trim();
    if (!label || label === "My current location") {
      setPriceHint(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/market/hint?region=${encodeURIComponent(label)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        setPriceHint(d.scooter || d.car ? { scooter: d.scooter ?? null, car: d.car ?? null } : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [origin?.label]);
  const localLangActive = localLang && session?.plan === "ultra";

  // Fresh random suggestion chips on every visit (client-only so SSR markup
  // stays deterministic). Free users never see future-day pickup suggestions.
  useEffect(() => {
    const picked = pickExamples(session?.plan);
    setExamples(picked);
    setRawText((prev) => (ALL_EXAMPLES.includes(prev) ? picked[0] : prev));
  }, [session?.plan]);

  // Restore a previous search so it survives navigating to Profile/Admin and
  // back. Kept in sessionStorage; cleared only by the explicit Clear button.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("wd_search");
      if (raw) {
        const s = JSON.parse(raw);
        if (s.vendors?.length) {
          setVendors(s.vendors);
          setRfq(s.rfq ?? null);
          setSource(s.source ?? null);
          setSourceError(s.sourceError ?? null);
          setRawText(s.rawText ?? ALL_EXAMPLES[0]);
          if (s.origin) setOrigin(s.origin);
          if (typeof s.radiusKm === "number") setRadiusKm(s.radiusKm);
          if (s.filters) setFilters(s.filters);
          if (typeof s.searchEpoch === "number") setSearchEpoch(s.searchEpoch);
          setPhase("done");
        }
      }
    } catch {}
    setRestored(true);
  }, []);

  // Persist the search whenever the vendor list changes.
  useEffect(() => {
    if (!restored) return;
    try {
      if (vendors.length) {
        sessionStorage.setItem(
          "wd_search",
          JSON.stringify({ vendors, rfq, source, sourceError, rawText, origin, radiusKm, filters, searchEpoch })
        );
      } else {
        sessionStorage.removeItem("wd_search");
      }
    } catch {}
  }, [vendors, rfq, source, sourceError, rawText, origin, radiusKm, filters, restored]);

  function clearSearch() {
    timers.current.forEach(clearTimeout);
    setVendors([]);
    setRfq(null);
    setSource(null);
    setSourceError(null);
    setPhase("idle");
    setClearConfirm(false);
    appliedReplies.current = new Set();
    setQueueItems([]);
    // Future replies belong to a NEW session - anything before now is dead.
    setSearchEpoch(Date.now());
    // HARD close on the server too: purge every queued message and stamp the
    // session-closed marker so the agents stop talking to the old shops.
    fetch("/api/session/close", { method: "POST" }).catch(() => {});
    try {
      sessionStorage.removeItem("wd_search");
    } catch {}
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

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
    // Don't override a restored search's origin with the phone location.
    let hasSaved = false;
    try {
      hasSaved = Boolean(sessionStorage.getItem("wd_search"));
    } catch {}
    if (hasSaved) return;
    navigator.geolocation?.getCurrentPosition(
      async (pos) => {
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        // Show the point instantly, then resolve it to a REAL named place so the
        // local currency + language work (a bare "My current location" has no
        // country to read).
        setOrigin({ label: "My current location", lat, lng });
        try {
          const d = await (await fetch(`/api/geocode?lat=${lat}&lng=${lng}`)).json();
          if (d?.place?.label) setOrigin({ label: d.place.label, lat, lng });
        } catch {}
      },
      () => {}
    );
  }, [session]);

  const patchVendor = useCallbackRef((id: string, patch: Partial<Vendor>) => {
    setVendors((vs) => vs.map((v) => (v.id === id ? { ...v, ...patch } : v)));
  });

  // The traveller's own held-for-opening-hours queue (bug #9). They can see it
  // and remove any queued message; the matching card clears its queued badge.
  const refreshQueue = useCallbackRef(async () => {
    if (!session) return;
    try {
      const d = await (await fetch("/api/queue")).json();
      const items: { vendorId: string | null; notBefore: string }[] = Array.isArray(d.items) ? d.items : [];
      setQueueItems(d.items ?? []);
      // Reconcile the cards with the SERVER (single source of truth for the
      // queued badge, covering every send path): set the badge for shops with a
      // held message, clear it once that message leaves the outbox (sent/removed).
      const byVendor = new Map<string, string>();
      for (const i of items) if (i.vendorId) byVendor.set(i.vendorId, i.notBefore);
      setVendors((vs) =>
        vs.map((v) => {
          if (v.offer || !v.id) return v; // an offer supersedes any queue badge
          const until = byVendor.get(v.id);
          if (until && v.queuedUntil !== until) return { ...v, queuedUntil: until };
          if (!until && v.queuedUntil) return { ...v, queuedUntil: undefined };
          return v;
        })
      );
    } catch {
      /* keep the last snapshot */
    }
  });

  async function removeQueued(id: number, vendorId: string | null) {
    setQueueItems((items) => items.filter((i) => i.id !== id));
    if (vendorId) patchVendor(vendorId, { queuedUntil: undefined, lastEventAt: Date.now() });
    try {
      await fetch("/api/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", id }),
      });
    } finally {
      refreshQueue();
    }
  }

  // Poll the queue while there are vendors on screen (cheap, user-scoped).
  useEffect(() => {
    if (!session || vendors.length === 0) return;
    refreshQueue();
    const id = setInterval(refreshQueue, 20000);
    return () => clearInterval(id);
  }, [session, vendors.length, refreshQueue]);

  // Reply-VERIFIED shop tags (item #13): one batched fetch per result set,
  // plus a slow refresh while the search is on screen - a shop's second
  // confirming reply can promote a tag mid-session.
  const vendorIdsKey = useMemo(
    () => vendors.map((v) => v.id).filter(Boolean).sort().join(","),
    [vendors]
  );
  useEffect(() => {
    if (!session || !vendorIdsKey) return;
    let cancelled = false;
    const load = async () => {
      try {
        const d = await (
          await fetch(`/api/vendors/tags?ids=${encodeURIComponent(vendorIdsKey)}`)
        ).json();
        if (cancelled || !d?.tags) return;
        setVendors((vs) =>
          vs.map((v) => {
            const next = (Array.isArray(d.tags[v.id]) ? d.tags[v.id] : []).slice().sort();
            const curTags = (v.verifiedTags ?? []).slice().sort();
            if (next.join("|") === curTags.join("|")) return v;
            return { ...v, verifiedTags: next };
          })
        );
      } catch {}
    };
    load();
    const id = setInterval(load, 60000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [session, vendorIdsKey]);

  // Live loop: while agents are in ANY active conversation, poll the reply
  // feed so shop answers pop into the cards automatically. This must include
  // offer-received/negotiating - after a bargain is sent the shop's counter
  // must still arrive without a manual refresh.
  const waiting = vendors.some((v) =>
    ["rfq-sent", "awaiting-response", "negotiating", "offer-received"].includes(v.stage ?? "")
  );
  useEffect(() => {
    if (!session || !waiting || !rfq) return;
    const tick = async () => {
      try {
        // Scope to THIS session both server-side (since=) and client-side, so a
        // previous search's replies can never render on the new results.
        const res = await fetch(`/api/replies?since=${searchEpoch}`, { cache: "no-store" });
        const d = await res.json();
        for (const r of d.replies ?? []) {
          if (!r.found || !r.pricePerDay || appliedReplies.current.has(r.id)) continue;
          if (searchEpoch && r.createdAt && Date.parse(r.createdAt) < searchEpoch) continue;
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
                      // The shop's OWN currency from the reply (server-derived);
                      // never a silent USD default.
                      currency: r.currency ?? v.offer?.currency ?? "USD",
                      totalPrice: Math.round(r.pricePerDay * rfq.durationDays),
                      includesInsurance: false,
                      includesDelivery: r.delivers === true || v.offer?.includesDelivery === true,
                      message: r.replyText?.slice(0, 200) ?? "",
                      round: v.offer ? v.offer.round + 1 : 0,
                      verified: Boolean(r.verified),
                      simulated: false,
                      deposit: r.deposit ?? v.offer?.deposit,
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
  }, [session, waiting, rfq, searchEpoch]);

  function runFunnel(list: Vendor[], _activeRfq: StructuredRFQ) {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    const schedule = (fn: () => void, ms: number) =>
      timers.current.push(setTimeout(fn, ms));

    list.forEach((vendor, i) => {
      const base = i * 200;
      schedule(() => {
        // Sentiment is a pure function of rating - computing it here instead of
        // one HTTP call PER VENDOR makes every search dramatically faster.
        const warmth = Math.min(1, Math.max(0.1, (vendor.rating - 3.5) / 1.4));
        patchVendor(vendor.id, {
          stage: "locating-contact",
          sentiment: Number(warmth.toFixed(2)),
        });
      }, base + 300);
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
    // Open a fresh atomic session: stamp the epoch and forget every reply id
    // applied by the previous session.
    const epoch = Date.now();
    setSearchEpoch(epoch);
    appliedReplies.current = new Set();
    setQueueItems([]);
    // Close the PREVIOUS session on the server first: purge its queued
    // messages and silence its shop threads before any new RFQ goes out.
    await fetch("/api/session/close", { method: "POST" }).catch(() => {});

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
        region: origin.label || undefined,
        openNow: vendor?.openNow,
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

  // The savings ticker's currency symbol comes from the offers themselves
  // (they all share the search's local currency) - never a hardcoded "$".
  const savingsSymbol = useMemo(() => {
    const cur = vendors.find((v) => v.offer)?.offer?.currency;
    return cur ? moneyLocal(0, cur).replace(/[\d.,\s]/g, "") || "$" : "$";
  }, [vendors]);

  // Live status for the session strip (bug #1). Three HONEST buckets that never
  // contradict each other:
  //   messaged = the shop was actually contacted (delivered, now awaiting reply)
  //   queued   = the message is held for the shop's opening hours (auto-sends)
  //   offers   = a price is in
  const statusGroups = useMemo(() => {
    const messaged: Vendor[] = [];
    const queued: Vendor[] = [];
    const deals: Vendor[] = [];
    for (const v of vendors) {
      if (v.offer) deals.push(v);
      else if (v.queuedUntil) queued.push(v);
      else if (["rfq-sent", "awaiting-response", "negotiating"].includes(v.stage ?? "")) messaged.push(v);
    }
    return { messaged, queued, deals };
  }, [vendors]);
  const stageCounts = {
    messaged: statusGroups.messaged.length,
    queued: statusGroups.queued.length,
    offers: statusGroups.deals.length,
  };

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
            <LanguageButton />
          </div>
        </div>
      </div>

      <div className="px-4">
        <section className="surface mt-4 rounded-blob p-4">
          <label className="text-[12px] font-extrabold text-soft">
            {t("What do you want to rent?")}
          </label>
          <textarea
            data-tour="request"
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            rows={2}
            className="mt-1 w-full resize-none rounded-2xl border-2 border-line bg-card p-3 text-sm text-strong placeholder:text-faint focus:border-brandblue focus:outline-none"
            placeholder={t("e.g. automatic SUV 5 seats for 5 days, or 125cc scooter with phone mount")}
          />
          <div data-tour="examples" className="no-scrollbar mt-2 flex gap-2 overflow-x-auto">
            {examples.map((ex) => (
              <button
                key={ex}
                onClick={() => setRawText(ex)}
                className="chip whitespace-nowrap rounded-full border-2 border-line bg-card px-2.5 py-1 text-[11px] font-bold text-faint hover:border-brandblue/40 hover:text-soft"
              >
                {ex.length > 36 ? ex.slice(0, 36) + "..." : ex}
              </button>
            ))}
          </div>

          <div data-tour="stay" className="mt-3">
            <OriginPicker origin={origin} onChange={setOrigin} />
          </div>

          {priceHint && (priceHint.scooter || priceHint.car) && (
            <div className="mt-2 rounded-2xl bg-brandblue-soft p-2.5 text-[11px] font-bold leading-relaxed text-brandblue animate-slide-up">
              💡 {t("Local going rate here:")}{" "}
              {priceHint.scooter && (
                <>
                  {t("scooters from")} ~{moneyLocal(priceHint.scooter.floor, priceHint.scooter.currency)}/{t("day")}
                </>
              )}
              {priceHint.scooter && priceHint.car && " · "}
              {priceHint.car && (
                <>
                  {t("economy cars from")} ~{moneyLocal(priceHint.car.floor, priceHint.car.currency)}/{t("day")}
                </>
              )}
              . {t("Your agents bargain toward the real local floor.")}
            </div>
          )}

          <label data-tour="radius" className="mt-3 block text-[12px] font-extrabold text-soft">
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
            data-tour="find"
            onClick={startSearch}
            disabled={phase === "profiling" || phase === "running"}
            className="btn btn-primary cta-sheen mt-3 flex w-full items-center justify-center gap-2 rounded-2xl py-3.5 text-[15px] disabled:opacity-70"
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

        {vendors.length > 0 && (
          <button
            onClick={() => setClearConfirm(true)}
            className="btn btn-ghost mt-3 flex w-full items-center justify-center gap-1.5 rounded-2xl py-2 text-[12px] font-extrabold"
          >
            <Icon name="x" className="h-3.5 w-3.5" /> {t("Clear search")}
          </button>
        )}

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
                {/* Savings in the shops' LOCAL currency - no symbol before any
                    offer exists (a "$0" would presume the wrong currency) */}
                {offersIn > 0 ? savingsSymbol : ""}
                <AnimatedNumber value={Math.round(totalSavings)} />
              </div>
            </div>
          </div>
        )}

        {/* Live session status: what the agents are doing RIGHT NOW. Tappable to
            expand into per-shop detail - which shops were messaged, which held
            for opening hours (removable), which sent a deal, and exactly when. */}
        {vendors.length > 0 && (
          <div data-tour="status" className="mt-2 overflow-hidden rounded-2xl bg-card2">
            <button
              onClick={() => setStatusOpen((o) => !o)}
              className="flex w-full items-center gap-x-3 gap-y-1 px-3 py-2 text-left text-[11px] font-bold text-soft"
            >
              {stageCounts.messaged > 0 && <span>📤 {stageCounts.messaged} {t("messaged")}</span>}
              {stageCounts.queued > 0 && <span>🕘 {stageCounts.queued} {t("queued")}</span>}
              {stageCounts.offers > 0 && <span className="text-savings">💰 {stageCounts.offers} {t("offers")}</span>}
              {stageCounts.messaged + stageCounts.queued + stageCounts.offers === 0 && (
                <span>{t("Tap 'Ask for price' on a shop to start")}</span>
              )}
              {stageCounts.messaged + stageCounts.queued + stageCounts.offers > 0 && (
                <span className="ml-auto text-[10px] text-faint">{statusOpen ? "▲" : "▼"}</span>
              )}
            </button>

            {statusOpen && (stageCounts.messaged + stageCounts.queued + stageCounts.offers > 0) && (
              <div className="space-y-2 border-t border-line px-3 py-2.5">
                {/* Deals in - from whom, price, exact time */}
                {statusGroups.deals.length > 0 && (
                  <div>
                    <div className="mb-1 text-[10px] font-extrabold uppercase text-savings">💰 {t("Deals in")}</div>
                    {statusGroups.deals.map((v) => (
                      <div key={v.id} className="flex items-center justify-between gap-2 py-0.5 text-[11px]">
                        <span className="truncate font-bold text-strong">{v.name}</span>
                        <span className="shrink-0 text-soft">
                          {v.offer && moneyLocal(v.offer.pricePerDay, v.offer.currency)}/{t("day")}
                          {v.lastEventAt ? ` · ${new Date(v.lastEventAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Messaged - and the EXACT text/gloss we sent on their behalf */}
                {statusGroups.messaged.length > 0 && (
                  <div>
                    <div className="mb-1 text-[10px] font-extrabold uppercase text-faint">📤 {t("Messaged")}</div>
                    {statusGroups.messaged.map((v) => (
                      <div key={v.id} className="py-0.5 text-[11px]">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-bold text-strong">{v.name}</span>
                          <span className="shrink-0 text-faint">
                            {v.lastEventAt ? new Date(v.lastEventAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : t("awaiting reply")}
                          </span>
                        </div>
                        {v.sentGloss && (
                          <div className="mt-0.5 rounded-lg bg-card px-2 py-1 text-[10px] text-soft">
                            🌐 {v.sentGloss}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Queued for opening hours - user decides: wait or remove (#9) */}
                {statusGroups.queued.length > 0 && (
                  <div>
                    <div className="mb-1 text-[10px] font-extrabold uppercase text-faint">🕘 {t("Waiting for the shop to open")}</div>
                    {statusGroups.queued.map((v) => {
                      const q = queueItems.find((i) => i.vendorId === v.id);
                      return (
                        <div key={v.id} className="flex items-center justify-between gap-2 py-0.5 text-[11px]">
                          <span className="min-w-0">
                            <span className="block truncate font-bold text-strong">{v.name}</span>
                            <span className="block text-[10px] text-faint">
                              {t("Sends automatically when they open")}
                              {v.queuedUntil ? ` · ~${new Date(v.queuedUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}
                            </span>
                          </span>
                          <button
                            onClick={() => (q ? removeQueued(q.id, v.id) : patchVendor(v.id, { queuedUntil: undefined }))}
                            className="btn btn-sm shrink-0 rounded-lg border-2 border-line px-2 py-0.5 text-[10px] font-extrabold text-brandred hover:bg-brandred-soft"
                          >
                            {t("Remove")}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* YOUR QUEUED MESSAGES (item #2): always-visible, per-user card driven
            by the server queue - every traveller sees and manages exactly what
            is waiting to be sent on their behalf (shop closed, human pacing,
            strategist hold) and can remove any of it. */}
        {queueItems.length > 0 && (
          <div data-tour="queue" className="surface mt-3 rounded-blob p-3 animate-slide-up">
            <div className="mb-1.5 flex items-center justify-between">
              <div className="text-[13px] font-extrabold text-strong">
                🕘 {t("Your queued messages")} ({queueItems.length})
              </div>
              <span className="text-[10px] font-bold text-faint">{t("auto-sends")}</span>
            </div>
            <div className="space-y-1.5">
              {queueItems.map((q) => (
                <div key={q.id} className="flex items-center justify-between gap-2 rounded-xl bg-card2 p-2">
                  <span className="min-w-0">
                    <span className="block truncate text-[12px] font-bold text-strong">
                      {q.vendorName || q.toNumber}
                    </span>
                    <span className="block text-[10px] text-faint">
                      {t(q.reason)}
                      {q.notBefore
                        ? ` · ~${new Date(q.notBefore).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                        : ""}
                    </span>
                  </span>
                  <button
                    onClick={() => removeQueued(q.id, q.vendorId)}
                    className="btn btn-sm shrink-0 rounded-lg border-2 border-line px-2 py-1 text-[10px] font-extrabold text-brandred hover:bg-brandred-soft"
                  >
                    {t("Remove")}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {cheapest?.offer && (
          <div className="mt-3 flex items-center justify-between rounded-blob border-2 border-savings bg-savings-soft p-3 animate-slide-up">
            <div className="text-[12px]">
              <div className="font-bold text-soft">
                {cheapest.offer.verified
                  ? t("Cheapest confirmed price")
                  : t("Best price so far (unconfirmed)")}
              </div>
              <div className="font-extrabold text-strong">{cheapest.name}</div>
            </div>
            <div className="text-right">
              <div className="text-xl font-extrabold text-savings">
                {moneyLocal(cheapest.offer.pricePerDay, cheapest.offer.currency)}
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

        {/* Ultra: bargain in the shop's LOCAL language (optional toggle). */}
        {rfq && (
          <button
            onClick={() => {
              if (session?.plan !== "ultra") {
                setUpgradeOpen(true);
                return;
              }
              const next = !localLang;
              setLocalLang(next);
              try {
                localStorage.setItem("wd_local_lang", next ? "1" : "0");
              } catch {}
            }}
            className={`mt-3 flex w-full items-center justify-between rounded-2xl border-2 px-4 py-2.5 text-[13px] font-extrabold transition ${
              localLangActive
                ? "border-transparent bg-gradient-to-r from-brandblue via-[#7c5cff] to-brandred text-white shadow-lg"
                : "border-line bg-card text-soft"
            }`}
          >
            <span>🌐 {t("Bargain in the shop's local language")}</span>
            <span className="flex items-center gap-1">
              {session?.plan !== "ultra" && <span className="text-[10px]">✦ Ultra</span>}
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] ${
                  localLangActive ? "bg-white/25" : "bg-card2 text-faint"
                }`}
              >
                {localLangActive ? t("ON") : t("OFF")}
              </span>
            </span>
          </button>
        )}
        {localLangActive && (
          <p className="mt-1 text-[11px] font-bold text-brandblue">
            🌐 {t("Agents will haggle like a local - and you'll see the English translation of every message.")}
          </p>
        )}

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
                    .map((v) => ({
                      id: v.id,
                      name: v.name,
                      whatsapp: v.whatsapp,
                      placeId: v.placeId,
                      // Google "open now" - so an open shop is never queued as closed.
                      openNow: v.openNow,
                    }));
                  const res = await fetch("/api/outreach/mass", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      vendors: targets,
                      message: rfq.vendorMessage,
                      rfq,
                      region: origin.label,
                      localLang: localLangActive,
                    }),
                  });
                  const d = await res.json();
                  if (d.results) {
                    let alreadyAsked = 0;
                    for (const r of d.results) {
                      if (r.sent) {
                        patchVendor(r.id, {
                          stage: "awaiting-response",
                          sentText: r.text,
                          sentGloss: r.gloss,
                          lastEventAt: Date.now(),
                          queuedUntil: undefined,
                        });
                      } else if (r.queued) {
                        // Held for the shop's opening hours - show it on the card
                        // and in the user-facing queue (they can wait or remove).
                        patchVendor(r.id, {
                          queuedUntil: r.queuedUntil ?? new Date().toISOString(),
                          lastEventAt: Date.now(),
                        });
                      } else if (String(r.reason ?? "").startsWith("rfq-dedup")) {
                        // This shop already has an open conversation from the last
                        // 24h - the agent continues THAT thread instead of
                        // re-sending the same question (never look like a bot).
                        alreadyAsked += 1;
                        patchVendor(r.id, {
                          stage: "awaiting-response",
                          lastEventAt: Date.now(),
                        });
                      }
                    }
                    refreshQueue();
                    setMassNote(
                      d.sent > 0 || d.queued > 0 || alreadyAsked > 0
                        ? `${t("Agents are on it - shops asked:")} ${d.sent}${
                            d.queued > 0
                              ? ` · ${d.queued} ${t("queued for opening hours")}`
                              : ""
                          }${
                            alreadyAsked > 0
                              ? ` · ${alreadyAsked} ${t("already in conversation")}`
                              : ""
                          }`
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
              <Filters
                filters={filters}
                onChange={setFilters}
                availableClasses={availableClasses}
                isUltra={session?.plan === "ultra"}
                onUpgrade={() => setUpgradeOpen(true)}
              />
            </div>
          </>
        )}

        {view === "map" && vendors.length > 0 ? (
          <div className="relative z-0 mt-3">
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
          <div data-tour="vendors" className="mt-3 space-y-3 md:grid md:grid-cols-2 md:gap-3 md:space-y-0">
            {filtered.map((v, i) => (
              <div key={v.id} className="rise-in" style={{ ["--i" as string]: i }}>
                <VendorCard
                  vendor={v}
                  rfq={rfq}
                  plan={session?.plan}
                  waConnected={waConnected}
                  localLang={localLangActive}
                  region={origin.label}
                  searchEpoch={searchEpoch}
                  onBook={setBookingVendor}
                  onReviews={setReviewsVendor}
                  onBargain={setBargainVendor}
                  onStage={(id, stage) => patchVendor(id, { stage })}
                  onCustomMessage={customMessage}
                />
              </div>
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
            <div className="mx-auto mb-3 w-fit opacity-90 float-soft">
              <BrandMark size={72} />
            </div>
            <p className="mx-auto max-w-[280px] text-sm text-soft">
              {t("Tell us what you want to rent - car, scooter or motorbike - and where you're staying. The agents find every rental shop around you and bargain authentically for the best price.")}
            </p>
          </div>
        )}

        {/* Popular questions - owner-managed, expandable (#18) */}
        {phase === "idle" && <FaqSection />}
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
      {clearConfirm && (
        <Modal onClose={() => setClearConfirm(false)} center>
          <div className="text-center">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-brandred-soft text-2xl">
              🧹
            </div>
            <h2 className="text-lg font-extrabold text-strong">{t("Clear this search?")}</h2>
            <p className="mt-1 text-[13px] text-soft">
              {t("Your current shops and any offers will be removed. This can't be undone.")}
            </p>
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => setClearConfirm(false)}
                className="btn btn-ghost flex-1 rounded-2xl py-2.5 text-sm"
              >
                {t("Keep it")}
              </button>
              <button
                onClick={clearSearch}
                className="btn btn-danger flex-1 rounded-2xl py-2.5 text-sm"
              >
                {t("Clear search")}
              </button>
            </div>
          </div>
        </Modal>
      )}

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
  if (f.fastOnly) list = list.filter((v) => v.fastResponder);
  if (f.minRating > 0) list = list.filter((v) => v.rating >= f.minRating);
  if (f.maxPricePerDay)
    list = list.filter((v) => v.offer && v.offer.pricePerDay <= (f.maxPricePerDay as number));

  if (f.agentStatus === "negotiating")
    // "Negotiating now" = every shop the agent is actively working: message
    // sent, awaiting the reply, or mid-bargain.
    list = list.filter((v) =>
      ["rfq-sent", "awaiting-response", "negotiating"].includes(v.stage ?? "")
    );
  else if (f.agentStatus === "offer") list = list.filter((v) => v.offer);
  else if (f.agentStatus === "dropped")
    list = list.filter((v) => v.offer && v.offer.round > 0);

  const savingsOf = (v: Vendor) =>
    v.offer ? (v.offer.listPricePerDay - v.offer.pricePerDay) * days : -1;

  list.sort((a, b) => {
    // Paid placements always lead, whatever the sort.
    const sp = (b.sponsored ? 1 : 0) - (a.sponsored ? 1 : 0);
    if (sp !== 0) return sp;
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
