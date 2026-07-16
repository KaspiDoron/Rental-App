"use client";

// Once results are in, the big search card folds into this one-row summary so
// the shop cards - the thing the traveller came for - sit right at the top.
// Tapping it re-opens the full form. The form itself stays MOUNTED (collapsed
// with CSS) so its data-tour anchors and state survive.

import { Icon } from "./icons";
import { useI18n } from "@/lib/i18n";

export function SearchSummaryBar({
  requestText,
  originLabel,
  radiusKm,
  onExpand,
}: {
  requestText: string;
  originLabel?: string;
  radiusKm: number;
  onExpand: () => void;
}) {
  const { t } = useI18n();
  const req = requestText.trim();
  return (
    <button
      type="button"
      onClick={onExpand}
      className="surface mt-4 flex w-full items-center gap-2.5 rounded-blob p-3 text-left animate-slide-up"
      aria-label={t("Edit your search")}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brandblue-soft text-brandblue">
        <Icon name="bolt" className="h-4.5 w-4.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-extrabold text-strong">
          {req.length > 48 ? req.slice(0, 48) + "..." : req || t("Your search")}
        </span>
        <span className="block truncate text-[11px] font-bold text-faint">
          {originLabel ? `${originLabel} · ` : ""}
          {radiusKm} km
        </span>
      </span>
      <span className="chip shrink-0 rounded-full border border-line px-2.5 py-1 text-[11px] font-extrabold text-brandblue">
        {t("Edit")} ✎
      </span>
    </button>
  );
}
