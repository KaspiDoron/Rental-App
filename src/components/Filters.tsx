"use client";

import type { VehicleClass, Fulfillment } from "@/lib/types";
import { vehicleLabelPlural } from "@/lib/labels";
import { useI18n } from "@/lib/i18n";
import { Icon } from "./icons";

export interface FilterState {
  sort: "distance" | "rating" | "reviews" | "savings" | "status";
  vehicleClass: VehicleClass | "any";
  fulfillment: Fulfillment;
  minRating: number;
  agentStatus: "all" | "active" | "negotiating" | "dropped" | "offer";
  maxPricePerDay: number | null;
  deliveryOnly: boolean;
  openNowOnly: boolean;
  fastOnly: boolean; // Ultra: show only the fastest-replying shops
  // Verified reply-based terms (>= 2 confirming replies) to require.
  tag:
    | "any"
    | "delivery"
    | "no-deposit"
    | "passport-deposit"
    | "cash-deposit"
    | "helmets-included"
    | "insurance-included"
    // Shops that have actually shown they rent cars (a car quoted or named in
    // their own replies) - not merely shops a car search returned.
    | "rents-cars";
}

export const DEFAULT_FILTERS: FilterState = {
  sort: "distance",
  vehicleClass: "any",
  fulfillment: "any",
  minRating: 0,
  agentStatus: "all",
  maxPricePerDay: null,
  deliveryOnly: false,
  openNowOnly: false,
  fastOnly: false,
  tag: "any",
};

function Chip({
  active,
  onClick,
  children,
  disabled = false,
  title,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={title}
      aria-disabled={disabled}
      className={`chip whitespace-nowrap rounded-full border-2 px-3 py-1.5 text-[12px] font-bold transition ${
        disabled
          ? "cursor-not-allowed border-line/60 bg-card text-faint opacity-55"
          : active
            ? "border-brandblue bg-brandblue text-white"
            : "border-line bg-card text-soft hover:border-brandblue/40 hover:text-strong"
      }`}
    >
      {children}
    </button>
  );
}

