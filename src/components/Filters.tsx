"use client";

import type { VehicleClass, Fulfillment } from "@/lib/types";
import { vehicleLabelPlural } from "@/lib/labels";
import { Icon } from "./icons";

export interface FilterState {
  sort: "distance" | "rating" | "savings" | "status";
  vehicleClass: VehicleClass | "any";
  fulfillment: Fulfillment;
  minRating: number;
  agentStatus: "all" | "negotiating" | "dropped" | "offer";
  maxPricePerDay: number | null;
  deliveryOnly: boolean;
  openNowOnly: boolean;
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
};

function Chip({
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
      className={`chip whitespace-nowrap rounded-full border-2 px-3 py-1.5 text-[12px] font-bold transition ${
        active
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
}: {
  filters: FilterState;
  onChange: (f: FilterState) => void;
  availableClasses: VehicleClass[];
}) {
  const set = (patch: Partial<FilterState>) => onChange({ ...filters, ...patch });
  const classes: (VehicleClass | "any")[] =
    availableClasses.length > 1 ? ["any", ...availableClasses] : availableClasses;

  return (
    <div className="space-y-2">
      {/* Sort */}
      <div className="no-scrollbar flex items-center gap-2 overflow-x-auto pb-1">
        <span className="flex items-center gap-1 text-[11px] font-extrabold uppercase tracking-wide text-faint">
          <Icon name="filter" className="h-3.5 w-3.5" /> Sort
        </span>
        {(["distance", "rating", "savings", "status"] as const).map((s) => (
          <Chip key={s} active={filters.sort === s} onClick={() => set({ sort: s })}>
            {s === "distance"
              ? "Closest"
              : s === "rating"
              ? "Top rated"
              : s === "savings"
              ? "Biggest savings"
              : "Active first"}
          </Chip>
        ))}
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
              {v === "any" ? "All vehicles" : vehicleLabelPlural(v)}
            </Chip>
          ))}
        </div>
      )}

      {/* Fulfillment + status + extras */}
      <div className="no-scrollbar flex items-center gap-2 overflow-x-auto pb-1">
        <Chip
          active={filters.deliveryOnly}
          onClick={() => set({ deliveryOnly: !filters.deliveryOnly })}
        >
          Hotel delivery
        </Chip>
        <Chip
          active={filters.fulfillment === "in-store"}
          onClick={() =>
            set({ fulfillment: filters.fulfillment === "in-store" ? "any" : "in-store" })
          }
        >
          In-store pickup
        </Chip>
        <Chip
          active={filters.openNowOnly}
          onClick={() => set({ openNowOnly: !filters.openNowOnly })}
        >
          Open now
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
          Negotiating now
        </Chip>
        <Chip
          active={filters.agentStatus === "dropped"}
          onClick={() =>
            set({ agentStatus: filters.agentStatus === "dropped" ? "all" : "dropped" })
          }
        >
          Dropped price
        </Chip>
        <Chip
          active={filters.agentStatus === "offer"}
          onClick={() =>
            set({ agentStatus: filters.agentStatus === "offer" ? "all" : "offer" })
          }
        >
          Has offer
        </Chip>
      </div>
    </div>
  );
}
