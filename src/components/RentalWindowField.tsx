"use client";

// THE RENTAL WINDOW, ASKED ONCE, FOR BOTH INPUT MODES.
//
// "From" and "For" lived inside `RequestBuilder`, which `page.tsx` mounts only
// under `{builderOpen && ...}`. So a traveller who typed their request - the
// default mode, the one the placeholder invites - was never asked WHEN. The
// page contained exactly one occurrence of `startDate` in ~4,300 lines and
// posted only `{ text, timeZone }` to /api/profile, whose free-text branch
// destructures a `durationDays` the client had never sent. Every shop on that
// path was asked for a rental with no beginning and a duration the profiler
// guessed from prose, or the 3-day default when it could not.
//
// The window is not a step of the tap wizard. It is the standing context both
// modes are chosen against, so it belongs to the PAGE and this component is
// controlled - it owns no dates of its own. The builder receives the same two
// values as props and reports them in its RFQ fields, so the two modes cannot
// disagree about the trip they are describing.
//
// THE ZONE. `resolveWindow` is called with the DEVICE zone. It was previously
// called with none, which defaults `localDay` to UTC - so a traveller in UTC+7
// before 07:00 was offered, and bounded to, a "today" that was already
// yesterday where they stood, while the server clamped in their real zone and
// silently moved the date back. The picker and the authority now compute the
// same day.

import { useEffect, useMemo, useState } from "react";
import { addDays, deviceTimeZone, resolveWindow } from "@/lib/rental-window";
import { formatRentalDate } from "@/lib/clock";

// BUG 4: the rental duration must be directly EDITABLE - not only nudged one
// day at a time. Keeps the -/+ steppers but the number itself is typeable
// (clamped 1-90), so a 30-day rental is one keystroke.
function DurationField({
  value,
  onChange,
  t,
}: {
  value: number;
  onChange: (n: number) => void;
  t: (s: string) => string;
}) {
  const clamp = (n: number) => Math.max(1, Math.min(90, n));
  return (
    <div className="inline-flex items-center gap-2 rounded-2xl border-2 border-line bg-card px-2 py-1.5">
      <button
        type="button"
        aria-label={t("decrease")}
        onClick={() => onChange(clamp(value - 1))}
        className="btn h-8 w-8 rounded-xl bg-card2 text-xl font-extrabold text-strong"
      >
        −
      </button>
      <input
        type="number"
        inputMode="numeric"
        min={1}
        max={90}
        value={value}
        aria-label={t("Rental days")}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          if (Number.isFinite(n)) onChange(clamp(n));
        }}
        className="w-12 bg-transparent text-center text-[15px] font-extrabold text-strong outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
      />
      <span className="text-[12px] font-bold text-faint">{t("days")}</span>
      <button
        type="button"
        aria-label={t("increase")}
        onClick={() => onChange(clamp(value + 1))}
        className="btn h-8 w-8 rounded-xl bg-card2 text-xl font-extrabold text-strong"
      >
        +
      </button>
    </div>
  );
}

// A NATIVE DATE INPUT, BOUNDED BY THE PLAN.
//
// `min`/`max` are the plan window (rental-window.ts: free books today only, Pro
// 30 days ahead, Ultra 180). The server clamps too - clampRfqWindow is the
// authority and stays so - but a picker that lets someone choose a date the
// server will silently move is a picker that lies. Native `date` because it is
// the one control every phone already knows how to drive, in every locale.
function StartDateField({
  value,
  min,
  max,
  onChange,
  label,
}: {
  value: string;
  min: string;
  max: string;
  onChange: (d: string) => void;
  label: string;
}) {
  return (
    <input
      type="date"
      value={value}
      min={min}
      max={max}
      aria-label={label}
      onChange={(e) => {
        const d = e.target.value;
        // An empty or out-of-range value falls back to the soonest bookable
        // day rather than travelling to the server as undefined.
        if (!d) return onChange(min);
        onChange(d < min ? min : d > max ? max : d);
      }}
      // >= 16px so iOS does not zoom the whole page on focus.
      className="rounded-2xl border-2 border-line bg-card px-3 py-1.5 text-[16px] font-extrabold text-strong outline-none"
    />
  );
}

/**
 * The plan-bounded window for a given plan, resolved in the DEVICE's zone.
 *
 * Deferred to after mount on purpose: the server renders this page and its
 * clock and zone are not the traveller's, so computing the bounds during SSR
 * and again on the client produces two different date strings for the same
 * control - a hydration mismatch on the one value the whole funnel depends on.
 * Until mounted we resolve with no zone (matching the server exactly), then
 * recompute once with the real one.
 */
export function usePlanWindow(plan: string | null | undefined) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return useMemo(
    () =>
      resolveWindow({
        plan,
        nowMs: Date.now(),
        timeZone: mounted ? deviceTimeZone() : undefined,
      }),
    [plan, mounted]
  );
}

export function RentalWindowField({
  startDate,
  days,
  today,
  maxStartDate,
  onStartDateChange,
  onDaysChange,
  adjustedReason,
  t,
  tShared,
}: {
  startDate: string;
  days: number;
  /** The soonest bookable day, in the traveller's zone. */
  today: string;
  /** The furthest day this plan may book. */
  maxStartDate: string;
  onStartDateChange: (d: string) => void;
  onDaysChange: (n: number) => void;
  /**
   * What the SERVER did to this window, in the traveller's words. The clamp
   * decision has always carried a `reason`; every caller threw it away, so a
   * date the server moved simply appeared to have been mistyped.
   */
  adjustedReason?: string | null;
  t: (s: string) => string;
  /**
   * For the clamp reason only. It is composed on the server and one of its
   * three forms interpolates a day count, so it can never be a catalogue
   * literal - `tShared` is the path for server-produced sentences.
   */
  tShared: (s: string) => string;
}) {
  // The day they hand it back. UTC-anchored calendar arithmetic on a date
  // LABEL - `addDays` exists precisely because doing this with a local Date
  // returned a day early for every traveller in Asia.
  const returnDate = addDays(startDate, days);
  return (
    <div
      data-tour="window"
      data-testid="rental-window"
      className="rounded-2xl border-2 border-line bg-card2 px-3 py-2.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-extrabold text-strong">{t("From")}</span>
          <StartDateField
            value={startDate}
            min={today}
            max={maxStartDate}
            onChange={onStartDateChange}
            label={t("Pickup date")}
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-extrabold text-strong">{t("For")}</span>
          <DurationField value={days} onChange={onDaysChange} t={t} />
        </div>
      </div>
      <p className="mt-1.5 text-[11px] font-bold text-faint">
        {t("Back on")} {formatRentalDate(returnDate)}
      </p>
      {/* The free plan arranges same-day rentals only. Saying so at the picker
          beats a silent server-side clamp that moves the date after they have
          already pressed search. */}
      {maxStartDate === today && (
        <p className="mt-0.5 text-[11px] font-bold text-faint">
          {t("Your plan arranges same-day rentals - Pro and Ultra book ahead.")}
        </p>
      )}
      {adjustedReason && (
        <p className="mt-1.5 rounded-xl bg-brandblue-soft px-2.5 py-1.5 text-[11px] font-bold leading-snug text-brandblue">
          {t("We moved your pickup date:")} {tShared(adjustedReason)}
        </p>
      )}
    </div>
  );
}
