"use client";

import { useCallbackRef } from "@/components/useCallbackRef";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Vendor, StructuredRFQ, Session, TrackerStage, Offer, VehicleOption } from "@/lib/types";
import { offerForOption } from "@/lib/offer-options";
import { vehicleLabel } from "@/lib/labels";
import { Icon } from "@/components/icons";
import { Filters, DEFAULT_FILTERS, type FilterState } from "@/components/Filters";
import { VendorCard } from "@/components/VendorCard";
import { ShopAvatar, clearShopAvatars } from "@/components/ShopAvatar";
import { BookingSheet } from "@/components/BookingSheet";
import { AnimatedNumber } from "@/components/SavingsTicker";
import { TabBar } from "@/components/TabBar";
import { FeedbackModal } from "@/components/FeedbackModal";
import { GoogleWordmark } from "@/components/GoogleWordmark";
import { Modal } from "@/components/Modal";
import { BrandMark } from "@/components/BrandMark";
import { WillAvatar } from "@/components/will/WillAvatar";
import { OriginPicker, type Origin } from "@/components/OriginPicker";
import { RequestBuilder } from "@/components/RequestBuilder";
import { FaqSection } from "@/components/FaqSection";
import { SiteFooter } from "@/components/SiteFooter";
import { SearchSummaryBar } from "@/components/SearchSummaryBar";
import { can } from "@/lib/entitlements";
import { checkAction } from "@/lib/actions/registry";
import { sendProgress } from "@/lib/batch-progress";
import { formatClock } from "@/lib/clock";

// W2: honest queue ETA label. A due row never shows a past clock time - it
// shows the paced-slot copy; otherwise a "~10:20-10:25" envelope (collapsed to
// a single time when both ends land in the same minute).
function etaRangeLabel(
  from: string | undefined,
  to: string | undefined,
  due: boolean,
  notBefore: string,
  t: (s: string) => string
): string {
  if (due) return t("sending at the next safe slot - paced to protect your number");
  const start = from ?? (notBefore || undefined);
  if (!start) return "";
  const a = formatClock(start);
  const b = to ? formatClock(to) : a;
  return a === b ? `~${a}` : `~${a}-${b}`;
}
import { ActivityFeed, type FeedItem } from "@/components/activity/ActivityFeed";
import { WhyThisSheet } from "@/components/activity/WhyThisSheet";
import { TranscriptSheet } from "@/components/activity/TranscriptSheet";
import { ThreadDashboard } from "@/components/ThreadDashboard";
import { LocationShareSheet } from "@/components/LocationShareSheet";
import { WaSafetyBadge, type WaSafety } from "@/components/WaSafetyBadge";
import { useWill } from "@/lib/useWill";
import type { WillContext } from "@/lib/will-commands";
import { WillSheet } from "@/components/will/WillSheet";
import { WillGuideOverlay, type WillAction } from "@/components/will/WillGuideOverlay";
import { useWillAssistant } from "@/components/will/WillAssistantProvider";
import { deriveWillStep } from "@/lib/will-assistant";
import { CompareSheet } from "@/components/will/CompareSheet";
import { ReviewsSheet } from "@/components/ReviewsSheet";
import { UpgradeSheet } from "@/components/UpgradeSheet";
import { BargainDraftModal } from "@/components/BargainDraftModal";
import { Onboarding } from "@/components/Onboarding";
import { AdBanner } from "@/components/AdBanner";
import { LoadingDots } from "@/components/LoadingDots";
import { AgentKillSwitch } from "@/components/AgentKillSwitch";
import { AlertsChip } from "@/components/AlertsChip";
import { WaLockVeil } from "@/components/WaLockVeil";
import { probeWaStatus } from "@/lib/wa-status";
import { startNav } from "@/components/NavVeil";
import { WaitGame } from "@/components/WaitGame";
import { LanguageButton } from "@/components/LanguageButton";
import { useI18n } from "@/lib/i18n";
import { moneyLocal, currencySymbol } from "@/lib/currency";
import { cheapestPresentable } from "@/lib/offer-presentation";
import { digitsOnly } from "@/lib/phone";

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

