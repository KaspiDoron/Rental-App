"use client";

// "Trips" (formerly "My deals") - your locked bookings + live search sessions.
// Each session is a living dashboard: who was contacted, who answered, the
// best price on the table, honest savings, what Will plans next and what
// needs the traveller. Think Linear dashboard, not an e-commerce list.

import { useEffect, useState } from "react";
import { BrandMark } from "@/components/BrandMark";
import { Icon } from "@/components/icons";
import { WillAvatar } from "@/components/will/WillAvatar";
import { LanguageButton } from "@/components/LanguageButton";
import { SiteFooter } from "@/components/SiteFooter";
import { SkeletonCard } from "@/components/Skeleton";
import { TabBar } from "@/components/TabBar";
import { FeedbackModal } from "@/components/FeedbackModal";
import { UpgradeSheet } from "@/components/UpgradeSheet";
import { startNav } from "@/components/NavVeil";
import { OrbitDots } from "@/components/OrbitDots";
import { moneyLocal } from "@/lib/currency";
import { can } from "@/lib/entitlements";
import { useI18n } from "@/lib/i18n";

interface SessionOffer {
  vendorId: string;
  vendorName: string;
  current: number;
  ask: number | null;
  currency: string;
  round: number;
  verified: boolean;
  at: string;
  stale: boolean;
}

interface TimelineEvent {
  at: string;
  kind: "sent" | "reply" | "offer" | "alert" | "booked" | "you";
  vendorName?: string;
  text: string;
}

interface SessionSummary {
  id: string;
  startedAt: string;
  isLatest: boolean;
  query: string | null;
  vehicleClass: string | null;
  radiusKm: number | null;
  shopsFound: number;
  status: "booked" | "live" | "waiting" | "wrapped";
  paused: boolean;
  contacted: number;
  replied: number;
  waiting: number;
  offers: SessionOffer[];
  best: (SessionOffer & { savedPct: number | null }) | null;
  avgAsk: number | null;
  booking: {
    vendorName: string;
    total: number | null;
    perDay: number | null;
    currency: string;
    scheduledAt: string | null;
    at: string;
  } | null;
  attention: string[];
  plannedMoves: { at: string; vendorName: string | null; reason: string }[];
  queuedSends: number;
  timeline: TimelineEvent[];
  progress: number;
  progressLabel: string;
}

interface Booking {
  id?: number;
  vendor_name: string;
  price_per_day: number;
  total_price: number;
  currency?: string | null;
  fulfillment: string;
  scheduled_at: string | null;
  status: string;
  created_at: string;
}

