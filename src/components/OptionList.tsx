"use client";

// THE SHOP'S MENU, shown to the traveller.
//
// The live failure: Marlin Krabi replied "Some models 200 and some new 250/day"
// and the app showed a single "250/day". The 200 tier, the fact that a CHOICE
// existed at all, and the question of what actually separates the two bikes
// were all invisible - so the traveller could not choose, and the agent haggled
// a price nobody had picked.
//
// Each tier shows what a traveller decides on (price, how new, mileage, a photo)
// and, honestly, what we still do not know - `gaps` comes from the engine, so
// the card never implies we know more than we do. Every action routes through a
// handler the parent already owns; this component holds only selection state.

import { useState } from "react";
import type { VehicleOption } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { moneyLocal } from "@/lib/currency";

const GAP_LABEL: Record<string, string> = {
  mileage: "mileage",
  photo: "photo",
  condition: "which is newer",
  deposit: "deposit",
};

// Full class strings, never interpolated - Tailwind's JIT only keeps classes it
// can see literally in the source, so `bg-${tone}-soft` would purge to nothing.
function conditionChip(o: VehicleOption): { text: string; cls: string } | null {
  if (o.condition === "new")
    return { text: "Newer", cls: "bg-savings-soft text-savings" };
  if (o.condition === "older")
    return { text: "Older", cls: "bg-brandyellow-soft text-[#8a6100] dark:text-brandyellow" };
  return null;
}

export function OptionList({
  options,
  currency,
  durationDays,
  photoUrlFor,
  onAsk,
  onBargain,
  onLock,
}: {
  options: VehicleOption[];
  currency: string;
  durationDays?: number;
  /** Resolves a stored photo ref to a session-gated URL, when we have one. */
  photoUrlFor?: (ref: string) => string;
  onAsk: (option: VehicleOption) => void;
  onBargain: (option: VehicleOption) => void;
  onLock: (option: VehicleOption) => void;
}) {
  const { t } = useI18n();
  const [openKey, setOpenKey] = useState<string | null>(null);
  if (!options || options.length < 2) return null;

  return (
    <div className="mt-2 rounded-xl border-2 border-brandblue/30 bg-brandblue-soft p-2.5">
      <div className="text-[12px] font-bold text-brandblue">
        🛵 {t("This shop offers a choice - pick the one you want")}
      </div>

      <div className="mt-2 space-y-1.5">
        {options.map((o) => {
          const open = openKey === o.key;
          const chip = conditionChip(o);
          const photo = o.photoRefs[0] && photoUrlFor ? photoUrlFor(o.photoRefs[0]) : null;
          return (
            <div key={o.key} className="rounded-xl bg-card p-2">
              <button
                onClick={() => setOpenKey(open ? null : o.key)}
                aria-expanded={open}
                className="flex w-full items-center gap-2 text-left"
              >
                {photo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={photo}
                    alt={o.label}
                    className="h-9 w-9 shrink-0 rounded-lg object-cover"
                  />
                ) : (
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-card2 text-[14px]">
                    🛵
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[12px] font-extrabold text-strong">
                      {o.model || o.label}
                    </span>
                    {chip && (
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-extrabold ${chip.cls}`}
                      >
                        {t(chip.text)}
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-[10px] font-bold text-faint">
                    {o.mileageKm
                      ? `${o.mileageKm.toLocaleString()} km`
                      : o.gaps.length
                        ? `${t("still asking")}: ${o.gaps.map((g) => t(GAP_LABEL[g] ?? g)).join(", ")}`
                        : t("all details confirmed")}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-[13px] font-extrabold text-savings">
                    {moneyLocal(o.pricePerDay, o.currency || currency)}
                    <span className="text-[10px] font-bold text-faint">/{t("day")}</span>
                  </span>
                  {durationDays ? (
                    <span className="block text-[9px] font-bold text-faint">
                      {moneyLocal(o.pricePerDay * durationDays, o.currency || currency)} {t("total")}
                    </span>
                  ) : null}
                </span>
              </button>

              {open && (
                <div className="mt-2 flex flex-wrap gap-1.5 border-t border-line pt-2">
                  <button
                    onClick={() => onLock(o)}
                    className="btn btn-primary flex-1 rounded-xl py-1.5 text-[11px]"
                  >
                    {t("Lock this one")}
                  </button>
                  <button
                    onClick={() => onBargain(o)}
                    className="btn btn-sm chip rounded-xl border-2 border-brandred/30 bg-brandred-soft px-2.5 py-1.5 text-[11px] font-extrabold text-brandred"
                  >
                    🥊 {t("Bargain this")}
                  </button>
                  <button
                    onClick={() => onAsk(o)}
                    className="btn btn-sm rounded-xl border-2 border-line px-2.5 py-1.5 text-[11px] font-bold text-soft"
                  >
                    {t("Ask about it")}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