export function Filters({
  filters,
  onChange,
  availableClasses,
  isUltra = false,
  onUpgrade,
  tagCounts = {},
  axis,
  onAxis,
}: {
  filters: FilterState;
  onChange: (f: FilterState) => void;
  availableClasses: VehicleClass[];
  isUltra?: boolean;
  onUpgrade?: () => void;
  /** The list's axis (owner report 3, item 12). Only the list view passes
   *  these - map and activity have no axis to flip. */
  axis?: "vertical" | "horizontal";
  onAxis?: (a: "vertical" | "horizontal") => void;
  /**
   * How many shops on screen have actually CONFIRMED each term. A verified tag
   * only exists once a shop stated it in its own replies, so at the start of a
   * hunt every count is zero - and a chip that filters on data nobody has yet
   * can only mislead. Tapping "Delivers" with no delivery data used to leave
   * the list looking randomly shuffled; now the chip simply is not live until
   * a shop has said the words.
   */
  tagCounts?: Partial<Record<FilterState["tag"], number>>;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<FilterState>) => onChange({ ...filters, ...patch });
  const classes: (VehicleClass | "any")[] =
    availableClasses.length > 1 ? ["any", ...availableClasses] : availableClasses;

  return (
    <div className="space-y-2">
      {/* Sort */}
      <div className="no-scrollbar flex items-center gap-2 overflow-x-auto pb-1">
        <span className="flex items-center gap-1 text-[11px] font-extrabold uppercase tracking-wide text-faint">
          <Icon name="filter" className="h-3.5 w-3.5" /> {t("Sort")}
        </span>
        {(["distance", "rating", "reviews", "savings", "status"] as const).map((s) => (
          <Chip key={s} active={filters.sort === s} onClick={() => set({ sort: s })}>
            {s === "distance"
              ? t("Closest")
              : s === "rating"
              ? t("Top rated")
              : s === "reviews"
              ? t("Most reviews")
              : s === "savings"
              ? t("Biggest savings")
              : t("Active first")}
          </Chip>
        ))}
        {onAxis && (
          // The axis pair rides the sort row's own scroller, pushed to the
          // end - the one place every list-view control already lives.
          <span className="ms-auto flex shrink-0 items-center gap-2 ps-2">
            <Chip active={axis !== "horizontal"} onClick={() => onAxis("vertical")}>
              ↕ {t("Feed")}
            </Chip>
            <Chip active={axis === "horizontal"} onClick={() => onAxis("horizontal")}>
              ↔ {t("Swipe")}
            </Chip>
          </span>
        )}
      </div>

      {/* Vehicle class: only classes that actually match the search */}
      {classes.length > 1 && (
        <div className="no-scrollbar flex items-center gap-2 overflow-x-auto pb-1">
          {classes.map((v) => (
            <Chip
              key={v}
              active={filters.vehicleClass === v}
              onClick={() => set({ vehicleClass: v })}
            >
              {v === "any" ? t("All vehicles") : t(vehicleLabelPlural(v))}
            </Chip>
          ))}
        </div>
      )}

      {/* Status + extras (only real, Google-confirmed signals) */}
      <div className="no-scrollbar flex items-center gap-2 overflow-x-auto pb-1">
        <Chip
          active={filters.agentStatus === "active"}
          onClick={() =>
            set({ agentStatus: filters.agentStatus === "active" ? "all" : "active" })
          }
        >
          🔵 {t("Active rentals")}
        </Chip>
        <Chip
          active={filters.openNowOnly}
          onClick={() => set({ openNowOnly: !filters.openNowOnly })}
        >
          {t("Open now")}
        </Chip>
        <Chip
          active={filters.minRating >= 4.3}
          onClick={() => set({ minRating: filters.minRating >= 4.3 ? 0 : 4.3 })}
        >
          ★ 4.3+
        </Chip>
        <Chip
          active={filters.agentStatus === "negotiating"}
          onClick={() =>
            set({ agentStatus: filters.agentStatus === "negotiating" ? "all" : "negotiating" })
          }
        >
          {t("Negotiating now")}
        </Chip>
        <Chip
          active={filters.agentStatus === "dropped"}
          onClick={() =>
            set({ agentStatus: filters.agentStatus === "dropped" ? "all" : "dropped" })
          }
        >
          {t("Dropped price")}
        </Chip>
        <Chip
          active={filters.agentStatus === "offer"}
          onClick={() =>
            set({ agentStatus: filters.agentStatus === "offer" ? "all" : "offer" })
          }
        >
          {t("Has offer")}
        </Chip>
        {/* Ultra insight: fastest-replying shops. Visible to all; tapping it
            without Ultra opens the upgrade sheet instead of filtering. */}
        <Chip
          active={filters.fastOnly}
          onClick={() => {
            if (!isUltra) {
              onUpgrade?.();
              return;
            }
            set({ fastOnly: !filters.fastOnly });
          }}
        >
          ⚡ {t("Fast responders")}{!isUltra ? " ✦" : ""}
        </Chip>
      </div>

      {/* Verified reply-based terms (only shown once a shop confirmed them >=2x) */}
      <div className="no-scrollbar flex items-center gap-2 overflow-x-auto pb-1">
        <span className="flex items-center gap-1 text-[11px] font-extrabold uppercase tracking-wide text-faint">
          ✓ {t("Verified")}
        </span>
        {(
          [
            ["rents-cars", "🚗", "Rents cars"],
            ["delivery", "🛵", "Delivers"],
            ["no-deposit", "🎉", "No deposit"],
            ["passport-deposit", "🛂", "Passport deposit"],
            ["cash-deposit", "🔒", "Cash deposit"],
            ["helmets-included", "🪖", "Helmets"],
            ["insurance-included", "🛡", "Insurance"],
          ] as const
        ).map(([id, glyph, label]) => {
          const n = tagCounts[id] ?? 0;
          return (
            <Chip
              key={id}
              active={filters.tag === id}
              disabled={n === 0}
              title={
                n === 0
                  ? t("No shop has confirmed this yet - your agents are still asking")
                  : `${n} ${n === 1 ? t("shop confirmed this") : t("shops confirmed this")}`
              }
              onClick={() => set({ tag: filters.tag === id ? "any" : id })}
            >
              {glyph} {t(label)}
              {n > 0 && <span className="ml-1 opacity-70">{n}</span>}
            </Chip>
          );
        })}
      </div>
    </div>
  );
}