export default function Home() {
  const { t } = useI18n();
  const [session, setSession] = useState<Session | null>(null);
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [originHint, setOriginHint] = useState<string | null>(null);
  const [radiusKm, setRadiusKm] = useState(8);
  const [examples, setExamples] = useState<string[]>(ALL_EXAMPLES.slice(0, 4));
  const [rawText, setRawText] = useState(ALL_EXAMPLES[0]);
  const [rfq, setRfq] = useState<StructuredRFQ | null>(null);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [source, setSource] = useState<"google" | "demo" | "google-error" | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "profiling" | "running" | "done">("idle");
  const [view, setView] = useState<"list" | "map" | "activity">("list");
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [bookingVendor, setBookingVendor] = useState<Vendor | null>(null);
  const [reviewsVendor, setReviewsVendor] = useState<Vendor | null>(null);
  const [bargainVendor, setBargainVendor] = useState<Vendor | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [onboarding, setOnboarding] = useState(false);
  // TRI-STATE: null = still checking (first paint), true = linked, false =
  // confirmed unlinked. Starting at null kills the "NOT CONNECTED / Pair
  // WhatsApp" flash that showed for a beat on every load before the status
  // call answered.
  const [waConnected, setWaConnected] = useState<boolean | null>(null);
  // Did the status read ever ACTUALLY answer? Distinct from `waConnected`,
  // because "we could not reach our own API" and "you are not linked" are
  // different facts and only the second one may draw the lock.
  const [waReachable, setWaReachable] = useState(true);
  const [massState, setMassState] = useState<"idle" | "running" | "done">("idle");
  const [massNote, setMassNote] = useState<string | null>(null);
  // The premium beta-quality note shown before a mass bargain runs.
  const [massInfoOpen, setMassInfoOpen] = useState(false);
  // Ultra option: let the agents bargain in the shop's LOCAL language. OFF by
  // default (optional), persisted, and gated - free/pro see the upgrade sheet.
  const [localLang, setLocalLang] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [restored, setRestored] = useState(false);
  // Progressive disclosure: once results are in, the big search card folds
  // into a one-row summary (the form stays mounted so tour anchors survive).
  const [formOpen, setFormOpen] = useState(true);
  const [builderOpen, setBuilderOpen] = useState(false);
  // Live structured selections from the tap builder. Non-null = STRUCTURED MODE:
  // the free-text box greys out and the ONE bottom "Find my deal" button runs
  // the structured search (input-mode disambiguation, owner directive).
  const [builderFields, setBuilderFields] = useState<Partial<StructuredRFQ> | null>(null);
  // IDP disclaimer (owner directive): search stays disabled until the traveller
  // declares they hold a valid International Driving Permit for the category.
  // Persisted so a returning user is not re-asked every visit.
  const [idpConsent, setIdpConsent] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem("wd_idp_consent") === "yes") setIdpConsent(true);
    } catch {
      /* private mode - the checkbox simply starts unchecked */
    }
  }, []);
  const structuredMode = builderOpen && Boolean(builderFields?.vehicleClass);
  // Card windowing: render the first batch and reveal more on demand - keeps
  // long result lists cheap on low-end phones.
  const [visibleCount, setVisibleCount] = useState(20);
  // Live status panel (expandable) + user-facing queued-message list (bug #1/#9).
  const [statusOpen, setStatusOpen] = useState(false);
  // AUTO-EXPAND once sending actually begins (issue 5.2): the live progress is
  // the whole point of the panel, and defaulting it closed meant the user
  // watched a static summary while messages were flying. Fires once per search
  // so a deliberate collapse is never fought.
  const autoOpenedRef = useRef(false);
  // Play-while-you-wait mini-game + closed-app reply alerts (Web Push).
  const [showGame, setShowGame] = useState(false);
  // Living workspace: the cross-shop activity feed + honest WA safety state,
  // all from ONE /api/activity poll (which also replaced the queue poll).
  const [activityItems, setActivityItems] = useState<FeedItem[]>([]);
  const [waHealth, setWaHealth] = useState<WaSafety | null>(null);
  const [whyByVendor, setWhyByVendor] = useState<Record<string, string>>({});
  const [whyDecision, setWhyDecision] = useState<string | null>(null);
  const [transcriptFor, setTranscriptFor] = useState<{ id: string; name: string } | null>(null);
  const [dashboardFor, setDashboardFor] = useState<Vendor | null>(null);
  // The shop asked where the traveller is - the sheet that lets them choose
  // what to answer. Nothing is shared until they pick.
  const [locationAskFor, setLocationAskFor] = useState<Vendor | null>(null);
  // Live-poll health. clockSkewRef corrects `since` against the SERVER clock
  // (the filter runs on server timestamps); feedStale surfaces a failing poll
  // instead of freezing the screen on a stale snapshot.
  const clockSkewRef = useRef(0);
  const [feedStale, setFeedStale] = useState(false);
  // Will - the conversational layer. Session pause + compare live here too.
  const [willOpen, setWillOpen] = useState(false);
  // W7: per-stage dismissal of the inline Will guide. Dismissing hides the
  // banner for THAT stage only (persisted for the session); a stage change
  // resurfaces it - it is guidance, not chrome. A small summon chip stays so
  // Will is always one tap away.
  const [dismissedStages, setDismissedStages] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("wd_will_dismissed");
      if (raw) setDismissedStages(new Set(JSON.parse(raw) as string[]));
    } catch {
      /* private mode - in-memory only */
    }
  }, []);
  const dismissWillStage = useCallbackRef((stage: string) => {
    setDismissedStages((prev) => {
      const next = new Set(prev).add(stage);
      try {
        sessionStorage.setItem("wd_will_dismissed", JSON.stringify([...next]));
      } catch {}
      return next;
    });
  });
  const [paused, setPaused] = useState(false);
  // The VERSION of `paused`. Pause state is cached per server instance, so a
  // poll answered by a different instance right after a resume carries the
  // pre-resume value - old, not wrong. The version is what lets the switch tell
  // the difference instead of flipping itself back (see lib/versioned).
  const [pausedVersion, setPausedVersion] = useState(0);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  // Poll cadence from the server (SCALE_MODE stretches these under load). Fast
  // by default so a shop's WhatsApp reply surfaces in the app within seconds
  // (owner: "it should be instant") - the focus/visibility wake forces an
  // immediate refresh on top of this.
  const [pollCfg, setPollCfg] = useState({ activityMs: 6000, repliesMs: 6000, tagsMs: 120000 });
  useEffect(() => {
    fetch("/api/config/public")
      .then((r) => r.json())
      .then((d) => {
        if (d.poll?.activityMs) setPollCfg(d.poll);
      })
      .catch(() => {});
  }, []);

  // Fold the search card away when the agents take over the screen; a phase
  // transition re-collapses it, a tap on the summary row re-opens it.
  useEffect(() => {
    if (phase === "running" || phase === "done") setFormOpen(false);
    if (phase === "profiling") setVisibleCount(20);
  }, [phase]);
  const formCollapsed = !formOpen && vendors.length > 0 && (phase === "running" || phase === "done");

  // A shop with a MENU hands the chosen tier along with the vendor. Apply it to
  // the offer before anything downstream reads a price: the booking sheet, the
  // server-side total and the bargain draft all take `offer.pricePerDay`
  // directly, so a tier carried alongside would book the wrong bike.
  function pickVendorOption(set: (v: Vendor) => void) {
    return (v: Vendor, option?: VehicleOption) => {
      if (!option || !v.offer) return set(v);
      set({ ...v, offer: offerForOption(v.offer, option, rfq?.durationDays ?? 1) });
    };
  }

  // Jump straight to a shop's card from the status panel: switch to the list,
  // highlight it, and smooth-scroll it into view. The list is WINDOWED
  // (visibleCount) - a card beyond the window has no DOM node, so the window
  // must grow past the target first or the tap silently does nothing.
  function scrollToVendor(id: string) {
    setView("list");
    setSelectedId(id);
    setVisibleCount((n) => {
      // Index into the ACTUALLY-RENDERED list (filtered + sorted), not raw
      // `vendors` (B9): the list renders `filtered.slice(0, visibleCount)`, so a
      // window grown to the raw-array index can fall short whenever a sort/
      // filter reorders the target - leaving no DOM node to scroll to.
      const idx = filtered.findIndex((v) => v.id === id);
      return idx >= 0 ? Math.max(n, idx + 5) : n;
    });
    // Two frames: let React commit the larger window before scrolling.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        document.getElementById(`vendor-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      })
    );
  }

  /**
   * Take the traveller TO a section, not to the top of the page.
   *
   * "See the full live activity feed →" used to switch the view and then call
   * `window.scrollTo({top: 0})`, which threw them back to the search box - the
   * feed they had just asked for was hundreds of pixels below. Everything that
   * moves between sections now goes through here: flip the view, wait for the
   * commit, and scroll the section itself into view under the sticky header.
   */
  function goToSection(selector: string, nextView?: "list" | "map" | "activity") {
    if (nextView) setView(nextView);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const el = document.querySelector(selector);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      })
    );
  }

  const [queueItems, setQueueItems] = useState<
    { id: number; vendorId: string | null; vendorName: string | null; toNumber: string; notBefore: string; due: boolean; reason: string; etaFrom?: string; etaTo?: string }[]
  >([]);
  // The plan's rolling introductions budget (Free ~10/6h, Pro ~15/4h, Ultra
  // ~40/3h), shown as a standing meter in the queued panel so the pacing limit
  // is always visible - not just a one-time toast.
  const [introBudget, setIntroBudget] = useState<{
    remaining: number;
    cap: number;
    windowHours: number;
    nextFreeAt: string;
  } | null>(null);
  // CLIENT TOMBSTONES for queue removals: keys ("id:<n>" / "v:<vendorId>")
  // mapped to the time they were tombstoned. Any poll that raced the server
  // delete still holds pre-delete rows - without this filter it would
  // resurrect the removed row + card badge for one poll cycle (the reported
  // remove-flicker). Entries expire after 30s (by then the server state is
  // authoritative either way) and are cleared early on fetch failure so the
  // row honestly reappears instead of silently vanishing.
  const pendingRemovals = useRef<Map<string, number>>(new Map());
  // Queue rows currently being removed (disables their Remove button).
  const [removingIds, setRemovingIds] = useState<Set<number>>(new Set());
  // Local going-rate hint (item #6): what the cheapest scooter / economy car
  // honestly costs per day around the chosen stay, in the LOCAL currency.
  const [priceHint, setPriceHint] = useState<{
    scooter: { floor: number; typical: number | null; currency: string } | null;
    car: { floor: number; typical: number | null; currency: string } | null;
  } | null>(null);
  const [priceHintLoading, setPriceHintLoading] = useState(false);
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
    setPriceHintLoading(true);
    fetch(`/api/market/hint?region=${encodeURIComponent(label)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        setPriceHint(d.scooter || d.car ? { scooter: d.scooter ?? null, car: d.car ?? null } : null);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setPriceHintLoading(false);
      });
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
          // Re-seed the applied-reply set - without this, every restore
          // re-applied all replies over the restored offers, inflating the
          // round count and (with out-of-order rows) reverting the price.
          if (Array.isArray(s.appliedReplyIds)) {
            for (const id of s.appliedReplyIds) appliedReplies.current.add(id);
          }
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
          JSON.stringify({
            vendors,
            rfq,
            source,
            sourceError,
            rawText,
            origin,
            radiusKm,
            filters,
            searchEpoch,
            appliedReplyIds: [...appliedReplies.current].slice(-200),
          })
        );
      } else {
        sessionStorage.removeItem("wd_search");
      }
    } catch {}
  }, [vendors, rfq, source, sourceError, rawText, origin, radiusKm, filters, restored, searchEpoch]);

  function clearSearch() {
    timers.current.forEach(clearTimeout);
    setVendors([]);
    setRfq(null);
    setSource(null);
    setSourceError(null);
    setPhase("idle");
    setClearConfirm(false);
    appliedReplies.current = new Set();
    // Shop avatars are ephemeral: a new search must never show the previous
    // session's shops (they belong to people who never signed up here).
    clearShopAvatars();
    setQueueItems([]);
    // Future replies belong to a NEW session - anything before now is dead.
    setSearchEpoch(Date.now());
    // HARD close on the server too: purge every queued message, tombstone the
    // recipients and stamp the session-closed marker so the agents stop
    // talking to the old shops. AWAITED with one retry - a silently failed
    // close would leave server-side sends alive, which is exactly the lie
    // the user asked us to kill. On double failure, say so honestly.
    void (async () => {
      const close = () =>
        fetch("/api/session/close", { method: "POST" }).then((r) => r.ok);
      let ok = await close().catch(() => false);
      if (!ok) {
        await new Promise((r) => setTimeout(r, 1500));
        ok = await close().catch(() => false);
      }
      if (!ok) {
        setMassNote(
          t("The search was cleared here, but the server could not confirm stopping pending messages - check the queue in a moment.")
        );
      }
    })();
    try {
      sessionStorage.removeItem("wd_search");
    } catch {}
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  useEffect(() => {
    // Middleware already gates unauthenticated visitors; here we just load the
    // session (with one retry - never cached). Track the retry timers and a
    // mounted flag so a late retry can't setState after unmount.
    let mounted = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const loadMe = async (attempt = 0) => {
      try {
        const r = await fetch("/api/auth/me", { cache: "no-store" });
        const d = await r.json();
        if (!mounted) return;
        if (d.session) setSession(d.session);
        else if (attempt < 2) retry = setTimeout(() => loadMe(attempt + 1), 700);
        else window.location.href = "/login";
      } catch {
        if (mounted && attempt < 2) retry = setTimeout(() => loadMe(attempt + 1), 700);
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
    // Deep link from Will's edge companion (?will=1): open his chat directly.
    if (params.get("will") === "1") {
      setWillOpen(true);
      window.history.replaceState({}, "", "/");
    }
    // Returning from PayPal Checkout.
    const plan = params.get("plan");
    if (params.get("billing") === "success" && plan) {
      fetch("/api/billing/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      }).then(() => window.history.replaceState({}, "", "/"));
    }

    return () => {
      mounted = false;
      if (retry) clearTimeout(retry);
      // Clear the CURRENT timers array, not a mount-time snapshot: runFunnel
      // replaces timers.current with a new array, so a captured `scheduled`
      // reference would clear nothing on unmount (audit: stale-ref timers).
      timers.current.forEach(clearTimeout);
    };
  }, []);

  // WHATSAPP GATE. Read through the shared probe (bounded, retried, never
  // cached) and re-read whenever the answer can have changed.
  //
  // The bug this replaces: a single un-retried fetch whose failure was recorded
  // as `false` - a CONFIRMED unlink. When the Evolution host was cold the status
  // call could take ~25s, the fetch never landed, and a traveller whose
  // WhatsApp was connected got "Link WhatsApp to unlock the search" over their
  // search form, with no way back short of a reload. A read we could not
  // complete is not evidence of anything, so it no longer draws the lock.
  const refreshWaStatus = useCallbackRef(async () => {
    if (!session) return;
    const s = await probeWaStatus();
    if (!s.reachable) {
      setWaReachable(false);
      return;
    }
    setWaReachable(true);
    setWaConnected(s.connected);
  });
  useEffect(() => {
    if (!session) return;
    void refreshWaStatus();
    // Linking happens on ANOTHER screen (Profile). Coming back here has to
    // re-ask, or the gate keeps showing a lock the traveller already cleared.
    const onWake = () => {
      if (!document.hidden) void refreshWaStatus();
    };
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
    return () => {
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
  }, [session, refreshWaStatus]);

  // EVERY traveller defaults to "My location": ask for GPS as soon as the page
  // is up (covered by the Terms of Use accepted at signup). The point is shown
  // instantly, then reverse-geocoded to a REAL named place so local currency +
  // language work (a bare "My location" has no country to read). A restored
  // search keeps its own origin; a manual pick made while GPS was still
  // resolving always wins.
  useEffect(() => {
    if (!restored) return;
    // Don't override a restored search's origin with the phone location.
    let hasSaved = false;
    try {
      hasSaved = Boolean(sessionStorage.getItem("wd_search"));
    } catch {}
    if (hasSaved) return;
    let cancelled = false;
    navigator.geolocation?.getCurrentPosition(
      async (pos) => {
        if (cancelled) return;
        const lat = pos.coords.latitude;
        const lng = pos.coords.longitude;
        setOrigin((prev) =>
          prev ? prev : { label: "My current location", lat, lng, myLocation: true }
        );
        setOriginHint(null);
        try {
          const d = await (await fetch(`/api/geocode?lat=${lat}&lng=${lng}`)).json();
          if (!cancelled && d?.place?.label) {
            setOrigin((prev) =>
              // Only refine the GPS origin - never clobber a manual pick.
              !prev || prev.myLocation
                ? { label: d.place.label, lat, lng, myLocation: true }
                : prev
            );
          }
        } catch {}
      },
      () => {
        /* Permission denied / unavailable: the picker's hint takes over. */
      }
    );
    return () => {
      cancelled = true;
    };
  }, [restored]);

  const patchVendor = useCallbackRef((id: string, patch: Partial<Vendor>) => {
    setVendors((vs) => vs.map((v) => (v.id === id ? { ...v, ...patch } : v)));
  });
  // Stable identity so the memoised VendorCard doesn't re-render on every
  // parent state change.
  const handleStage = useCallbackRef((id: string, stage: Vendor["stage"]) =>
    patchVendor(id, { stage })
  );
  // A send was parked in the outbox: stamp queuedUntil + the guard's REAL
  // reason NOW so strip and card agree instantly (the activity poll keeps it
  // fresh). Nothing was delivered, so the stage is deliberately untouched.
  const handleQueued = useCallbackRef(
    (id: string, queuedUntil?: string, queuedReason?: string) =>
      patchVendor(id, {
        queuedUntil: queuedUntil ?? new Date().toISOString(),
        queuedReason: queuedReason || undefined,
      })
  );
  const openWhy = useCallbackRef((decisionId: string) => setWhyDecision(decisionId));

  // ---- Will's bridge: natural language -> the EXISTING setters ------------
  // Will can only ever do what the visible controls can do; every command
  // lands on the same state the buttons use.
  // Latest-ref wrapper: the bridge memo must NEVER capture a stale
  // startSearch closure (it reads rawText/origin/radius at call time) -
  // "search now" through Will always runs the CURRENT request.
  const startSearchStable = useCallbackRef((text?: string) => startSearch(text));

  const willBridge = useMemo(
    () => ({
      getContext: (): WillContext => ({
        phase,
        radiusKm,
        vehicleClass: filters.vehicleClass,
        maxPricePerDay: filters.maxPricePerDay,
        vendors: vendors.slice(0, 12).map((v) => ({
          id: v.id,
          name: v.name,
          stage: v.stage,
          pricePerDay: v.offer?.pricePerDay,
          currency: v.offer?.currency,
          verified: v.offer?.verified,
        })),
        offersIn: vendors.filter((v) => v.offer).length,
        // Will treats "still checking" as not-yet-linked (boolean contract).
        waConnected: waConnected === true,
        plan: session?.plan ?? "free",
        originLabel: origin?.label,
        paused,
        notes: [],
      }),
      setRadius: (km: number) => setRadiusKm(km),
      patchFilters: (patch: Record<string, unknown>) =>
        setFilters((f) => ({ ...f, ...(patch as Partial<FilterState>) })),
      setBudget: (v: number | null) => setFilters((f) => ({ ...f, maxPricePerDay: v })),
      startSearch: (text?: string) => void startSearchStable(text),
      clearSearch: () => setClearConfirm(true), // always through the confirm dialog
      pause: async () => {
        setPaused(true);
        await fetch("/api/session/pause", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "pause" }),
        }).catch(() => {});
      },
      resume: async () => {
        setPaused(false);
        await fetch("/api/session/pause", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "resume" }),
        }).catch(() => {});
      },
      massBargain: () => runMassBargain(),
      // Will and the buttons now share ONE vocabulary of what this app can do.
      // A capability the traveller has and the assistant does not is a
      // capability that drifts - and one of the two ends up wrong.
      runAction: (id: string, args?: Record<string, unknown>, confirmed?: boolean) =>
        runAction(id, args ?? {}, Boolean(confirmed)),
      openVendor: (id: string) => scrollToVendor(id),
      compare: (ids: string[]) => setCompareIds(ids),
      openFeedback: () => setFeedbackOpen(true),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [phase, radiusKm, filters, vendors, waConnected, session, origin, paused]
  );
  const will = useWill(willBridge);
  const lastWillSay = will.messages.length
    ? [...will.messages].reverse().find((m) => m.role === "will")?.text
    : undefined;

  // Restore the pause flag from the server once per session (survives reloads).
  useEffect(() => {
    if (!session) return;
    fetch("/api/session/pause")
      .then((r) => r.json())
      .then((d) => setPaused(Boolean(d.paused)))
      .catch(() => {});
  }, [session]);

  // The traveller's own held-for-opening-hours queue (bug #9). They can see it
  // and remove any queued message; the matching card clears its queued badge.
  const refreshQueue = useCallbackRef(async () => {
    if (!session) return;
    try {
      // One consolidated poll: activity feed + queue + WA safety state.
      // cache:"no-store" + a changing cache-buster: the URL was byte-identical
      // on every poll, so the browser could serve the first (empty) response
      // forever - the "Nothing on the wire yet" freeze.
      // skewMs corrects the client clock against the server's: `since` filters
      // SERVER row timestamps, so a phone running minutes fast hid every row
      // written in that window.
      const res = await fetch(
        `/api/activity?since=${(searchEpoch || Date.now() - 86400000) + clockSkewRef.current}&t=${Date.now()}`,
        { cache: "no-store" }
      );
      if (!res.ok) throw new Error(`activity ${res.status}`);
      const d = await res.json();
      if (typeof d.now === "string") {
        const serverNow = Date.parse(d.now);
        if (Number.isFinite(serverNow)) clockSkewRef.current = serverNow - Date.now();
      }
      setFeedStale(false);
      // The kill switch and the queue rows now read the SAME poll: a session
      // paused after mount can no longer show "Agents active" over a queue of
      // "Paused by you" rows.
      if (typeof d.sessionPaused === "boolean") {
        // Move forward only: an older answer is dropped, never applied.
        const v = Number(d.sessionPausedVersion) || 0;
        setPausedVersion((prev) => {
          if (v && v <= prev) return prev;
          setPaused(d.sessionPaused);
          return v || prev;
        });
      }
      if (Array.isArray(d.items)) setActivityItems(d.items);
      if (d.waHealth) setWaHealth(d.waHealth);
      if (d.whyByVendor) setWhyByVendor(d.whyByVendor);
      // AUTHORITATIVE per-vendor conversation state (messaged / active / offer)
      // straight from the DB rollup - the single source of truth that keeps the
      // card status in lock-step with the Live Status panel, so a messaged shop
      // never stays stuck in the "queued message" visual (split-brain fix).
      const vendorStates: Record<string, "messaged" | "active" | "offer"> =
        d.vendorStates && typeof d.vendorStates === "object" ? d.vendorStates : {};
      const lastByVendor: Record<
        string,
        { lastInboundText?: string; lastInboundAt?: string }
      > = d.lastByVendor && typeof d.lastByVendor === "object" ? d.lastByVendor : {};
      // Forward-only stage ranking - the DB state can only ADVANCE a card, never
      // rewind it, and never overrides a terminal decline / no-contact.
      const STAGE_ORDER: Record<string, number> = {
        queued: 0,
        "locating-contact": 1,
        found: 2,
        "no-response": 2,
        // In flight: past "found", not yet delivered. Ranked so the DB rollup
        // can advance it once the send lands but can never rewind it to "found".
        sending: 2,
        "rfq-sent": 3,
        "awaiting-response": 4,
        negotiating: 5,
        "offer-received": 6,
        "counter-offer": 7,
      };
      const stageForState = (s: "messaged" | "active" | "offer") =>
        s === "offer" ? "offer-received" : s === "active" ? "negotiating" : "awaiting-response";
      // J: vendorIds where the agent has countered the shop's quote this session
      // (derived server-side from offer rounds / bargain-after-quote). Applied as
      // a FINAL stage relabel - after the offer/price is seeded - so the priced
      // offer still surfaces on the card while the stage reads "counter-offer".
      const counteredSet = new Set<string>(
        Array.isArray(d.countered) ? (d.countered as string[]) : []
      );
      const canAdvance = (cur: string | undefined, target: string) =>
        cur !== "declined" &&
        cur !== "no-contact" &&
        // A "no-response" card (we waited, nothing came) must not be rewound to
        // "awaiting-response" by the mere existence of its RFQ row - only a real
        // reply (active/offer) revives it.
        !(cur === "no-response" && target === "awaiting-response") &&
        (STAGE_ORDER[target] ?? -1) > (STAGE_ORDER[cur ?? "queued"] ?? -1);
      // J: relabel a card's stage to "counter-offer" once the agent has countered
      // this shop's quote - applied LAST (after offer seeding) at every return
      // site so the priced offer still shows; canAdvance keeps it off terminal
      // cards and makes it stick once reached (active haggling in progress).
      const finalizeStage = (b: Vendor): Vendor =>
        b.id && counteredSet.has(b.id) && canAdvance(b.stage, "counter-offer")
          ? { ...b, stage: "counter-offer" }
          : b;
      // Drop rows the user just removed (tombstoned) - a poll that read the
      // server BEFORE the delete committed must not resurrect them. Expired
      // tombstones (>30s) fall away so a genuinely failed delete resurfaces.
      const nowMs = Date.now();
      for (const [k, at] of pendingRemovals.current) {
        if (nowMs - at > 30_000) pendingRemovals.current.delete(k);
      }
      const tombstoned = (row: { id?: number; vendorId?: string | null }) =>
        pendingRemovals.current.has(`id:${row.id}`) ||
        (row.vendorId ? pendingRemovals.current.has(`v:${row.vendorId}`) : false);
      const rawItems: {
        id: number;
        vendorId: string | null;
        notBefore: string;
        /** The row is claimed by a drainer and being delivered right now. */
        sending?: boolean;
        rawReason?: string | null;
      }[] = Array.isArray(d.queue) ? d.queue : [];
      const items = rawItems.filter((i) => !tombstoned(i));
      // A poll whose payload no longer contains a tombstoned row confirms the
      // server delete landed - retire those tombstones.
      for (const k of [...pendingRemovals.current.keys()]) {
        if (k.startsWith("v:") && !rawItems.some((i) => `v:${i.vendorId}` === k)) {
          pendingRemovals.current.delete(k);
        }
      }
      // B4 client mitigation: collapse any duplicate rows for the same shop to
      // ONE entry (keep the earliest-due), so a legacy duplicate outbox row can
      // never render as two identical queue cards. The DB unique index is the
      // real guard; this keeps older sessions clean too.
      {
        const rows = (d.queue ?? []).filter(
          (i: { id: number; vendorId: string | null }) => !tombstoned(i)
        );
        const byVendor = new Map<string, (typeof rows)[number]>();
        const deduped: typeof rows = [];
        for (const r of rows) {
          const key = r.vendorId ? `v:${r.vendorId}` : `n:${r.toNumber}`;
          const prev = byVendor.get(key);
          if (!prev) {
            byVendor.set(key, r);
            deduped.push(r);
          } else if (new Date(r.notBefore).getTime() < new Date(prev.notBefore).getTime()) {
            // Replace the kept row with the earlier-due one, in place.
            const idx = deduped.indexOf(prev);
            if (idx >= 0) deduped[idx] = r;
            byVendor.set(key, r);
          }
        }
        setQueueItems(deduped);
      }
      setIntroBudget(d.introBudget ?? null);
      // Shops the user explicitly paused (removed queued messages) - the card
      // says so instead of pretending nothing happened.
      const cancelledDigits = new Set<string>(
        Array.isArray(d.cancelledNumbers) ? d.cancelledNumbers : []
      );
      // Reconcile the cards with the SERVER (single source of truth for the
      // queued badge, covering every send path): set badge + REAL reason for
      // shops with a held message; when the row leaves the outbox, decide
      // HONESTLY what happened using delivery evidence from the same payload:
      //   sent event exists  -> the message left: the shop is now contacted
      //   no sent evidence   -> it was removed: the shop goes back to "found"
      //                         (never a phantom "messaged")
      const byVendor = new Map<
        string,
        { until: string; reason?: string | null; sending?: boolean }
      >();
      for (const i of items)
        if (i.vendorId)
          byVendor.set(i.vendorId, {
            until: i.notBefore,
            reason: i.rawReason,
            sending: Boolean(i.sending),
          });
      const sentVendors = new Set<string>(
        (Array.isArray(d.items) ? d.items : [])
          .filter((it: { kind?: string; vendorId?: string }) => it.kind === "sent" && it.vendorId)
          .map((it: { vendorId: string }) => it.vendorId)
      );
      // OFFERS from the fast activity feed: /api/activity already returns priced
      // offers (kind:"offer"), but only the slower 15-30s replies poll was
      // setting v.offer - so OFFERS IN sat at 0 for minutes even after a shop
      // quoted a price. Seed a minimal offer here so the counter + deals view
      // advance on the 6-12s activity cadence; the richer replies poll enriches
      // it (deposit/delivery/etc.) later. Items are newest-first, so the first
      // per vendor is the latest.
      const offerByVendor = new Map<
        string,
        { pricePerDay: number; currency: string; round: number; verified: boolean }
      >();
      for (const it of (Array.isArray(d.items) ? d.items : []) as {
        kind?: string;
        vendorId?: string;
        meta?: { pricePerDay?: number; currency?: string; round?: number; verified?: boolean };
      }[]) {
        if (
          it.kind === "offer" &&
          it.vendorId &&
          it.meta &&
          typeof it.meta.pricePerDay === "number" &&
          !offerByVendor.has(it.vendorId)
        ) {
          offerByVendor.set(it.vendorId, {
            pricePerDay: it.meta.pricePerDay,
            currency: String(it.meta.currency ?? "USD"),
            round: Number(it.meta.round ?? 0),
            verified: Boolean(it.meta.verified),
          });
        }
      }
      setVendors((vs) =>
        vs.map((v) => {
          if (!v.id) return v;
          // "Paused by you" flag - independent of the queue badge; shown when
          // the user removed messages for this shop and has not re-engaged.
          const digits = digitsOnly(v.whatsapp);
          const isCancelled = Boolean(digits && cancelledDigits.has(digits));
          let base = v.cancelled === isCancelled ? v : { ...v, cancelled: isCancelled };
          // Mirror the authoritative DB state onto the card's stage (forward
          // only) so a messaged / actively-negotiating shop shows the right
          // status regardless of soft filters or feed truncation.
          const dbState = vendorStates[base.id];
          if (dbState) {
            const target = stageForState(dbState);
            if (canAdvance(base.stage, target)) base = { ...base, stage: target };
          }
          // THE SHOP'S OWN LAST WORDS. /api/activity has always returned this
          // and nothing consumed it, which is why the panel could file a shop
          // that had already answered under "Awaiting reply".
          const last = lastByVendor[base.id];
          if (last?.lastInboundAt && last.lastInboundAt !== base.lastInboundAt) {
            base = {
              ...base,
              lastInboundText: last.lastInboundText,
              lastInboundAt: last.lastInboundAt,
            };
          }
          // Seed the offer from the activity feed so OFFERS IN advances fast
          // (only when the card has no richer offer yet - never overwrite the
          // detailed one the replies poll builds).
          if (!base.offer) {
            const o = offerByVendor.get(base.id);
            // Never rewind a terminal card (declined / no-contact) into a
            // bookable deal, and mark the seed not-yet-presentable so the card
            // still shows "confirming deposit + how you get it" until the richer
            // replies poll fills those in (no premature "Lock this deal").
            if (o && canAdvance(base.stage, "offer-received")) {
              base = {
                ...base,
                stage: "offer-received",
                offer: {
                  pricePerDay: o.pricePerDay,
                  listPricePerDay: o.pricePerDay,
                  currency: o.currency,
                  totalPrice: o.pricePerDay * (rfq?.durationDays ?? 1),
                  includesInsurance: false,
                  includesDelivery: false,
                  message: "",
                  round: o.round,
                  verified: o.verified,
                  simulated: false,
                  presentable: false,
                },
              };
            }
          }
          // B8: a re-quote on an ALREADY-priced shop must also land on the fast
          // activity cadence, not wait for the slower replies poll. When the
          // feed carries a newer round (or a changed price) for a card that
          // already has an offer, update just the price fields - preserving the
          // richer deposit/delivery/presentable data the replies poll built.
          if (base.offer) {
            const o = offerByVendor.get(base.id);
            if (
              o &&
              (o.round > (base.offer.round ?? 0) || o.pricePerDay !== base.offer.pricePerDay)
            ) {
              base = {
                ...base,
                offer: {
                  ...base.offer,
                  pricePerDay: o.pricePerDay,
                  currency: o.currency,
                  totalPrice: o.pricePerDay * (rfq?.durationDays ?? 1),
                  round: Math.max(o.round, base.offer.round ?? 0),
                  verified: o.verified || base.offer.verified,
                },
              };
            }
            return finalizeStage(base); // an offer supersedes any queue badge
          }
          const held = byVendor.get(base.id);
          if (held) {
            // A message being DELIVERED right now is its own stage. It used to
            // be no state at all - the row was deleted to claim it and the sent
            // row did not exist yet - so the card fell to "found" and dropped
            // out of every status bucket mid-send.
            const stage: Vendor["stage"] =
              held.sending && (base.stage === "found" || base.stage === "rfq-sent" || !base.stage)
                ? "sending"
                : !held.sending && base.stage === "sending"
                  ? "rfq-sent"
                  : base.stage;
            if (
              base.queuedUntil !== held.until ||
              base.queuedReason !== (held.reason ?? undefined) ||
              stage !== base.stage
            ) {
              return finalizeStage({
                ...base,
                stage,
                queuedUntil: held.until,
                queuedReason: held.reason ?? undefined,
              });
            }
          }
          if (!held && base.queuedUntil) {
            const delivered = sentVendors.has(base.id);
            return finalizeStage({
              ...base,
              queuedUntil: undefined,
              queuedReason: undefined,
              stage: delivered
                ? base.stage === "found" || base.stage === "rfq-sent"
                  ? "awaiting-response"
                  : base.stage
                : base.stage === "rfq-sent"
                  ? "found"
                  : base.stage,
            });
          }
          return finalizeStage(base);
        })
      );
    } catch {
      // NEVER silently freeze. The old blanket catch kept the last snapshot with
      // zero indication, so a failing poll was indistinguishable from a stalled
      // agent - the UI simply stopped updating and nobody could tell why.
      setFeedStale(true);
    }
  });

  async function removeQueued(id: number, vendorId: string | null, toNumber?: string) {
    // TOMBSTONE FIRST: every poll from now on drops this row/badge, so an
    // interleaved poll that read pre-delete server state cannot resurrect it
    // (the remove-flicker). Optimistic clear follows.
    const nowMs = Date.now();
    pendingRemovals.current.set(`id:${id}`, nowMs);
    if (vendorId) pendingRemovals.current.set(`v:${vendorId}`, nowMs);
    setRemovingIds((s) => new Set(s).add(id));
    setQueueItems((items) => items.filter((i) => i.id !== id && (!vendorId || i.vendorId !== vendorId)));
    if (vendorId) {
      setVendors((vs) =>
        vs.map((v) =>
          v.id === vendorId
            ? {
                ...v,
                queuedUntil: undefined,
                queuedReason: undefined,
                cancelled: true,
                lastEventAt: Date.now(),
                stage: v.stage === "rfq-sent" ? "found" : v.stage,
              }
            : v
        )
      );
    }
    try {
      // SERVER-AUTHORITATIVE + ID-CHURN PROOF: the drain loop re-queues held
      // rows under new ids, so the server sweeps EVERY pending row for this
      // shop (not just the tapped id). "sent" comes back only with real
      // delivery evidence - never inferred from a lost id race.
      const res = await fetch("/api/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // toNumber lets the server tombstone the recipient even when every
        // outbox row already drained - "remove" must survive wakeups too.
        body: JSON.stringify({ action: "delete", id, vendorId, toNumber }),
      });
      if (!res.ok) throw new Error(`queue delete ${res.status}`);
      const d = await res.json().catch(() => ({ removed: true }));
      if (d.ok === false && d.error) {
        // The server removed rows but could NOT confirm permanence - say so
        // honestly instead of a silent success.
        setMassNote(t(String(d.error)));
      }
      if (d.sent === true) {
        setMassNote(t("Too late to remove that one - it had already left for the shop."));
        if (vendorId) patchVendor(vendorId, { stage: "awaiting-response", lastEventAt: Date.now() });
      }
    } catch {
      // OFFLINE/FAILURE HONESTY: nothing changed on the server - drop the
      // tombstones so the row honestly reappears, and tell the user.
      pendingRemovals.current.delete(`id:${id}`);
      if (vendorId) pendingRemovals.current.delete(`v:${vendorId}`);
      setMassNote(t("Couldn't reach the server - nothing was removed. Try again."));
    } finally {
      setRemovingIds((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
      refreshQueue();
    }
  }

  useEffect(() => {
    if (autoOpenedRef.current) return;
    const sending =
      queueItems.length > 0 ||
      vendors.some(
        (v) => v.queuedUntil || v.stage === "rfq-sent" || v.stage === "awaiting-response"
      );
    if (sending) {
      autoOpenedRef.current = true;
      setStatusOpen(true);
    }
  }, [queueItems.length, vendors]);

  // REALTIME FEEL: the moment the app regains focus/visibility (user flips
  // back from WhatsApp), bump this nonce - both pollers below depend on it,
  // so they re-run their tick IMMEDIATELY instead of waiting a full interval.
  const [syncNonce, setSyncNonce] = useState(0);
  useEffect(() => {
    const wake = () => {
      if (!document.hidden) setSyncNonce((n) => n + 1);
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    // B8 stage 1: the service worker postMessages the open tab the instant a
    // push arrives (or a notification is tapped) - wake the polls immediately
    // instead of waiting out the 6-15s interval that caused "push says a price,
    // card still says waiting".
    const onSwMessage = (e: MessageEvent) => {
      if (e.data?.type === "wd-refresh") setSyncNonce((n) => n + 1);
    };
    navigator.serviceWorker?.addEventListener?.("message", onSwMessage);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
      navigator.serviceWorker?.removeEventListener?.("message", onSwMessage);
    };
  }, []);

  // Alerts (browser push) are owned end-to-end by AlertsChip / usePushAlerts,
  // whose truth is the push_subscriptions row on the server. This page used to
  // carry a second, parallel implementation seeded from localStorage - which is
  // how the funnel could show "Alerts on" as a dead label while Profile's real
  // toggle disagreed, with no way to turn them off from here at all.

  // Poll the consolidated activity endpoint while there are vendors on
  // screen (cheap, user-scoped). Pauses in hidden tabs - no wasted requests.
  useEffect(() => {
    if (!session || vendors.length === 0) return;
    const tick = () => {
      if (document.hidden) return;
      refreshQueue();
    };
    tick();
    const id = setInterval(tick, pollCfg.activityMs);
    return () => clearInterval(id);
  }, [session, vendors.length, refreshQueue, pollCfg.activityMs, syncNonce]);

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
    const id = setInterval(load, pollCfg.tagsMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [session, vendorIdsKey, pollCfg.tagsMs]);

  // Live loop: while agents are in ANY active conversation, poll the reply
  // feed so shop answers pop into the cards automatically. This must include
  // offer-received/negotiating - after a bargain is sent the shop's counter
  // must still arrive without a manual refresh.
  // Poll while anything is genuinely in flight. A COMPLETE presented offer is
  // settled - polling it forever burns battery and quota for nothing (the
  // activity poll + focus-resync still catch a late surprise reply).
  const waiting =
    vendors.some(
      (v) =>
        ["sending", "rfq-sent", "awaiting-response", "negotiating"].includes(v.stage ?? "") ||
        (v.stage === "offer-received" && v.offer && v.offer.presentable !== true)
    ) ||
    // Keep the reply loop (which also drives inbound recovery + the outbox drain)
    // alive while ANY message is still queued. Otherwise, once every card settled
    // to a presentable offer the poll stopped - and the agent's parked
    // counter-reply never drained and late shop replies never surfaced (the
    // "agents never message back / app never updates" reports).
    queueItems.length > 0 ||
    // BUG 2: during the ACTIVE dispatch window (openers going out / just sent),
    // always poll so a shop's first offer lands in the card within seconds even
    // if the vendor's client-side stage has not caught up yet. Bounded: `running`
    // is the dispatch phase and resets on a new search / idle.
    phase === "running";
  useEffect(() => {
    if (!session || !waiting || !rfq) return;
    // Stale-run guard: an unmounted/reconfigured effect must never apply its
    // in-flight response to fresh state (the epoch may have changed).
    let cancelled = false;
    const tick = async () => {
      // Pause in a hidden tab (parity with the activity poll) - no wasted
      // /api/replies requests while backgrounded; resumes on focus.
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        // Scope to THIS session both server-side (since=) and client-side, so a
        // previous search's replies can never render on the new results.
        // The declared spec travels with the poll so the shop's menu is scoped
        // to the vehicle they actually asked for (and hold a licence for).
        const spec = new URLSearchParams({ since: String(searchEpoch), t: String(Date.now()) });
        if (rfq?.engineSizeCc) spec.set("cc", String(rfq.engineSizeCc));
        if (rfq?.vehicleClass) spec.set("vclass", rfq.vehicleClass);
        if (rfq?.transmission && rfq.transmission !== "any") spec.set("tx", rfq.transmission);
        const res = await fetch(`/api/replies?${spec.toString()}`, {
          cache: "no-store",
        });
        const d = await res.json();
        if (cancelled) return;
        // Shops that walked away: the card says so honestly - it never keeps
        // pretending the agent is "still confirming" a dead conversation.
        const declinedIds = new Set<string>(
          (d.replies ?? []).filter((r: { declined?: boolean }) => r.declined).map((r: { vendorId: string }) => r.vendorId)
        );
        if (declinedIds.size > 0) {
          setVendors((vs) =>
            vs.map((v) =>
              declinedIds.has(v.id) && v.stage !== "declined" ? { ...v, stage: "declined" } : v
            )
          );
        }
        // NEWEST ROW PER VENDOR WINS. The feed arrives newest-first; applying
        // every row would make the OLDEST functional update win (React applies
        // them in order), silently reverting a fresher negotiated price to an
        // older, higher one and inflating the round counter.
        const newestByVendor = new Map<string, (typeof d.replies)[number]>();
        for (const r of d.replies ?? []) {
          if (!r.found || !r.pricePerDay) continue;
          if (searchEpoch && r.createdAt && Date.parse(r.createdAt) < searchEpoch) continue;
          const cur = newestByVendor.get(r.vendorId);
          if (!cur || Date.parse(r.createdAt) > Date.parse(cur.createdAt)) {
            newestByVendor.set(r.vendorId, r);
          }
        }
        for (const r of newestByVendor.values()) {
          if (appliedReplies.current.has(r.id)) continue;
          appliedReplies.current.add(r.id);
          setVendors((vs) =>
            vs.map((v) =>
              v.id === r.vendorId
                ? {
                    ...v,
                    stage: declinedIds.has(r.vendorId)
                      ? ("declined" as TrackerStage)
                      : ("offer-received" as TrackerStage),
                    offer: {
                      pricePerDay: r.pricePerDay,
                      listPricePerDay: v.offer?.listPricePerDay ?? r.pricePerDay,
                      // The shop's OWN currency from the reply (server-derived);
                      // never a silent USD default.
                      currency: r.currency ?? v.offer?.currency ?? "USD",
                      totalPrice: Math.round(r.pricePerDay * rfq.durationDays),
                      // Now wired from the shop's confirmed reply (was always
                      // false, so an "insurance included" quote never showed).
                      includesInsurance:
                        r.insuranceIncluded === true || v.offer?.includesInsurance === true,
                      includesDelivery: r.delivers === true || v.offer?.includesDelivery === true,
                      deliveryFee: r.deliveryFee ?? v.offer?.deliveryFee,
                      message: r.replyText?.slice(0, 200) ?? "",
                      round: v.offer ? v.offer.round + 1 : 0,
                      verified: Boolean(r.verified),
                      // false = the shop quoted a DIFFERENT vehicle; the card
                      // flags it and it is excluded from the best-price picker.
                      // undefined (legacy) is treated as matching.
                      matchesSpec: r.matchesSpec ?? true,
                      // The vehicle-identity gate. Only "confirmed" may ever be
                      // presented as a deal (see offer-presentation).
                      vehicleStatus: r.vehicleStatus ?? undefined,
                      vehicleNote: r.vehicleNote ?? undefined,
                      simulated: false,
                      deposit: r.deposit ?? v.offer?.deposit,
                      depositType: r.depositType ?? v.offer?.depositType,
                      depositAmount: r.depositAmount ?? v.offer?.depositAmount,
                      depositCurrency: r.depositCurrency ?? v.offer?.depositCurrency,
                      // Digraph engine: how the traveller gets the vehicle, deal
                      // completeness gating, and pickup-consent status.
                      fulfillment: r.fulfillment ?? v.offer?.fulfillment ?? undefined,
                      presentable: r.presentable ?? v.offer?.presentable,
                      pickupOffered:
                        r.pickupOffered === true || v.offer?.pickupOffered === true || undefined,
                      pickupConsent:
                        r.pickupConsent === true || v.offer?.pickupConsent === true || undefined,
                      // The shop's price MENU when it offered a choice. Kept on
                      // the vendor object because VendorCard is memo'd - a
                      // sibling prop would not re-render the card.
                      options: r.options ?? v.offer?.options,
                      // Their own question, so the card can say why they want
                      // it. Cleared the moment we have shared something.
                      askedLocationQuote:
                        r.pickupConsent === true || v.offer?.pickupConsent === true
                          ? undefined
                          : r.askedLocationQuote ?? v.offer?.askedLocationQuote,
                    },
                  }
                : v
            )
          );
        }
      } catch {}
    };
    tick();
    const id = setInterval(tick, pollCfg.repliesMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [session, waiting, rfq, searchEpoch, pollCfg.repliesMs, syncNonce]);

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
      // HONESTY: "Locating" is a brief transition, never a resting state - a
      // card must not claim ongoing work that isn't happening. The real number
      // resolution runs inside /api/outreach when the user (or Will) asks.
      // Only advance locating -> found; never stomp a stage that moved on.
      schedule(() => {
        setVendors((vs) =>
          vs.map((v) =>
            v.id === vendor.id && v.stage === "locating-contact" ? { ...v, stage: "found" } : v
          )
        );
      }, base + 1500);
    });
    schedule(() => setPhase("done"), list.length * 200 + 1400);
  }

  async function startSearch(overrideText?: string, structuredFields?: Partial<StructuredRFQ>) {
    // Will can hand in fresh request text ("find me a 125cc scooter...") -
    // it becomes the visible textarea value AND this search's request.
    const ov = typeof overrideText === "string" ? overrideText.trim() : "";
    if (ov) setRawText(ov);
    // HEADER RESET (structured mode): a tap-built search must never leave the
    // previous free-text query visible anywhere - the structured chips are the
    // only description of the active session.
    if (structuredFields) setRawText("");
    const requestText = ov || rawText;
    // The tap-to-build panel (F2) supplies fully-structured fields instead of
    // free text - no requestText needed in that path.
    if (!structuredFields && !requestText.trim()) return;
    // PAIRING GATE, enforced not just painted. The blur-lock makes the form
    // inert, but Will can call startSearch directly - and a search whose agents
    // can never message anyone is a dead end. Only block on a CONFIRMED unlink
    // (false), never while the status read is still pending (null).
    if (waConnected === false) {
      setMassNote(
        t("Link your WhatsApp first - your agents bargain from your own number.")
      );
      document
        .querySelector("[data-tour='request']")
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    // No coordinates, no search - there is no silent default city anymore.
    if (!origin || !Number.isFinite(origin.lat) || !Number.isFinite(origin.lng)) {
      setOriginHint("Set your location first - allow GPS or type your hotel / area.");
      document
        .querySelector("[data-tour='stay']")
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    setOriginHint(null);
    // A search starting is the celebration's natural end.
    clearJustLinked();
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
    // Shop avatars are ephemeral: a new search must never show the previous
    // session's shops (they belong to people who never signed up here).
    clearShopAvatars();
    setQueueItems([]);
    // Close the PREVIOUS session on the server first: purge its queued
    // messages, delete its wakeups and silence its shop threads BEFORE any new
    // RFQ goes out. AWAITED with one retry (mirrors clearSearch): a silently
    // failed close used to leave the old session's sends + wakeups alive, so
    // the old shops kept getting messaged while the new hunt ran - exactly the
    // "agents talk after a new search" bug. On double failure we still proceed
    // (the new epoch scopes the UI) but warn honestly.
    {
      const close = () =>
        fetch("/api/session/close", { method: "POST" }).then((r) => r.ok);
      let closed = await close().catch(() => false);
      if (!closed) {
        await new Promise((r) => setTimeout(r, 1200));
        closed = await close().catch(() => false);
      }
      if (!closed) {
        setMassNote(
          t("Starting a fresh search - but the server could not confirm stopping the previous session's messages. Check the queue in a moment.")
        );
      }
    }

    const pRes = await fetch("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        structuredFields
          ? { structured: true, fields: structuredFields }
          : { text: requestText }
      ),
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
        // Snapshot-forward: hand the full RFQ so the search row can store it and
        // this hunt is restorable later from Trips (issue 8).
        rfq: pData.rfq,
      }),
    });
    if (!vRes.ok) {
      // A failed discovery call must NEVER masquerade as "no shops found
      // near your stay" - that sends users widening the radius for nothing.
      const err = await vRes.json().catch(() => ({}));
      setPhase("idle");
      setSourceError(
        err.error ?? t("The shop search hiccuped - tap Find my deal to try again.")
      );
      return;
    }
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

  // Pickup consent: the traveller approved sharing their EXACT location with a
  // shop that offered to pick them up. Prefer a fresh precise GPS fix; fall back
  // to the search origin's coordinates. The location is sent ONLY from here.
  // MODULE 5: the tap only AUTHORIZES the share - no client coordinates are
  // ever posted (the old getCurrentPosition/stale-origin fallback leaked a
  // previous trip's GPS to a shop). The server composes from the VERIFIED stay
  // (typed address; precise pin only with the default-OFF toggle). reason
  // "no-stay" means the user must configure their stay first - the caller
  // opens the location settings.
  // `sharePlace` is an optional ONE-OFF place NAME the traveller picked instead
  // of their saved stay (they are on the way, not at the hotel yet). It is a
  // name, never coordinates, and the server re-resolves it against Google
  // before anything reaches a shop.
  const pickupConsent = useCallbackRef(async (
    vendor: Vendor,
    sharePlace?: string
  ): Promise<{ ok: boolean; reason?: string }> => {
    try {
      const res = await fetch("/api/negotiate/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: vendor.whatsapp || undefined,
          placeId: vendor.placeId,
          shareQuery: sharePlace || undefined,
        }),
      });
      const d = await res.json();
      if (d.ok)
        patchVendor(vendor.id, {
          offer: { ...vendor.offer!, pickupConsent: true, askedLocationQuote: undefined },
        });
      return { ok: Boolean(d.ok), reason: d.reason };
    } catch {
      return { ok: false, reason: "network" };
    }
  });

  const customMessage = useCallbackRef(async (vendorId: string, message: string) => {
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
        region: origin?.label || undefined,
        openNow: vendor?.openNow,
      }),
    });
    return res.json();
  });

  // THE ACTION REGISTRY, MOUNTED (lib/actions/registry).
  //
  // Will's "Push harder" used to resolve to `setWillOpen(true)` - it opened a
  // panel. That was not a prompt problem: the bridge he had exposed view-state
  // setters only, so the only thing an assistant could do was move the
  // traveller's eyes, and every offer to help ended in the traveller doing the
  // work. These executors give the registry's named actions real bodies, and
  // every outbound one goes through `customMessage` - the same /api/outreach
  // path, the same guard, the same anti-ban pacing and cancellation vetoes an
  // agent message passes. Nothing an assistant does gets a shortcut around it.
  const runAction = useCallbackRef(
    async (id: string, rawArgs?: Record<string, unknown>, wasConfirmed?: boolean) => {
      const args = rawArgs ?? {};
      const check = checkAction({
        id,
        args,
        plan: session?.plan,
        confirmed: wasConfirmed === true,
        can: (p, f) => can(p as never, f),
      });
      if (!check.ok) {
        if (check.reason === "not-entitled") setUpgradeOpen(true);
        return check;
      }
      const vendorId = String(args.vendorId ?? "");
      const vendor = vendors.find((v) => v.id === vendorId);
      const vehicle =
        rfq?.vehicleClass === "car"
          ? "car"
          : rfq?.vehicleClass === "motorbike"
            ? "motorbike"
            : "scooter";
      switch (check.spec.id) {
        case "push-harder":
          return await customMessage(
            vendorId,
            `Hi again! Any chance of a better daily rate for the ${vehicle}? Ready to book if the price works 🙏`
          );
        case "ask-deposit":
          return await customMessage(vendorId, `One more thing - what deposit do you need?`);
        case "request-photo":
          return await customMessage(
            vendorId,
            `Could you send a photo of the actual ${vehicle} please?`
          );
        case "counter-at":
          return await customMessage(
            vendorId,
            `Could you do ${Number(args.pricePerDay)} per day? I can book right away 🙏`
          );
        case "mass-bargain":
          await runMassBargain();
          return { ok: true };
        case "compare":
          setCompareIds((args.vendorIds as string[]) ?? []);
          return { ok: true };
        case "filter-rents-cars":
          setFilters((f) => ({ ...f, tag: "rents-cars" }));
          return { ok: true };
        default:
          // `vendor` is read above so an unknown id cannot silently no-op with
          // a stale reference; every real branch returns before here.
          return { ok: false as const, reason: "unknown-action" as const, vendor: vendor?.id };
      }
    }
  );

  // Mass bargain: named + stable so the button AND (later) Will's command
  // bridge share the exact same path. Entitlement-gated through can().
  const runMassBargain = useCallbackRef(async () => {
    if (!rfq) return;
    if (!can(session?.plan, "mass-bargain")) {
      setUpgradeOpen(true);
      return;
    }
    setMassState("running");
    setMassNote(null);
    try {
      const targets = filtered
        .filter(
          (v) =>
            !v.offer &&
            v.stage !== "rfq-sent" &&
            v.stage !== "awaiting-response" &&
            v.stage !== "no-contact"
        )
        .slice(0, 10)
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
          region: origin?.label ?? "",
          localLang: localLangActive,
        }),
      });
      const d = await res.json();
      if (d.capReached) {
        setMassNote(
          t("This hunt already reached its 10-shop beta limit - replies from the contacted shops keep flowing in.")
        );
        return;
      }
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
            // Held by the guard (shop closed / pacing / limit) - show the
            // REAL reason on the card and in the user-facing queue.
            patchVendor(r.id, {
              queuedUntil: r.queuedUntil ?? new Date().toISOString(),
              queuedReason: r.queuedReason || undefined,
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
          } else if (r.reason === "no-phone") {
            // Honest terminal state - this shop cannot be messaged at all,
            // so it must never look contacted anywhere.
            patchVendor(r.id, { stage: "no-contact", lastEventAt: Date.now() });
          }
        }
        refreshQueue();
        const startingNow = (d.sent ?? 0) + Math.max(0, (d.queued ?? 0) - (d.deferredTomorrow ?? 0));
        // Rolling-window capacity: deferred shops begin automatically as slots
        // free (at most windowHours away), never "tomorrow". Show the honest
        // next-refresh countdown from nextFreeAt.
        const nextFreeMs = d.introBudget?.nextFreeAt ? Date.parse(d.introBudget.nextFreeAt) : 0;
        const refreshMin = nextFreeMs ? Math.max(1, Math.round((nextFreeMs - Date.now()) / 60_000)) : 0;
        const refreshText =
          refreshMin >= 90 ? `~${Math.round(refreshMin / 60)} h` : `~${refreshMin} min`;
        setMassNote(
          d.deferredTomorrow > 0
            ? `${t("Starting now:")} ${startingNow} ${t("shops, one at a time.")} ${d.deferredTomorrow} ${t(
                "more begin automatically as capacity refreshes"
              )}${refreshMin ? ` (${t("next slot in")} ${refreshText})` : ""}.`
            : d.sent > 0 || d.queued > 0 || alreadyAsked > 0
              ? `${t("Agents are on it - shops asked:")} ${d.sent}${
                  d.queued > 0 ? ` · ${d.queued} ${t("in line, sending one at a time")}` : ""
                }${
                  alreadyAsked > 0 ? ` · ${alreadyAsked} ${t("already in conversation")}` : ""
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
  });

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
  // How many shops have CONFIRMED each verified term. Drives the disabled state
  // of the "✓ Verified" chips: a term nobody has stated is not something the
  // traveller can filter on, and offering it anyway made the list look randomly
  // reshuffled (the tag predicate is OR'd with "is this shop live?", so it
  // could never remove an active shop and the tap appeared to do nothing).
  const tagCounts = useMemo(() => {
    const out: Partial<Record<FilterState["tag"], number>> = {};
    for (const v of vendors) {
      for (const tag of v.verifiedTags ?? []) {
        const key = tag as FilterState["tag"];
        out[key] = (out[key] ?? 0) + 1;
      }
    }
    return out;
  }, [vendors]);
  // CURRENCY SAFETY: offers can legitimately arrive in different currencies
  // (one shop quotes USD, another THB). Raw numbers must never be compared or
  // summed across currencies - all aggregates work within the DOMINANT one.
  const dominantCurrency = useMemo(() => {
    const counts = new Map<string, number>();
    for (const v of vendors) {
      if (v.offer) counts.set(v.offer.currency, (counts.get(v.offer.currency) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  }, [vendors]);
  const totalSavings = useMemo(() => {
    if (!rfq) return 0;
    return vendors.reduce((sum, v) => {
      if (!v.offer || v.offer.currency !== dominantCurrency) return sum;
      return (
        sum + Math.max(0, (v.offer.listPricePerDay - v.offer.pricePerDay) * rfq.durationDays)
      );
    }, 0);
  }, [vendors, rfq, dominantCurrency]);

  // Inbound-risk alerts per shop (from the activity feed) - the red banner on
  // the card that says "Will flagged this reply".
  const riskByVendor = useMemo(() => {
    const out: Record<string, string> = {};
    for (const it of activityItems) {
      if (it.kind === "alert" && it.vendorId && !out[it.vendorId]) {
        out[it.vendorId] = it.detail ?? it.title;
      }
    }
    return out;
  }, [activityItems]);

  // A price the shop quoted for a DIFFERENT vehicle (matchesSpec === false) is
  // never the traveller's "cheapest" - it would surface an e-bike as the best
  // 125cc-scooter deal. The card still shows it, flagged as off-spec. The rule
  // lives in one place so it can never drift from the compare sheet.
  const cheapest = useMemo(
    () => cheapestPresentable(vendors, dominantCurrency),
    [vendors, dominantCurrency]
  );

  // The savings ticker's symbol matches the DOMINANT currency the aggregates
  // above are computed in - never whichever offer happens to be first.
  const savingsSymbol = useMemo(() => {
    return dominantCurrency
      ? currencySymbol(dominantCurrency)
      : "$";
  }, [dominantCurrency]);

  // Will's proactive companion context: what he says, when he celebrates
  // (offerCount rises -> a new offer landed) and when he shows the attention
  // dot - all derived from live state, never invented.
  const offerCount = useMemo(
    () => activityItems.filter((it) => it.kind === "offer").length,
    [activityItems]
  );
  const riskCount = Object.keys(riskByVendor).length;
  // First-time visitors get a personal hello from Will before anything else.
  const [firstVisit, setFirstVisit] = useState(false);
  useEffect(() => {
    try {
      setFirstVisit(!localStorage.getItem("wd_onboarded"));
    } catch {}
  }, []);
  const willNote = useMemo(() => {
    if (firstVisit && phase === "idle")
      return t("Hi, I'm Will 👋 Tell me what you want to ride - I find the shops and do the haggling. Tap me any time.");
    if (paused) return t("Paused - I'm holding every message. Tap me to resume.");
    if (riskCount > 0) return t("I flagged a reply for you - worth a look.");
    if (lastWillSay) return lastWillSay;
    if (phase === "running") return t("On it - working the shops now. Tap me to steer.");
    if (phase === "done" && cheapest?.offer)
      return `${t("Best so far")}: ${moneyLocal(cheapest.offer.pricePerDay, cheapest.offer.currency)}/${t("day")} · ${t("want me to push harder?")}`;
    if (phase === "done") return t("Openers are out - I'll ping you when replies land.");
    return t("Tell me what you want to ride - I'll do the haggling.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, riskCount, lastWillSay, phase, cheapest, firstVisit]);

  // Live status for the session strip (bug #1). Three HONEST buckets that never
  // contradict each other:
  //   messaged = the shop was actually contacted (delivered, now awaiting reply)
  //   queued   = the message is held for the shop's opening hours (auto-sends)
  //   offers   = a price is in
  const statusGroups = useMemo(() => {
    const messaged: Vendor[] = [];
    // Shops that HAVE answered but not with a price yet ("which bike would you
    // like?", "we have Click 125 available"). They used to sit under "Awaiting
    // reply" next to shops that had said nothing at all - the panel's single
    // biggest lie, and the one the owner caught on 26 Jul with the shop's reply
    // visible in the feed directly underneath.
    const replied: Vendor[] = [];
    const queued: Vendor[] = [];
    const deals: Vendor[] = [];
    for (const v of vendors) {
      if (v.offer) deals.push(v);
      else if (v.lastInboundAt || v.stage === "negotiating" || v.stage === "counter-offer")
        replied.push(v);
      // A shop the agents already REACHED (a reply is pending / negotiation
      // is live) stays "messaged" even while a follow-up sits in the outbox -
      // otherwise the counters flicker right after a send. A shop whose FIRST
      // message is still held (stage rfq-sent + queuedUntil) is honestly
      // "queued": nothing has been delivered yet.
      else if (["awaiting-response", "negotiating"].includes(v.stage ?? "")) messaged.push(v);
      // In flight RIGHT NOW: an honest "queued" until it lands (its row still
      // exists, leased by the drainer - see wa/outbox-lifecycle).
      else if (v.stage === "sending" || v.queuedUntil) queued.push(v);
      else if (v.stage === "rfq-sent") messaged.push(v);
      // THE PARTITION IS TOTAL. A shop that reaches a state no branch above
      // names used to fall out of the panel entirely and simply disappear -
      // which is exactly what a mid-send shop did. A shop we have contacted
      // belongs somewhere; anything else is genuinely still just a search
      // result and is intentionally not counted.
      else if (v.sentText || v.lastEventAt) messaged.push(v);
    }
    return { messaged, replied, queued, deals };
  }, [vendors]);
  const stageCounts = {
    messaged: statusGroups.messaged.length,
    replied: statusGroups.replied.length,
    queued: statusGroups.queued.length,
    offers: statusGroups.deals.length,
  };

  // Honest pacing progress ("3 of 8 sent - next at ~14:32 - done by ~14:41")
  // derived from LIVE queue rows so mid-batch removals shrink the plan.
  const queueProgress = useMemo(
    () =>
      sendProgress(
        queueItems.map((q) => ({ notBefore: q.notBefore })),
        stageCounts.messaged + stageCounts.offers,
        Date.now()
      ),
    [queueItems, stageCounts.messaged, stageCounts.offers]
  );

  // W2: the honest ETA head (earliest not-yet-due row) + the "all done by" from
  // the server-simulated envelope, so the panel shows real ranges, not the raw
  // not_before lower bound.
  const queueEtaHead = useMemo(
    () => queueItems.find((q) => !q.due && (q.etaFrom || q.notBefore)) ?? null,
    [queueItems]
  );
  const queueEtaDoneByStr = useMemo(() => {
    let max = 0;
    for (const q of queueItems) {
      const to = q.etaTo ? Date.parse(q.etaTo) : 0;
      if (to > max) max = to;
    }
    return max ? new Date(max).toISOString() : null;
  }, [queueItems]);

  // Is the search card gated behind WhatsApp pairing right now?
  //
  // ONE definition, used by both the veil and the blur wrapper so they can never
  // disagree. Requires `restored` (hydration finished) so the lock never flashes
  // over a search that is about to be rehydrated from sessionStorage, and only
  // applies to the entry form - a live or completed search is left alone (its
  // per-shop send buttons are separately gated on waConnected).
  //
  // `waReachable` is the third state that had to exist: the lock accuses the
  // traveller of not having linked, so it may only appear when the server
  // actually SAID so. If we could not get an answer we show the form - the
  // send path still refuses on a confirmed unlink, and the server enforces it
  // regardless, so an unreachable probe costs nothing but a wasted tap while a
  // wrongly-drawn lock costs the whole session.
  const waLocked =
    waConnected !== true &&
    waReachable &&
    restored &&
    phase === "idle" &&
    vendors.length === 0;

  // Will-as-concierge: derive the ONE funnel step from live state and publish
  // it to the shared assistant context (idle detection lives there). The old
  // static top banner is gone - guidance now floats anchored to the exact
  // element the user should touch next.
  const willStageNow = useMemo(
    () =>
      deriveWillStep({
        waConnected,
        phase,
        vendorCount: vendors.length,
        offerCount,
        closing: Boolean(bookingVendor),
      }),
    [waConnected, phase, vendors.length, offerCount, bookingVendor]
  );
  const assistant = useWillAssistant();
  const assistantSetStep = assistant.setStep;
  useEffect(() => {
    assistantSetStep(willStageNow);
  }, [willStageNow, assistantSetStep]);

  // "Boom, linked!" - WaConnect stamps this the moment pairing completes, so
  // when the user lands back here Will celebrates once and hands focus to the
  // request box. Cleared on dismissal or the first search.
  const [justLinked, setJustLinked] = useState(false);
  useEffect(() => {
    try {
      if (sessionStorage.getItem("wd_wa_just_linked") === "1") setJustLinked(true);
    } catch {}
  }, [waConnected]);
  const clearJustLinked = useCallbackRef(() => {
    setJustLinked(false);
    try {
      sessionStorage.removeItem("wd_wa_just_linked");
    } catch {}
  });

  // A row overdue by >5 min means sending fell behind (typically: the app was
  // closed and no background driver ran) - say so instead of a silent stall.
  const queueStalled = useMemo(
    () => queueItems.some((q) => Date.parse(q.notBefore) < Date.now() - 5 * 60_000),
    [queueItems]
  );

  const paidPlan = session ? session.plan !== "free" : false;

  return (
    <main className="mx-auto min-h-[100dvh] max-w-md pb-32 sm:max-w-lg md:max-w-3xl">
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
        {formCollapsed && (
          <SearchSummaryBar
            requestText={rawText}
            originLabel={origin?.label}
            radiusKm={radiusKm}
            onExpand={() => setFormOpen(true)}
          />
        )}
        {/* Will as a CONCIERGE ON THE UI: a floating speech card anchored to the
            exact element the user should touch next, with 1-tap actions that do
            the thing. Replaced the static top banner. The overlay renders at the
            end of the page (fixed position); this comment marks the old site. */}
        <section className={`surface relative mt-4 rounded-blob p-4 ${formCollapsed ? "hidden" : ""}`}>
          {/* Blur-lock (feature 6.1): the search is gated behind WhatsApp
              pairing. The card stays mounted (so the onboarding tour anchors
              still exist) but is blurred + non-interactive under a premium veil
              until the number is linked. The server already refuses unpaired
              sends - this makes the gate visible and calm. */}
          {/* `restored` is the HYDRATION-DONE flag, not "a search was restored".
              This condition had it inverted since the blur-lock was written
              (d875d3c): setRestored(true) runs unconditionally on mount, so
              `!restored` was false within a tick and the lock never rendered -
              an unpaired user got the full search form and a live "Find my
              deal" button that could not possibly send. We wait FOR hydration
              (so no flash), then lock whenever there is no active search. */}
          {waLocked && <WaLockVeil checking={waConnected === null} />}
          <div className={waLocked ? "pointer-events-none select-none blur-[3px]" : ""}>
          <label className="text-[12px] font-extrabold text-soft">
            {t("What do you want to rent?")}
          </label>
          {/* STRUCTURED MODE disambiguation: while the tap builder holds a
              selection, the free-text box is visibly inactive so there is never
              a question of which input the search will use. */}
          <textarea
            data-tour="request"
            value={structuredMode ? "" : rawText}
            onChange={(e) => setRawText(e.target.value)}
            rows={2}
            disabled={structuredMode}
            className={`mt-1 w-full resize-none rounded-2xl border-2 border-line bg-card p-3 text-sm text-strong placeholder:text-faint focus:border-brandblue focus:outline-none ${
              structuredMode ? "pointer-events-none opacity-50" : ""
            }`}
            placeholder={
              structuredMode
                ? t("Using your tap-built request below 👇")
                : t("e.g. automatic SUV 5 seats for 5 days, or 125cc scooter with phone mount")
            }
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

          {/* Tap-to-build panel (F2 / Step 2): a zero-typing alternative to the
              free text above. Toggle so first-timers see the guided builder and
              typists keep the box. Locking runs the SAME search, structured. */}
          <div className="mt-2">
            <button
              onClick={() =>
                setBuilderOpen((s) => {
                  if (s) setBuilderFields(null); // closing = back to free-text mode
                  return !s;
                })
              }
              className="text-[11px] font-extrabold text-brandblue underline"
            >
              {builderOpen ? t("Prefer typing? Hide the tap builder") : t("⚡ Build your request in taps instead")}
            </button>
            {builderOpen && (
              <div className="mt-2">
                <RequestBuilder
                  // BUG 4: a new search (fresh searchEpoch) remounts the builder
                  // so its step/vehicle/duration reset - no stale carousel header
                  // carried over from the previous request.
                  key={searchEpoch}
                  busy={phase === "profiling" || phase === "running"}
                  onFieldsChange={setBuilderFields}
                />
              </div>
            )}
          </div>

          <div data-tour="stay" className="mt-3">
            <OriginPicker
              origin={origin}
              onChange={(o) => {
                setOrigin(o);
                setOriginHint(null);
              }}
              hint={originHint}
              radiusKm={radiusKm}
            />
          </div>

          {priceHintLoading && !priceHint && (
            <div className="mt-2 rounded-2xl bg-brandblue-soft p-2.5">
              <LoadingDots label={t("Researching local going rates...")} />
            </div>
          )}
          {priceHint && (priceHint.scooter || priceHint.car) && (
            <div className="mt-2 rounded-2xl bg-brandblue-soft p-2.5 text-[11px] font-bold leading-relaxed text-brandblue animate-slide-up">
              💡 {t("Local going rate here:")}{" "}
              {priceHint.scooter && (
                <>
                  {t("scooters from")} ~{moneyLocal(priceHint.scooter.floor, priceHint.scooter.currency)}/{t("day")}{" "}
                  <span className="font-normal opacity-80">({t("110cc")})</span>
                </>
              )}
              {priceHint.scooter && priceHint.car && " · "}
              {priceHint.car && (
                <>
                  {t("economy cars from")} ~{moneyLocal(priceHint.car.floor, priceHint.car.currency)}/{t("day")}{" "}
                  <span className="font-normal opacity-80">({t("small 4-seat")})</span>
                </>
              )}
              . {t("Real local floor from live web research - your agents bargain toward it.")}
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

          {/* Persistent AI + liability disclaimer across the funnel. */}
          <p className="mt-2 text-center text-[10px] leading-relaxed text-faint">
            {t("Will negotiates on your behalf - final terms always come from the shop. WheelDeal is not a party to any rental.")}{" "}
            <a href="/terms" className="underline">{t("Terms")}</a> ·{" "}
            <a href="/privacy" className="underline">{t("Privacy")}</a>
          </p>

          {/* MANDATORY IDP declaration (owner directive): the search stays
              locked until the traveller declares a valid International Driving
              Permit for the selected vehicle category. */}
          <label className="mt-2 flex items-start gap-2 rounded-2xl border-2 border-line bg-card p-3">
            <input
              type="checkbox"
              checked={idpConsent}
              onChange={(e) => {
                setIdpConsent(e.target.checked);
                try {
                  localStorage.setItem("wd_idp_consent", e.target.checked ? "yes" : "no");
                } catch {
                  /* private mode - session-only consent */
                }
              }}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--blue)]"
            />
            <span className="text-[11px] font-bold leading-snug text-soft">
              {t("I declare that I hold a valid International Driving Permit (IDP) for the selected vehicle category.")}
            </span>
          </label>

          {/* THE one unified search CTA - free-text or tap-built, this button
              runs it (there is deliberately no second button in the builder). */}
          <button
            data-tour="find"
            onClick={() =>
              structuredMode && builderFields
                ? startSearch(undefined, builderFields)
                : startSearch()
            }
            disabled={phase === "profiling" || phase === "running" || !idpConsent}
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
          {!idpConsent && (
            <p className="mt-1.5 text-center text-[10px] font-bold text-faint">
              ☝️ {t("Tick the license declaration above to start searching.")}
            </p>
          )}
          {session?.plan === "free" && (
            <p className="mt-2 text-center text-[11px] font-bold text-faint">
              {t("Free plan: pickups can be scheduled for today only.")}{" "}
              <button onClick={() => setUpgradeOpen(true)} className="text-brandblue underline">
                {t("Upgrade")}
              </button>
            </p>
          )}
          </div>
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
          <div className="mt-3 flex items-center gap-2 rounded-2xl bg-savings-soft p-3 text-[12px] font-bold text-savings animate-slide-up">
            <GoogleWordmark className="shrink-0 text-[13px]" />
            <span>✓ {t("Real rental shops near your stay, sourced live from Google.")}</span>
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
              <Tag>{vehicleLabel(rfq.vehicleClass, rfq.transmission)}</Tag>
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

        {feedStale && vendors.length > 0 && (
          <p className="mt-3 rounded-xl bg-brandyellow-soft p-2 text-center text-[11px] font-bold text-[#8a6100] dark:text-brandyellow">
            ⏳ {t("Reconnecting - live updates paused for a moment. Your agents keep working.")}
          </p>
        )}
        {/* Premium kill switch: only while the agents actually have live work
            (a shop messaged or queued). One tap pauses/resumes the whole
            session - the hard stop is enforced server-side. */}
        {vendors.length > 0 &&
          stageCounts.messaged + stageCounts.replied + Math.max(stageCounts.queued, queueItems.length) > 0 && (
            <AgentKillSwitch
              className="mt-3"
              serverPaused={paused}
              serverPausedVersion={pausedVersion}
            />
          )}

        {vendors.length > 0 && (
          <div className="mt-3 grid grid-cols-3 gap-2">
            <Stat label={t("Shops found")} value={vendors.length} />
            <Stat label={t("Offers in")} value={offersIn} accent />
            {/* BEST PRICE, not "Bargained".
                A savings total is a number about US: it reads 0 for the whole
                first stretch of every hunt, and once offers land it answers a
                question nobody asked ("how much did the list price move?").
                What the traveller is actually here for is the cheapest real,
                on-spec, bookable rate - so that is the headline, with the
                saving demoted to the line underneath where it belongs. */}
            <button
              onClick={() => cheapest && scrollToVendor(cheapest.id)}
              disabled={!cheapest}
              className="surface rounded-blob px-2 py-4 text-center disabled:cursor-default"
            >
              <div className="text-[11px] font-extrabold uppercase tracking-wide text-savings">
                {t("Best price")}
              </div>
              <div className="mt-0.5 text-[24px] leading-none font-extrabold text-savings">
                {cheapest?.offer ? (
                  <>
                    {savingsSymbol}
                    <AnimatedNumber value={Math.round(cheapest.offer.pricePerDay)} />
                  </>
                ) : (
                  <span className="text-faint">-</span>
                )}
              </div>
              <div className="mt-1 truncate text-[9.5px] font-bold text-faint">
                {cheapest?.offer
                  ? Math.round(totalSavings) > 0
                    ? `${t("saved")} ${savingsSymbol}${Math.round(totalSavings)} ${t("so far")}`
                    : `${t("per day")} · ${cheapest.name}`
                  : offersIn > 0
                    ? t("confirming details")
                    : t("agents are asking")}
              </div>
            </button>
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
              {stageCounts.replied > 0 && (
                <span className="text-brandblue">💬 {stageCounts.replied} {t("replied")}</span>
              )}
              {Math.max(stageCounts.queued, queueItems.length) > 0 && (
                <span>
                  🕘 {Math.max(stageCounts.queued, queueItems.length)} {t("queued")}
                </span>
              )}
              {stageCounts.offers > 0 && <span className="text-savings">💰 {stageCounts.offers} {t("offers")}</span>}
              {stageCounts.messaged + stageCounts.replied + stageCounts.queued + stageCounts.offers === 0 && (
                <span>{t("Tap 'Ask for price' on a shop to start")}</span>
              )}
              {stageCounts.messaged + stageCounts.replied + stageCounts.queued + stageCounts.offers > 0 && (
                <span className="ml-auto text-[10px] text-faint">{statusOpen ? "▲" : "▼"}</span>
              )}
            </button>

            {statusOpen && (stageCounts.messaged + stageCounts.replied + stageCounts.queued + stageCounts.offers > 0) && (
              <div className="space-y-2 border-t border-line px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => goToSection("[data-tour='views']", "activity")}
                    className="chip flex items-center gap-1 text-[11px] font-extrabold text-brandblue"
                  >
                    <Icon name="sparkles" className="h-3 w-3" /> {t("See the full live activity feed")} →
                  </button>
                  {/* One-tap: isolate the cards the agents are actively working. */}
                  <button
                    onClick={() =>
                      setFilters((f) => ({
                        ...f,
                        agentStatus: f.agentStatus === "active" ? "all" : "active",
                      }))
                    }
                    className={`chip flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-extrabold ${
                      filters.agentStatus === "active"
                        ? "bg-brandblue text-white"
                        : "border-2 border-line text-soft"
                    }`}
                  >
                    🔵 {filters.agentStatus === "active" ? t("Showing active rentals") : t("Show only active rentals")}
                  </button>
                </div>
                {/* SECTION 1 - Active offers & negotiations: the shops that
                    replied with a price, at full density - quote, deposit when
                    the shop stated one, rating, the latest message + time. */}
                {statusGroups.deals.length > 0 && (
                  <div>
                    <div className="mb-1 text-[10px] font-extrabold uppercase text-savings">
                      💰 {t("Offers & negotiations")} ({statusGroups.deals.length})
                    </div>
                    {statusGroups.deals.map((v) => (
                      <div key={v.id} className="mb-1.5 rounded-xl bg-card p-2 text-[11px]">
                        <div className="flex items-center justify-between gap-2">
                          <button
                            onClick={() => scrollToVendor(v.id)}
                            className="flex min-w-0 items-center gap-1 text-left font-extrabold text-strong hover:text-brandblue"
                            title={t("Jump to this shop")}
                          >
                            <span className="shrink-0 text-brandblue">↧</span>
                            <ShopAvatar name={v.name} phone={v.whatsapp} size="sm" />
                            <span className="truncate">{v.name}</span>
                          </button>
                          {/* A shop with a MENU has no single price - showing
                              one is what hid the cheaper tier. Show the range. */}
                          <span className="shrink-0 font-extrabold text-savings">
                            {v.offer &&
                              (v.offer.options && v.offer.options.length >= 2
                                ? `${moneyLocal(
                                    Math.min(...v.offer.options.map((o) => o.pricePerDay)),
                                    v.offer.currency
                                  )}-${moneyLocal(
                                    Math.max(...v.offer.options.map((o) => o.pricePerDay)),
                                    v.offer.currency
                                  )}`
                                : moneyLocal(v.offer.pricePerDay, v.offer.currency))}
                            /{t("day")}
                          </span>
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] font-bold text-faint">
                          {typeof v.rating === "number" && v.rating > 0 && <span>⭐ {v.rating.toFixed(1)}</span>}
                          {(v.offer?.deposit || v.offer?.depositType) && (
                            <span>
                              🔐 {v.offer.depositType === "passport" ? t("Passport deposit") : v.offer.deposit || t("Deposit asked")}
                            </span>
                          )}
                          {v.offer?.includesDelivery && <span>🛵 {t("Delivers")}</span>}
                          {v.offer?.includesInsurance && <span>🛡️ {t("Insurance")}</span>}
                          {v.lastEventAt && <span>🕐 {formatClock(v.lastEventAt)}</span>}
                        </div>
                        {v.offer?.message && (
                          <div className="mt-1 truncate rounded-lg bg-card2 px-2 py-1 text-[10px] text-soft">
                            💬 {v.offer.message}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* SECTION 2 - REPLIED, no price yet. The shop is talking to
                    us: show their actual last words so the panel and the feed
                    tell the same story. */}
                {statusGroups.replied.length > 0 && (
                  <div>
                    <div className="mb-1 text-[10px] font-extrabold uppercase text-brandblue">
                      💬 {t("Replied - your agent is on it")} ({statusGroups.replied.length})
                    </div>
                    {statusGroups.replied.map((v) => (
                      <div key={v.id} className="mb-1.5 rounded-xl bg-card p-2 text-[11px]">
                        <div className="flex items-center justify-between gap-2">
                          <button
                            onClick={() => scrollToVendor(v.id)}
                            className="flex min-w-0 items-center gap-1 text-left font-extrabold text-strong hover:text-brandblue"
                            title={t("Jump to this shop")}
                          >
                            <span className="shrink-0 text-brandblue">↧</span>
                            <ShopAvatar name={v.name} phone={v.whatsapp} size="sm" />
                            <span className="truncate">{v.name}</span>
                          </button>
                          <span className="shrink-0 text-[10px] font-bold text-brandblue">
                            {v.lastInboundAt ? formatClock(v.lastInboundAt) : t("replied")}
                          </span>
                        </div>
                        {v.lastInboundText && (
                          <div className="mt-1 line-clamp-2 rounded-lg bg-card2 px-2 py-1 text-[10px] text-soft">
                            💬 {v.lastInboundText}
                          </div>
                        )}
                        <div className="mt-1 text-[10px] font-bold text-faint">
                          {t("No price yet - your agent is asking for one.")}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* SECTION 3 - Awaiting reply: contacted, nothing back yet. */}
                {statusGroups.messaged.length > 0 && (
                  <div>
                    <div className="mb-1 text-[10px] font-extrabold uppercase text-faint">
                      📤 {t("Awaiting reply")} ({statusGroups.messaged.length})
                    </div>
                    {statusGroups.messaged.map((v) => (
                      <div key={v.id} className="py-0.5 text-[11px]">
                        <div className="flex items-center justify-between gap-2">
                          <button
                            onClick={() => scrollToVendor(v.id)}
                            className="flex min-w-0 items-center gap-1 text-left font-bold text-strong hover:text-brandblue"
                            title={t("Jump to this shop")}
                          >
                            <span className="shrink-0 text-brandblue">↧</span>
                            <ShopAvatar name={v.name} phone={v.whatsapp} size="sm" />
                            <span className="truncate">{v.name}</span>
                          </button>
                          <span className="shrink-0 text-faint">
                            {v.lastEventAt ? `${t("sent")} ${formatClock(v.lastEventAt)}` : t("awaiting reply")}
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

                {/* SECTION 4 - Contacting: intros still queued (auto-sends). A
                    shop here is NEVER simultaneously above - the buckets are
                    mutually exclusive by construction. */}
                {statusGroups.queued.length > 0 && (
                  <div>
                    <div className="mb-1 text-[10px] font-extrabold uppercase text-faint">
                      🕘 {t("Contacting")} ({statusGroups.queued.length})
                    </div>
                    {statusGroups.queued.map((v) => (
                      <div key={v.id} className="flex items-center justify-between gap-2 py-0.5 text-[11px]">
                        <span className="truncate font-bold text-soft">{v.name}</span>
                        <span className="shrink-0 text-faint">
                          {v.queuedUntil && Date.parse(v.queuedUntil) > Date.now()
                            ? `~${formatClock(v.queuedUntil)}`
                            : t("next safe slot")}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* How many shops are still SILENT - a shop that has written
                    back is not "still to respond", it is being worked. */}
                {stageCounts.messaged > 0 && (
                  <div className="rounded-lg bg-card px-2 py-1 text-[11px] font-bold text-soft">
                    ⏳ {stageCounts.messaged} {t("shop(s) still to respond")}
                  </div>
                )}

                {/* Wait-with-us: play the game, or leave and get alerted. Works on
                    every plan (free / pro / ultra). */}
                <div className="rounded-xl bg-brandblue-soft p-2.5 text-[11px] leading-relaxed text-brandblue">
                  {t("Replies can take a few minutes during the shop's business hours. You can wait here and play our game, or leave the app - we'll alert you when a new shop replies (all plans).")}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <button
                      onClick={() => setShowGame(true)}
                      className="btn btn-sm rounded-xl bg-brandblue px-2.5 py-1 text-[11px] font-extrabold text-white"
                    >
                      🎮 {t("Play while you wait")}
                    </button>
                    <AlertsChip t={t} />
                  </div>
                </div>

                {/* Queued messages have their own always-visible card below the
                    status panel (item #2) - not duplicated here. */}
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
            {queueStalled && (
              <p className="mb-1.5 rounded-xl bg-brandyellow-soft p-2 text-[11px] font-bold text-[#8a6100] dark:text-brandyellow">
                ⏱ {t("Sending fell behind while the app was away - catching up now, one message at a time.")}
              </p>
            )}
            {/* A paused session must not predict send times. The queue rows
                already say "Paused by you"; a "next at ~23:47" above them read
                as a promise the agents had no intention of keeping. */}
            {paused ? (
              <p className="mb-1.5 text-[11px] font-bold text-soft">
                ⏸ {t("Held while your agents are paused - tap Resume and these go out within minutes.")}
              </p>
            ) : queueProgress ? (
              <p className="mb-1.5 text-[11px] text-soft">
                {queueProgress.sent > 0
                  ? `${queueProgress.sent} ${t("of")} ${queueProgress.total} ${t("sent")} · `
                  : ""}
                {queueProgress.dueNow
                  ? t("next one leaves any moment")
                  : queueEtaHead
                    ? `${t("next at")} ${etaRangeLabel(
                        queueEtaHead.etaFrom,
                        queueEtaHead.etaTo,
                        Date.parse(queueEtaHead.etaFrom ?? queueEtaHead.notBefore) <= Date.now(),
                        queueEtaHead.notBefore,
                        t
                      )}`
                    : queueProgress.nextAt
                      ? `${t("next at")} ~${formatClock(queueProgress.nextAt)}`
                      : ""}
                {queueEtaDoneByStr && queueProgress.waiting > 1
                  ? ` · ${t("all done by")} ~${formatClock(queueEtaDoneByStr)}`
                  : queueProgress.doneBy && queueProgress.waiting > 1
                    ? ` · ${t("all done by")} ~${formatClock(queueProgress.doneBy)}`
                    : ""}
                {" - "}
                {t("your agent messages shops one at a time, the way a person would")}
              </p>
            ) : null}
            {introBudget && (
              <div className="mb-1.5 rounded-xl bg-card2 px-2.5 py-2">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="text-[11px] font-extrabold text-strong">
                    💬 {t("Shop conversations")}
                  </span>
                  <span className="whitespace-nowrap text-[10px] font-bold text-soft">
                    {introBudget.cap - introBudget.remaining} {t("of")} {introBudget.cap}{" "}
                    {t("started")} · {introBudget.windowHours}h
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
                  <div
                    className="h-full rounded-full bg-brandblue transition-all"
                    style={{
                      width: `${Math.round(
                        (Math.max(0, introBudget.cap - introBudget.remaining) /
                          Math.max(1, introBudget.cap)) *
                          100
                      )}%`,
                    }}
                  />
                </div>
                <p className="mt-1 text-[10px] text-faint">
                  {introBudget.remaining > 0
                    ? `${introBudget.remaining} ${t("more shops you can start chatting - a chat is one shop, any length or number of messages")}`
                    : introBudget.nextFreeAt
                      ? `${t("All started - your next conversation opens at")} ~${formatClock(introBudget.nextFreeAt)}`
                      : t("All started")}
                </p>
              </div>
            )}
            <div className="space-y-1.5">
              {queueItems.map((q) => (
                <div key={q.id} className="flex items-center justify-between gap-2 rounded-xl bg-card2 p-2">
                  <span className="min-w-0">
                    <span className="block truncate text-[12px] font-bold text-strong">
                      {q.vendorName || q.toNumber}
                    </span>
                    <span className="block text-[10px] text-faint">
                      {t(q.reason)}
                      {q.due
                        ? ` · ${etaRangeLabel(q.etaFrom, q.etaTo, true, q.notBefore, t)}`
                        : q.etaFrom || q.notBefore
                          ? ` · ${etaRangeLabel(q.etaFrom, q.etaTo, false, q.notBefore, t)}`
                          : ""}
                    </span>
                  </span>
                  <button
                    onClick={() => removeQueued(q.id, q.vendorId, q.toNumber)}
                    disabled={removingIds.has(q.id)}
                    className="btn btn-sm shrink-0 rounded-lg border-2 border-line px-2 py-1 text-[10px] font-extrabold text-brandred hover:bg-brandred-soft disabled:opacity-50"
                  >
                    {removingIds.has(q.id) ? t("Removing...") : t("Remove")}
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

        {/* B10: no ad placeholder on the empty first screen - a 'Sponsored' box
            is the wrong first impression before a single search has run. The ad
            still shows in results (line ~2320) once there's real content. */}
        {vendors.length > 0 && <AdBanner plan={session?.plan} />}

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
              onClick={() => {
                // Premium beta note first (backend enforces the same cap) -
                // non-subscribers go straight to the upgrade path as before.
                if (can(session?.plan, "mass-bargain")) setMassInfoOpen(true);
                else runMassBargain();
              }}
              disabled={massState === "running"}
              className={`btn w-full rounded-2xl py-3 text-[14px] font-extrabold text-white disabled:opacity-70 ${
                !can(session?.plan, "mass-bargain") ? "bg-faint" : "badge-flash"
              }`}
            >
              {massState === "running" ? (
                <LoadingDots light label={t("Agents contacting every shop")} />
              ) : (
                <span className="flex items-center justify-center gap-1.5">
                  {/* WhatsApp glyph brands the channel these messages go out on. */}
                  <Icon name={can(session?.plan, "mass-bargain") ? "whatsapp" : "lock"} className="h-4 w-4" />
                  {t("Mass bargain - ask all shops at once")}
                </span>
              )}
            </button>
            {massNote && (
              <p className="mt-1 text-center text-[11px] font-bold text-soft">{massNote}</p>
            )}
          </div>
        )}

        {vendors.length > 0 && (
          <>
            <div
              data-tour="views"
              className="surface-strong sticky top-16 z-20 mt-4 flex items-center gap-1 rounded-2xl p-1"
            >
              <ToggleBtn active={view === "list"} onClick={() => setView("list")}>
                <Icon name="list" className="h-4 w-4" /> {t("List")}
              </ToggleBtn>
              <ToggleBtn active={view === "map"} onClick={() => setView("map")}>
                <Icon name="map" className="h-4 w-4" /> {t("Map")}
              </ToggleBtn>
              <ToggleBtn active={view === "activity"} onClick={() => setView("activity")}>
                <Icon name="sparkles" className="h-4 w-4" /> {t("Activity")}
              </ToggleBtn>
            </div>
            <WaSafetyBadge safety={waHealth} />
            <div className="mt-3">
              <Filters
                filters={filters}
                onChange={setFilters}
                availableClasses={availableClasses}
                isUltra={session?.plan === "ultra"}
                onUpgrade={() => setUpgradeOpen(true)}
                tagCounts={tagCounts}
              />
            </div>
          </>
        )}

        {view === "activity" && vendors.length > 0 ? (
          <ActivityFeed
            items={activityItems}
            onWhy={(id) => setWhyDecision(id)}
            onJump={(vendorId) => scrollToVendor(vendorId)}
            phoneOf={(vendorId) => vendors.find((x) => x.id === vendorId)?.whatsapp}
            onTranscript={(id, name) => {
              const v = vendors.find((x) => x.id === id);
              if (v) setDashboardFor(v);
              else setTranscriptFor({ id, name });
            }}
          />
        ) : view === "map" && vendors.length > 0 && origin ? (
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
            {filtered.slice(0, visibleCount).map((v, i) => (
              <div
                key={v.id}
                id={`vendor-${v.id}`}
                className={`rise-in scroll-mt-24 rounded-blob transition-shadow ${
                  selectedId === v.id ? "ring-2 ring-brandblue ring-offset-2 ring-offset-[color:var(--bg)]" : ""
                }`}
                style={{ ["--i" as string]: i }}
              >
                <VendorCard
                  vendor={v}
                  rfq={rfq}
                  plan={session?.plan}
                  waConnected={waConnected}
                  localLang={localLangActive}
                  region={origin?.label ?? ""}
                  searchEpoch={searchEpoch}
                  onBook={pickVendorOption(setBookingVendor)}
                  onReviews={setReviewsVendor}
                  onBargain={pickVendorOption(setBargainVendor)}
                  onStage={handleStage}
                  onQueued={handleQueued}
                  onCustomMessage={customMessage}
                  onPickupConsent={pickupConsent}
                  onLocationRequest={(vend) => setLocationAskFor(vend)}
                  whyDecisionId={whyByVendor[v.id]}
                  onWhy={openWhy}
                  onOpenThread={(vend) => setDashboardFor(vend)}
                  riskNote={riskByVendor[v.id]}
                />
              </div>
            ))}
            {filtered.length > visibleCount && (
              <button
                onClick={() => setVisibleCount((n) => n + 20)}
                className="btn btn-ghost w-full rounded-2xl py-3 text-[13px] font-extrabold text-brandblue md:col-span-2"
              >
                {t("Show")} {Math.min(20, filtered.length - visibleCount)} {t("more shops")}
              </button>
            )}
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
            <div className="mx-auto flex w-fit items-end gap-1.5">
              <div className="float-soft">
                <WillAvatar size={72} className="drop-shadow-lg" />
              </div>
              <div className="relative mb-4 max-w-[220px] rounded-2xl rounded-bl-md bg-card2 px-3 py-2 text-left shadow-md rise-in">
                <p className="text-[12px] font-extrabold leading-snug text-strong">
                  {t("Tell me what you want to ride and where you're staying.")}
                </p>
                <p className="mt-0.5 text-[11px] leading-snug text-soft">
                  {t("I'll find every shop around you and haggle the real local price.")}
                </p>
                <span aria-hidden className="absolute -left-1 bottom-2.5 h-2 w-2 rotate-45 bg-card2" />
              </div>
            </div>
          </div>
        )}

        {/* Zero results after a completed search (was a blank screen) */}
        {vendors.length === 0 && phase === "done" && (
          <div className="mt-8 rounded-blob surface p-5 text-center animate-slide-up">
            <div className="mx-auto mb-2 w-fit">
              <WillAvatar size={56} wave={false} />
            </div>
            <div className="text-[15px] font-extrabold text-strong">
              {t("No rental shops found near your stay")}
            </div>
            <p className="mx-auto mt-1 max-w-[300px] text-[13px] text-soft">
              {t("Nothing in this radius yet - let me widen the net, or double-check the location is right.")}
            </p>
            <button
              onClick={() => {
                setRadiusKm((r) => Math.min(25, r + 5));
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
              className="btn btn-primary mt-3 rounded-2xl px-5 py-2.5 text-[13px]"
            >
              {t("Widen radius +5 km")}
            </button>
          </div>
        )}

        {/* Popular questions - owner-managed, expandable (#18) */}
        {phase === "idle" && <FaqSection />}
        {phase === "idle" && <SiteFooter />}
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
      {showGame && <WaitGame onClose={() => setShowGame(false)} />}
      {bargainVendor && rfq && (
        <BargainDraftModal
          vendor={bargainVendor}
          rfq={rfq}
          region={origin?.label ?? ""}
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
      {whyDecision && <WhyThisSheet decisionId={whyDecision} onClose={() => setWhyDecision(null)} />}
      {locationAskFor && (
        <LocationShareSheet
          shopName={locationAskFor.name}
          askedQuote={locationAskFor.offer?.askedLocationQuote}
          onClose={() => setLocationAskFor(null)}
          onShare={(place) => pickupConsent(locationAskFor, place)}
        />
      )}

      {dashboardFor && (
        <ThreadDashboard
          vendor={dashboardFor}
          rfq={rfq}
          searchEpoch={searchEpoch || undefined}
          queueItem={(() => {
            const q = queueItems.find((it) => it.vendorId === dashboardFor.id);
            return q ? { etaFrom: q.etaFrom, etaTo: q.etaTo, reason: q.reason, due: q.due } : null;
          })()}
          whyDecisionId={whyByVendor[dashboardFor.id]}
          onClose={() => setDashboardFor(null)}
          onBook={setBookingVendor}
          onBargain={setBargainVendor}
          onReviews={setReviewsVendor}
          onWhy={openWhy}
        />
      )}
      {transcriptFor && (
        <TranscriptSheet
          vendorId={transcriptFor.id}
          vendorName={transcriptFor.name}
          since={searchEpoch || undefined}
          onClose={() => setTranscriptFor(null)}
        />
      )}
      {onboarding && <Onboarding onClose={() => setOnboarding(false)} />}
      {massInfoOpen && (
        <Modal onClose={() => setMassInfoOpen(false)} center>
          <div className="text-center">
            <div className="mx-auto mb-3 w-fit">
              <WillAvatar size={56} />
            </div>
            <h2 className="text-lg font-extrabold text-strong">
              {t("Up to 10 shops per hunt")}
            </h2>
            <p className="mx-auto mt-2 max-w-[300px] text-[13px] leading-relaxed text-soft">
              {t("During the beta, each search contacts up to 10 rental shops. This keeps every negotiation sharp and your number perfectly paced while we scale the platform.")}
            </p>
            <p className="mx-auto mt-1.5 max-w-[300px] text-[12px] font-bold text-faint">
              {t("Future updates raise this limit automatically - nothing for you to do.")}
            </p>
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => setMassInfoOpen(false)}
                className="btn btn-ghost flex-1 rounded-2xl py-2.5 text-sm"
              >
                {t("Not now")}
              </button>
              <button
                onClick={() => {
                  setMassInfoOpen(false);
                  runMassBargain();
                }}
                className="btn btn-primary flex-1 rounded-2xl py-2.5 text-sm"
              >
                {t("Let's go")}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {clearConfirm && (
        <Modal onClose={() => setClearConfirm(false)} center>
          <div className="text-center">
            <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-brandred-soft text-2xl">
              🧹
            </div>
            <h2 className="text-lg font-extrabold text-strong">{t("Clear this search?")}</h2>
            <p className="mt-1 text-[13px] text-soft">
              {t("Your current shops and any offers will be removed, and every waiting message is permanently cancelled - nothing will be sent later. This can't be undone.")}
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

      {/* Will's floating concierge callout - anchored to the element the user
          should touch next, driven by the derived funnel step + idle detection.
          The celebration ("Boom, linked!") always shows once; the compose nudge
          only steps in after 8s of hesitation so it guides without nagging. */}
      {session &&
        !willOpen &&
        !bookingVendor &&
        willStageNow &&
        !dismissedStages.has(willStageNow) &&
        (() => {
          const step = willStageNow;
          let guidance: {
            anchor: string;
            text: string;
            actions?: WillAction[];
            tone?: "guide" | "celebrate";
            onDismiss?: () => void;
          } | null = null;
          if (step === "WA_LINK_PENDING") {
            guidance = {
              anchor: "[data-will='wa-link']",
              text: t("Hey! Link your WhatsApp real quick - I bargain as you, a real traveller, so shops answer honestly."),
              actions: [
                {
                  label: t("Link it now"),
                  primary: true,
                  onAction: () => {
                    startNav();
                    window.location.href = "/profile";
                  },
                },
              ],
            };
          } else if (step === "SEARCH_INPUT" && justLinked) {
            guidance = {
              anchor: "[data-tour='request']",
              tone: "celebrate",
              text: t("Boom, linked! Where are we finding you a ride today?"),
              actions: [
                {
                  label: t("Build it in taps"),
                  primary: true,
                  onAction: () => {
                    clearJustLinked();
                    setBuilderOpen(true);
                  },
                },
              ],
              onDismiss: clearJustLinked,
            };
          } else if (step === "SEARCH_INPUT" && assistant.idle) {
            guidance = {
              anchor: "[data-tour='request']",
              text: t("Tell me what you want to ride - I'll haggle every shop nearby. Not a typer? Build it in taps."),
              actions: [
                {
                  label: t("Build it in taps"),
                  primary: true,
                  onAction: () => setBuilderOpen(true),
                },
              ],
            };
          } else if (step === "AGENTS_DISPATCHED") {
            // Every action here MOVES the traveller somewhere real. These used
            // to flip a view flag with no scroll (so nothing visibly happened)
            // or simply open the chat - the report was "Will's buttons only
            // ever open the chat instead of guiding me around the app".
            guidance = {
              anchor: "[data-tour='status']",
              text: t("I'm reaching out to the shops from your WhatsApp now. You can close the app - I keep working."),
              actions: [
                {
                  label: t("Watch live"),
                  primary: true,
                  onAction: () => goToSection("[data-tour='views']", "activity"),
                },
                {
                  label: t("See the queue"),
                  onAction: () => goToSection("[data-tour='queue']"),
                },
              ],
            };
          } else if (step === "NEGOTIATING") {
            guidance = {
              anchor: "[data-tour='status']",
              text: t("Shops are reading your request - the second a price lands, I check it against the market floor and push lower."),
              actions: [
                {
                  label: t("See it live"),
                  primary: true,
                  onAction: () => goToSection("[data-tour='views']", "activity"),
                },
                {
                  label: t("Show the shops"),
                  onAction: () => goToSection("[data-tour='vendors']", "list"),
                },
              ],
            };
          } else if (step === "RESULTS_READY") {
            const best = vendors.find((v) => v.offer);
            guidance = {
              anchor: "[data-tour='status']",
              text: t("Offers are in - tap a shop to compare. Want me to push harder before you book?"),
              actions: [
                {
                  label: t("Take me to the offers"),
                  primary: true,
                  onAction: () =>
                    best ? scrollToVendor(best.id) : goToSection("[data-tour='vendors']", "list"),
                },
                {
                  label: t("Compare the top 3"),
                  onAction: () =>
                    setCompareIds(
                      vendors
                        .filter((v) => v.offer)
                        .slice(0, 3)
                        .map((v) => v.id)
                    ),
                },
                {
                  // A REAL ACTION now, not a panel. It goes through the same
                  // guarded outbound path an agent message does, and it is
                  // confirmed because it reaches a shop (lib/actions/registry).
                  label: t("Push harder"),
                  onAction: () => {
                    if (best?.id) void runAction("push-harder", { vendorId: best.id }, true);
                    else setWillOpen(true);
                  },
                },
              ],
            };
          }
          if (!guidance) return null;
          return (
            <WillGuideOverlay
              anchor={guidance.anchor}
              text={guidance.text}
              actions={guidance.actions}
              tone={guidance.tone}
              onOpenChat={() => setWillOpen(true)}
              onDismiss={() => {
                guidance?.onDismiss?.();
                dismissWillStage(step);
              }}
            />
          );
        })()}

      {/* W7: summon chip - when the inline guide is dismissed for this stage,
          Will stays one tap away as a small avatar button above the TabBar. No
          drag, no auto-nap; a stage change resurfaces the full banner. */}
      {session && !willOpen && willStageNow && dismissedStages.has(willStageNow) && (
        <button
          onClick={() => setWillOpen(true)}
          aria-label={t("Ask Will")}
          className="fixed right-3 z-[900] flex items-center gap-1.5 rounded-full border-2 border-brandblue bg-card px-2.5 py-1.5 text-[11px] font-extrabold text-brandblue shadow-lg lift"
          style={{ bottom: "calc(72px + env(safe-area-inset-bottom, 0px))" }}
        >
          <WillAvatar size={22} wave={false} />
          {t("Ask Will")}
        </button>
      )}
      {/* Will - the living companion on the edge of the screen. The TabBar is
          the primary bottom element; Will's full chat opens from him. */}
      {willOpen && (
        <WillSheet
          messages={will.messages}
          notes={will.notes}
          busy={will.busy}
          onSend={will.send}
          onClose={() => setWillOpen(false)}
        />
      )}
      {compareIds.length >= 2 && (
        <CompareSheet
          vendors={vendors.filter((v) => compareIds.includes(v.id))}
          durationDays={rfq?.durationDays ?? 1}
          onLock={(v) => {
            setCompareIds([]);
            setBookingVendor(v);
          }}
          onClose={() => setCompareIds([])}
        />
      )}

      <TabBar
        active="home"
        onSelect={(t) => {
          if (t === "profile") window.location.href = "/profile";
          else if (t === "deals") window.location.href = "/deals";
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
    <div className="surface rounded-blob px-2 py-4 text-center">
      <div className="text-[11px] font-extrabold uppercase tracking-wide text-faint">{label}</div>
      <div className={`mt-0.5 text-[28px] leading-none font-extrabold ${accent ? "text-brandblue" : "text-strong"}`}>
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

// A shop is ACTIVE when the agent is doing real work on it: an offer is in, a
// message is queued, or it is mid-conversation. Mirrors the Live Status strip's
// buckets (statusGroups) so the counts and the filtered view can never disagree.
function isActiveVendor(v: Vendor): boolean {
  return (
    !!v.offer ||
    !!v.queuedUntil ||
    ["sending", "rfq-sent", "awaiting-response", "negotiating"].includes(v.stage ?? "")
  );
}

function applyFilters(vendors: Vendor[], f: FilterState, days: number): Vendor[] {
  let list = [...vendors];

  // Vehicle class is a HARD scope (a car search must not surface a scooter).
  if (f.vehicleClass !== "any")
    list = list.filter((v) => v.vehicleClasses.includes(f.vehicleClass as any));

  // SOFT attribute filters NEVER evaporate a live negotiation - the user's core
  // expectation is "the view filters," not "my active rentals vanish." Each
  // predicate is OR'd with isActiveVendor so a messaged/queued/offer shop always
  // renders regardless of budget, delivery, rating, tag, open-now or fast toggles.
  const soft = (pred: (v: Vendor) => boolean) =>
    (list = list.filter((v) => isActiveVendor(v) || pred(v)));

  if (f.deliveryOnly) soft((v) => v.fulfillment.includes("hotel-delivery"));
  if (f.fulfillment === "in-store") soft((v) => v.fulfillment.includes("in-store"));
  if (f.openNowOnly) soft((v) => v.openNow !== false);
  if (f.fastOnly) soft((v) => v.fastResponder === true);
  // A VERIFIED TERM IS A HARD FILTER. Routed through soft() it was OR'd with
  // "is this shop live?", so tapping "🛵 Delivers" kept every messaged shop on
  // screen and the list just looked randomly reshuffled - the chip did nothing
  // and said nothing. The chip is now only tappable once at least one shop has
  // actually confirmed the term (Filters.tagCounts), which makes filtering on
  // it an informed choice about real data rather than a shot in the dark.
  if (f.tag && f.tag !== "any") list = list.filter((v) => (v.verifiedTags ?? []).includes(f.tag));
  if (f.minRating > 0) soft((v) => v.rating >= f.minRating);
  // Budget is a HARD filter, not a soft one (B9). Routing it through soft()/
  // isActiveVendor made it a TAUTOLOGY - a priced offer is always "active", so
  // the OR was always true and the budget never removed a single shop, for any
  // input. The user setting a budget explicitly WANTS over-budget quotes gone;
  // a not-yet-priced shop can't be over budget so it stays.
  if (f.maxPricePerDay)
    list = list.filter((v) => !v.offer || v.offer.pricePerDay <= (f.maxPricePerDay as number));

  if (f.agentStatus === "active") list = list.filter(isActiveVendor);
  else if (f.agentStatus === "negotiating")
    // "Negotiating now" = every shop the agent is actively working: message
    // sent, awaiting the reply, or mid-bargain.
    list = list.filter((v) =>
      ["sending", "rfq-sent", "awaiting-response", "negotiating"].includes(v.stage ?? "")
    );
  else if (f.agentStatus === "offer") list = list.filter((v) => v.offer);
  else if (f.agentStatus === "dropped")
    // "Dropped price" means the shop's live quote is BELOW its first/list price
    // (B9). The old `offer.round > 0` tested "replied more than once" - a reply
    // COUNTER, not a price movement - so a shop that restated its same price
    // twice was mislabelled as having dropped it.
    list = list.filter((v) => v.offer && v.offer.pricePerDay < v.offer.listPricePerDay);

  const savingsOf = (v: Vendor) =>
    v.offer ? (v.offer.listPricePerDay - v.offer.pricePerDay) * days : -1;

  list.sort((a, b) => {
    // Paid placements always lead, whatever the sort.
    const sp = (b.sponsored ? 1 : 0) - (a.sponsored ? 1 : 0);
    if (sp !== 0) return sp;
    switch (f.sort) {
      case "rating":
        return b.rating - a.rating;
      case "reviews":
        return (b.reviews ?? 0) - (a.reviews ?? 0);
      case "savings":
        return savingsOf(b) - savingsOf(a);
      case "status":
        return (b.offer ? 1 : 0) - (a.offer ? 1 : 0);
      default:
        // Unknown distance sorts LAST under "Closest", not first (B9): the old
        // `?? 0` made a shop with no distanceKm rank as 0 km = nearest.
        return (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity);
    }
  });
  return list;
}
