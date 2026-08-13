"use client";

// Once results are in, the big search card folds into this one-row summary so
// the shop cards - the thing the traveller came for - sit right at the top.
// Tapping it re-opens the full form. The form itself stays MOUNTED (collapsed
// with CSS) so its data-tour anchors and state survive.

import { Icon } from "./icons";
import { useI18n } from "@/lib/i18n";
import { formatDateRange } from "@/lib/clock";

export function SearchSummaryBar({
  requestText,
  originLabel,
  radiusKm,
  startDate,
  endDate,
  durationDays,
  onExpand,
}: {
  requestText: string;
  originLabel?: string;
  radiusKm: number;
  /** `YYYY-MM-DD`. Absent on a legacy restored search, and that is renderable. */
  startDate?: string;
  endDate?: string;
  durationDays?: number;
  onExpand: () => void;
}) {
  const { t } = useI18n();
  const req = requestText.trim();
  // I-8/M24: THE HEADER HAS TO STATE THE ACTUAL QUERY.
  //
  // The collapsed bar showed the free-text request, the origin and the radius,
  // and said nothing about WHEN - on a product whose whole job is a dated
  // rental. A traveller who picked the wrong month had no way to notice it
  // short of re-opening the form, and the dates are also the thing the opener
  // is now required to carry (Tier 0.4), so a mismatch here is a mismatch on
  // the wire.
  //
  // Absent dates render as nothing rather than a placeholder: a search restored
  // from before dates existed is legitimately dateless, and "-" would read as
  // a bug.
  const dates = formatDateRange(startDate, endDate);
  const days = Number.isFinite(durationDays) && (durationDays ?? 0) > 0 ? durationDays : null;
  return (
    <button
      type="button"
      onClick={onExpand}
      className="surface mt-4 flex w-full items-center gap-2.5 rounded-blob p-3 text-left animate-slide-up"
      aria-label={t("Edit your search")}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brandblue-soft text-brandblue">
        <Icon name="bolt" className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        {/* ONE truncation mechanism. The manual head-slice stacked on the CSS
            end-truncation ate BOTH ends of the line under RTL (the JS cut the
            logical head, the ellipsis hid the visual end). CSS `truncate`
            alone clips the correct end in either direction; <bdi> isolates
            the free-text query so a Latin request inside a Hebrew line keeps
            its own reading order. */}
        <span className="block truncate text-[13px] font-extrabold text-strong">
          {req ? <bdi dir="auto">{req}</bdi> : t("Your search")}
        </span>
        <span className="block truncate text-[11px] font-bold text-faint">
          {originLabel ? (
            <>
              <bdi dir="auto">{originLabel}</bdi>
              {" · "}
            </>
          ) : (
            ""
          )}
          {radiusKm} km
          {dates ? ` · 📅 ${dates}` : ""}
          {days ? ` · ${days} ${days === 1 ? t("day") : t("days")}` : ""}
        </span>
      </span>
      <span className="chip shrink-0 rounded-full border border-line px-2.5 py-1 text-[11px] font-extrabold text-brandblue">
        {t("Edit")} ✎
      </span>
    </button>
  );
}