function timeAgo(iso: string, t: (s: string) => string): string {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (mins < 1) return t("just now");
  if (mins < 60) return `${mins}${t("m ago")}`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}${t("h ago")}`;
  const days = Math.round(hrs / 24);
  return `${days}${t("d ago")}`;
}

function timeAt(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const TIMELINE_ICON: Record<TimelineEvent["kind"], string> = {
  sent: "send",
  you: "user",
  reply: "chat",
  offer: "money",
  alert: "alert",
  booked: "check",
};

export default function DealsPage() {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [email, setEmail] = useState<string | undefined>();
  const [plan, setPlan] = useState<string>("free");
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [restoreErr, setRestoreErr] = useState<string | null>(null);
  // "Is that price still good?" - one tap re-asks every shop from a past hunt.
  const [rechecking, setRechecking] = useState<string | null>(null);
  const [recheckNote, setRecheckNote] = useState<Record<string, string>>({});

  async function recheckPrices(startedAt: string) {
    if (rechecking) return;
    setRechecking(startedAt);
    setRecheckNote((n) => ({ ...n, [startedAt]: "" }));
    try {
      const r = await fetch("/api/deals/recheck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ts: startedAt }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setRecheckNote((n) => ({
          ...n,
          [startedAt]: d?.error || t("Could not reach your shops just now. Try again."),
        }));
        return;
      }
      const asked = Number(d?.asked ?? 0);
      const skipped = Number(d?.skipped ?? 0);
      setRecheckNote((n) => ({
        ...n,
        [startedAt]:
          asked > 0
            ? `${t("Asking")} ${asked} ${asked === 1 ? t("shop") : t("shops")} - ${t("their answers land in this hunt.")}`
            : skipped > 0
              ? t("Already asked these shops today - give them a chance to answer.")
              : t("No shops from this hunt can be messaged right now."),
      }));
    } catch {
      setRecheckNote((n) => ({
        ...n,
        [startedAt]: t("Could not reach your shops just now. Try again."),
      }));
    } finally {
      setRechecking(null);
    }
  }

  const canHistory = can(plan, "trips-history");

  // Re-open a past hunt: pull its shops + RFQ from the server, write the same
  // sessionStorage payload a live search uses, then navigate home where the
  // existing rehydrate path renders the full Find-Deals workspace.
  async function restoreSession(startedAt: string, isLatest: boolean) {
    if (restoring) return;
    setRestoreErr(null);
    setRestoring(startedAt);
    try {
      const r = await fetch(`/api/deals/restore?ts=${encodeURIComponent(startedAt)}`, {
        cache: "no-store",
      });
      const d = await r.json().catch(() => ({}));
      if (r.status === 402 || d?.error === "upgrade-required") {
        setRestoring(null);
        setUpgradeOpen(true);
        return;
      }
      if (!r.ok || !d?.payload) {
        setRestoring(null);
        setRestoreErr(t("Could not re-open that hunt. Try again."));
        return;
      }
      try {
        sessionStorage.setItem("wd_search", JSON.stringify(d.payload));
      } catch {}
      startNav();
      window.location.href = "/";
    } catch {
      setRestoring(null);
      setRestoreErr(t("Could not re-open that hunt. Try again."));
    }
  }

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (!d.session) {
          window.location.href = "/login";
          return;
        }
        setEmail(d.session.email);
        setPlan(d.session.plan ?? "free");
      })
      .catch(() => {});
    fetch("/api/deals", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        const s: SessionSummary[] = d.sessions ?? [];
        setSessions(s);
        setBookings(d.bookings ?? []);
        // The freshest hunt opens expanded - it's what you came to check.
        if (s[0]) setExpanded({ [s[0].id]: true });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const vehicleLabel = (v: string | null) =>
    v === "car"
      ? t("Car")
      : v === "motorbike"
        ? t("Motorbike")
        : v === "scooter"
          ? t("Scooter")
          : t("Vehicle");

  const statusPill = (s: SessionSummary) => {
    if (s.status === "booked")
      return (
        <span className="flex items-center gap-1 rounded-full bg-savings-soft px-2.5 py-1 text-[10px] font-extrabold text-savings">
          <Icon name="check" className="h-3 w-3" /> {t("Booked")}
        </span>
      );
    if (s.paused)
      return (
        <span className="flex items-center gap-1 rounded-full bg-brandyellow-soft px-2.5 py-1 text-[10px] font-extrabold text-[#8a6100] dark:text-brandyellow">
          <Icon name="pause" className="h-3 w-3" /> {t("Paused")}
        </span>
      );
    if (s.status === "live")
      return (
        <span className="flex items-center gap-1 rounded-full bg-brandblue-soft px-2.5 py-1 text-[10px] font-extrabold text-brandblue">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brandblue opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-brandblue" />
          </span>
          {t("Live")}
        </span>
      );
    if (s.status === "waiting")
      return (
        <span className="flex items-center gap-1 rounded-full bg-card2 px-2.5 py-1 text-[10px] font-extrabold text-soft">
          <Icon name="clock" className="h-3 w-3" /> {t("Waiting on shops")}
        </span>
      );
    return (
      <span className="rounded-full bg-card2 px-2.5 py-1 text-[10px] font-extrabold text-faint">
        {t("Wrapped up")}
      </span>
    );
  };

  return (
    <main className="mx-auto min-h-[100dvh] max-w-md pb-32 sm:max-w-lg md:max-w-2xl">
      <div className="topbar">
        <div className="mx-auto flex max-w-md items-center justify-between px-4 pb-2.5 sm:max-w-lg md:max-w-2xl">
          <div className="flex items-center gap-2">
            <BrandMark size={30} />
            <h1 className="font-display text-lg font-extrabold text-strong">
              {t("Searches & hunts")}
            </h1>
          </div>
          <div className="flex items-center gap-1.5">
            <LanguageButton />
            <a href="/" className="btn btn-sm btn-ghost rounded-xl px-3 py-1.5 text-[12px]">
              ← {t("Search")}
            </a>
          </div>
        </div>
      </div>

      <div className="space-y-4 px-4 pt-4">
        {loading && (
          <>
            <SkeletonCard lines={4} />
            <SkeletonCard lines={3} />
          </>
        )}

        {!loading && sessions.length === 0 && bookings.length === 0 && (
          <div className="surface rounded-blob p-6 text-center rise-in">
            <div className="mx-auto mb-3 w-fit float-soft">
              <WillAvatar size={64} />
            </div>
            <div className="text-[15px] font-extrabold text-strong">
              {t("No hunts yet - and I'm ready")}
            </div>
            <p className="mx-auto mt-1 max-w-[300px] text-[12px] text-soft">
              {t("Tell me what you want to ride and where you're staying. I'll find nearby shops and haggle the price down while you do literally anything else.")}
            </p>
            <a
              href="/"
              onClick={() => startNav()}
              className="btn btn-primary cta-sheen mt-4 inline-block rounded-2xl px-6 py-3 text-[14px]"
            >
              {t("Start my first hunt")}
            </a>
          </div>
        )}

        {/* One living dashboard per search session */}
        {!loading &&
          sessions.map((s) => {
            const open = Boolean(expanded[s.id]);
            return (
              <section key={s.id} className="surface overflow-hidden rounded-blob rise-in">
                {/* Header - always visible, tap to expand */}
                <button
                  onClick={() => setExpanded((e) => ({ ...e, [s.id]: !open }))}
                  className="block w-full p-3.5 text-left"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-brandblue-soft text-brandblue">
                        <Icon name={s.vehicleClass === "car" ? "car" : "bike"} className="h-5 w-5" />
                      </span>
                      <div className="min-w-0">
                        <div className="truncate text-[14px] font-extrabold text-strong">
                          {vehicleLabel(s.vehicleClass)} {t("hunt")}
                          {s.radiusKm ? ` · ${s.radiusKm}km` : ""}
                        </div>
                        <div className="mt-0.5 truncate text-[11px] text-faint">
                          {s.query ? `"${s.query}"` : `${s.shopsFound} ${t("shops found")}`} ·{" "}
                          {timeAgo(s.startedAt, t)}
                        </div>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {statusPill(s)}
                      <Icon
                        name="chevron"
                        className={`h-4 w-4 text-faint transition-transform ${open ? "rotate-90" : ""}`}
                      />
                    </div>
                  </div>

                  {/* Progress - the one line users actually care about */}
                  <div className="mt-3">
                    <div className="flex items-center justify-between text-[10px] font-bold">
                      <span className="text-soft">{t(s.progressLabel)}</span>
                      <span className="tabular-nums text-faint">{s.progress}%</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-card2">
                      <div
                        className={`h-full rounded-full transition-all duration-700 ${
                          s.status === "booked" ? "bg-savings" : "bg-brandblue"
                        }`}
                        style={{ width: `${s.progress}%` }}
                      />
                    </div>
                  </div>
                </button>

                {open && (
                  <div className="space-y-3 px-3.5 pb-3.5">
                    {/* Stat trio */}
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        { n: s.contacted, label: t("contacted") },
                        { n: s.replied, label: t("replied") },
                        { n: s.waiting, label: t("waiting") },
                      ].map((st) => (
                        <div key={st.label} className="rounded-2xl bg-card2 p-2.5 text-center">
                          <div className="text-[18px] font-extrabold tabular-nums text-strong">
                            {st.n}
                          </div>
                          <div className="text-[10px] font-bold text-faint">{st.label}</div>
                        </div>
                      ))}
                    </div>

                    {/* Booked - the crown */}
                    {s.booking && (
                      <div className="rounded-2xl bg-savings-soft p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-wide text-savings">
                              <Icon name="check" className="h-3.5 w-3.5" /> {t("Locked in")}
                            </div>
                            <div className="mt-0.5 truncate text-[14px] font-extrabold text-strong">
                              {s.booking.vendorName}
                            </div>
                          </div>
                          <div className="shrink-0 text-right">
                            {s.booking.total != null && (
                              <div className="text-[16px] font-extrabold text-strong">
                                {moneyLocal(s.booking.total, s.booking.currency)}
                              </div>
                            )}
                            {s.booking.perDay != null && (
                              <div className="text-[10px] font-bold text-faint">
                                {moneyLocal(s.booking.perDay, s.booking.currency)}/{t("day")}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Best offer on the table */}
                    {!s.booking && s.best && (
                      <div className="rounded-2xl border border-brandblue/25 bg-brandblue-soft/60 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-[10px] font-extrabold uppercase tracking-wide text-brandblue">
                              {t("Best on the table")}
                            </div>
                            <div className="mt-0.5 truncate text-[14px] font-extrabold text-strong">
                              {s.best.vendorName}
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-1.5">
                              {s.best.verified ? (
                                <span className="rounded-full bg-savings-soft px-2 py-0.5 text-[10px] font-extrabold text-savings">
                                  {t("Confirmed by the shop")}
                                </span>
                              ) : (
                                <span className="rounded-full bg-card2 px-2 py-0.5 text-[10px] font-extrabold text-faint">
                                  {t("Unconfirmed")}
                                </span>
                              )}
                              {s.best.round > 0 && (
                                <span className="rounded-full bg-card2 px-2 py-0.5 text-[10px] font-extrabold text-soft">
                                  {t("After")} {s.best.round}{" "}
                                  {s.best.round === 1 ? t("round") : t("rounds")}
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="shrink-0 text-right">
                            <div className="text-[18px] font-extrabold text-strong">
                              {moneyLocal(s.best.current, s.best.currency)}
                            </div>
                            <div className="text-[10px] font-bold text-faint">/{t("day")}</div>
                            {s.best.savedPct != null && s.best.savedPct > 0 && (
                              <div className="mt-0.5 rounded-full bg-savings-soft px-2 py-0.5 text-[10px] font-extrabold text-savings">
                                −{s.best.savedPct}% {t("off asking")}
                              </div>
                            )}
                          </div>
                        </div>
                        {s.avgAsk != null && s.avgAsk > s.best.current && (
                          <div className="mt-2 text-[11px] font-bold text-soft">
                            {t("Average asking price nearby")}:{" "}
                            <span className="line-through opacity-70">
                              {moneyLocal(s.avgAsk, s.best.currency)}
                            </span>{" "}
                            → {t("yours")}: {moneyLocal(s.best.current, s.best.currency)}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Needs you */}
                    {s.attention.length > 0 && (
                      <div className="rounded-2xl bg-brandred-soft p-3">
                        <div className="flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-wide text-brandred">
                          <Icon name="bell" className="h-3.5 w-3.5" /> {t("Needs you")}
                        </div>
                        <ul className="mt-1 space-y-1">
                          {s.attention.map((a, i) => (
                            <li key={i} className="text-[11px] font-bold leading-snug text-strong">
                              · {a}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Will's planned moves */}
                    {(s.plannedMoves.length > 0 || s.queuedSends > 0) && (
                      <div className="rounded-2xl bg-card2 p-3">
                        <div className="flex items-center gap-1.5 text-[10px] font-extrabold uppercase tracking-wide text-soft">
                          <Icon name="sparkles" className="h-3.5 w-3.5" /> {t("Will's next moves")}
                        </div>
                        <ul className="mt-1 space-y-1 text-[11px] font-bold leading-snug text-soft">
                          {s.queuedSends > 0 && (
                            <li>
                              · {s.queuedSends}{" "}
                              {s.queuedSends === 1
                                ? t("message queued - it sends the moment the shop opens")
                                : t("messages queued - they send the moment shops open")}
                            </li>
                          )}
                          {s.plannedMoves.map((m, i) => (
                            <li key={i}>
                              · {m.vendorName ? `${m.vendorName}: ` : ""}
                              {m.reason} ({timeAt(m.at)})
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* All offers, cheapest first */}
                    {s.offers.length > 1 && (
                      <div>
                        <div className="mb-1.5 text-[10px] font-extrabold uppercase tracking-wide text-faint">
                          {t("Every offer in this hunt")}
                        </div>
                        <div className="space-y-1.5">
                          {s.offers.map((o) => (
                            <div
                              key={o.vendorId + o.at}
                              className="flex items-center justify-between gap-2 rounded-xl bg-card2 px-3 py-2"
                            >
                              <div className="flex min-w-0 items-center gap-1.5">
                                <span
                                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                                    o.verified ? "bg-savings" : "bg-faint"
                                  }`}
                                />
                                <span className="truncate text-[12px] font-bold text-strong">
                                  {o.vendorName}
                                </span>
                                {o.stale && (
                                  <Icon name="clock" className="h-3 w-3 shrink-0 text-brandyellow" />
                                )}
                              </div>
                              <div className="shrink-0 text-[12px] font-extrabold tabular-nums text-strong">
                                {moneyLocal(o.current, o.currency)}
                                <span className="text-[10px] font-bold text-faint">/{t("day")}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Mini timeline */}
                    {s.timeline.length > 0 && (
                      <div>
                        <div className="mb-1.5 text-[10px] font-extrabold uppercase tracking-wide text-faint">
                          {t("Latest moves")}
                        </div>
                        <div className="space-y-1.5">
                          {s.timeline.map((e, i) => (
                            <div key={i} className="flex items-start gap-2">
                              <span
                                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
                                  e.kind === "alert"
                                    ? "bg-brandred-soft text-brandred"
                                    : e.kind === "offer" || e.kind === "booked"
                                      ? "bg-savings-soft text-savings"
                                      : "bg-card2 text-faint"
                                }`}
                              >
                                <Icon name={TIMELINE_ICON[e.kind]} className="h-3 w-3" />
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-[11px] font-bold leading-tight text-soft">
                                  {e.vendorName ? `${e.vendorName}: ` : ""}
                                  {e.text}
                                </div>
                                <div className="text-[10px] text-faint">{timeAgo(e.at, t)}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Actions - Open re-opens the hunt's full workspace. The
                        latest hunt is always free; earlier ones need trip
                        history (Pro), which surfaces the upgrade sheet. */}
                    <div className="flex flex-col gap-1.5 pt-0.5">
                      {s.isLatest ? (
                        <a
                          href="/"
                          onClick={() => startNav()}
                          className="btn btn-primary flex-1 rounded-2xl py-2.5 text-center text-[13px]"
                        >
                          {t("Open live workspace")}
                        </a>
                      ) : canHistory ? (
                        <button
                          onClick={() => restoreSession(s.startedAt, false)}
                          disabled={restoring === s.startedAt}
                          className="btn btn-primary flex flex-1 items-center justify-center gap-2 rounded-2xl py-2.5 text-center text-[13px] disabled:opacity-70"
                        >
                          {restoring === s.startedAt ? (
                            <>
                              <OrbitDots size={16} light label={t("Re-opening")} />
                              {t("Re-opening…")}
                            </>
                          ) : (
                            t("Re-open this hunt")
                          )}
                        </button>
                      ) : (
                        <button
                          onClick={() => setUpgradeOpen(true)}
                          className="btn btn-ghost flex flex-1 items-center justify-center gap-1.5 rounded-2xl py-2.5 text-center text-[13px]"
                        >
                          <Icon name="lock" className="h-3.5 w-3.5" />
                          {t("Re-open this hunt (Pro)")}
                        </button>
                      )}
                      {restoreErr && restoring === null && (
                        <p className="text-center text-[10px] font-bold text-brandred">{restoreErr}</p>
                      )}

                      {/* THE QUESTION A PAST TRIP IS ACTUALLY FOR.
                          Re-opening an old hunt showed prices frozen at
                          whatever the shop said last time - useful only if you
                          then message ten shops by hand to find out whether any
                          of it still stands. One tap asks all of them, with
                          each shop's own quote read back to them. */}
                      {s.contacted > 0 && (
                        <button
                          onClick={() => recheckPrices(s.startedAt)}
                          disabled={rechecking === s.startedAt}
                          className="btn btn-ghost flex items-center justify-center gap-1.5 rounded-2xl border-2 border-savings/50 py-2.5 text-[12.5px] font-extrabold text-savings disabled:opacity-70"
                        >
                          {rechecking === s.startedAt ? (
                            <>
                              <OrbitDots size={15} label={t("Asking")} />
                              {t("Asking your shops…")}
                            </>
                          ) : (
                            <>
                              <Icon name="whatsapp" className="h-3.5 w-3.5" />
                              {t("Ask if these prices still stand")}
                            </>
                          )}
                        </button>
                      )}
                      {recheckNote[s.startedAt] && (
                        <p className="text-center text-[10.5px] font-bold text-soft">
                          {recheckNote[s.startedAt]}
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </section>
            );
          })}

        {/* Older bookings that predate the recent sessions */}
        {!loading &&
          (() => {
            const shown = new Set(
              sessions.filter((s) => s.booking).map((s) => s.booking!.at)
            );
            const rest = bookings.filter((b) => !shown.has(b.created_at));
            if (rest.length === 0) return null;
            return (
              <section className="rise-in">
                <div className="mb-2 flex items-center gap-1.5 text-[13px] font-extrabold text-strong">
                  <Icon name="check" className="h-4 w-4 text-savings" /> {t("Booked earlier")}
                </div>
                <div className="space-y-2.5">
                  {rest.map((b, i) => (
                    <div key={b.id ?? i} className="surface rounded-blob p-3.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-[14px] font-extrabold text-strong">
                            {b.vendor_name}
                          </div>
                          <div className="mt-0.5 text-[11px] text-soft">
                            {b.scheduled_at
                              ? `${t("Pick-up")}: ${b.scheduled_at.replace("T", " · ")}`
                              : t("Pick-up time agreed in chat")}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-[15px] font-extrabold text-strong">
                            {moneyLocal(b.total_price, b.currency ?? "USD")}
                          </div>
                          <div className="text-[10px] font-bold text-faint">
                            {moneyLocal(b.price_per_day, b.currency ?? "USD")}/{t("day")}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            );
          })()}

        {!loading && <SiteFooter />}
      </div>

      {/* The floating Will widget was removed (R4) - Will is now an integrated
          inline guide on the Find-deals funnel, not a disruptive edge widget. */}

      {feedbackOpen && <FeedbackModal email={email} onClose={() => setFeedbackOpen(false)} />}
      {upgradeOpen && <UpgradeSheet onClose={() => setUpgradeOpen(false)} />}

      <TabBar
        active="deals"
        onSelect={(tab) => {
          if (tab === "home") window.location.href = "/";
          else if (tab === "profile") window.location.href = "/profile";
        }}
        onFeedback={() => setFeedbackOpen(true)}
        onUpgrade={() => setUpgradeOpen(true)}
        showUpgrade={!upgradeOpen && plan === "free"}
      />
    </main>
  );
}
