"use client";

import type { VehicleClass, Fulfillment } from "@/lib/types";
import { Icon } from "./icons";

export interface FilterState {
  sort: "distance" | "rating" | "savings" | "status";
  vehicleClass: VehicleClass | "any";
  fulfillment: Fulfillment;
  minRating: number;
  agentStatus: "all" | "negotiating" | "dropped" | "offer";
  maxPricePerDay: number | null;
  deliveryOnly: boolean;
}

export const DEFAULT_FILTERS: FilterState = {
  sort: "distance",
  vehicleClass: "any",
  fulfillment: "any",
  minRating: 0,
  agentStatus: "all",
  maxPricePerDay: null,
  deliveryOnly: false,
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
      className={`whitespace-nowrap rounded-full border px-3 py-1.5 text-[12px] font-medium transition active:scale-95 ${
        active
          ? "border-savings/50 bg-savings/15 text-savings-bright"
          : "border-slate-700/50 bg-ink/40 text-slate-300 hover:bg-slate-700/30"
      }`}
    >
      {children}
    </button>
  );
}

export function Filters({
  filters,
  onChange,
}: {
  filters: FilterState;
  onChange: (f: FilterState) => void;
}) {
  const set = (patch: Partial<FilterState>) => onChange({ ...filters, ...patch });

  return (
    <div className="space-y-2">
      {/* Sort */}
      <div className="no-scrollbar flex items-center gap-2 overflow-x-auto pb-1">
        <span className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-slate-500">
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

      {/* Vehicle class */}
      <div className="no-scrollbar flex items-center gap-2 overflow-x-auto pb-1">
        {(["any", "car", "motorbike", "scooter"] as const).map((v) => (
          <Chip
            key={v}
            active={filters.vehicleClass === v}
            onClick={() => set({ vehicleClass: v })}
          >
            {v === "any" ? "All vehicles" : v[0].toUpperCase() + v.slice(1) + "s"}
          </Chip>
        ))}
      </div>

      {/* Fulfillment + agent status + extras */}
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
            set({
              fulfillment: filters.fulfillment === "in-store" ? "any" : "in-store",
            })
          }
        >
          In-store pickup
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
            set({
              agentStatus:
                filters.agentStatus === "negotiating" ? "all" : "negotiating",
            })
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
