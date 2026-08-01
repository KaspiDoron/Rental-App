"use client";

// WHO IS ABOUT TO BE MESSAGED, BEFORE ANYONE IS MESSAGED.
//
// Mass bargain fired straight from the button: one tap, ten shops, no list, no
// confirmation, no way back. That is a lot of the traveller's daily contact
// budget and their own WhatsApp number in front of ten strangers, decided by
// whatever order the vendor list happened to be sorted in.
//
// This is the missing beat. It shows the shops the run picked, with the
// evidence it picked them on - rating, review count, distance, address, photo -
// and lets the traveller take any of them out. Nothing has been composed or
// queued at this point; closing the sheet costs nothing at all.

import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { ShopPhoto } from "./ShopPhoto";
import { useI18n } from "@/lib/i18n";
import type { Vendor } from "@/lib/types";

export function MassBargainPreview({
  targets,
  eligibleCount,
  cap,
  onCancel,
  onConfirm,
}: {
  /** Ranked, already capped by plan. */
  targets: Vendor[];
  /** How many eligible shops exist in total - so "15 of 32" is honest. */
  eligibleCount: number;
  cap: number;
  onCancel: () => void;
  onConfirm: (vendorIds: string[]) => void;
}) {
  const { t } = useI18n();
  const [dropped, setDropped] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);

  // A new set of targets is a new decision - never carry a previous run's
  // deselections onto shops the traveller has not seen yet.
  useEffect(() => {
    setDropped(new Set());
  }, [targets]);

  const chosen = targets.filter((v) => !dropped.has(v.id));

  const toggle = (id: string) =>
    setDropped((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Modal onClose={onCancel}>
      <h2 className="text-[16px] font-extrabold text-strong">{t("Bargain with these shops?")}</h2>
      <p className="mt-1 text-[13px] leading-snug text-soft">
        {eligibleCount > targets.length
          ? t("The best {n} of {total} shops that have not been contacted yet - highest rated first.")
              .replace("{n}", String(targets.length))
              .replace("{total}", String(eligibleCount))
          : t("Every shop here has not been contacted yet - highest rated first.")}
      </p>

      <div className="mt-3 max-h-[52vh] space-y-2 overflow-y-auto">
        {targets.map((v) => {
          const out = dropped.has(v.id);
          return (
            <button
              key={v.id}
              type="button"
              onClick={() => toggle(v.id)}
              aria-pressed={!out}
              className={`flex w-full items-center gap-3 rounded-2xl border-2 p-2.5 text-left transition ${
                out ? "border-line bg-card2 opacity-50" : "border-brandblue/30 bg-card"
              }`}
            >
              <ShopPhoto
                src={v.photoUrl ?? undefined}
                label={v.name}
                className="h-11 w-11 shrink-0 rounded-xl object-cover"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-extrabold text-strong">{v.name}</div>
                <div className="truncate text-[11px] font-bold text-faint">
                  {v.rating > 0 ? `⭐ ${v.rating.toFixed(1)} · ${v.reviews} ${t("reviews")}` : t("No reviews yet")}
                  {typeof v.distanceKm === "number" ? ` · ${v.distanceKm.toFixed(1)} km` : ""}
                </div>
                {v.address ? (
                  <div className="truncate text-[11px] text-faint">{v.address}</div>
                ) : null}
              </div>
              <span
                className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-extrabold ${
                  out ? "bg-card text-faint" : "bg-brandblue-soft text-brandblue"
                }`}
              >
                {out ? t("Skipped") : "✓"}
              </span>
            </button>
          );
        })}
      </div>

      <button
        onClick={() => {
          if (sending || !chosen.length) return;
          setSending(true);
          onConfirm(chosen.map((v) => v.id));
        }}
        disabled={sending || chosen.length === 0}
        className="btn btn-primary mt-3 w-full rounded-2xl py-3 text-sm font-extrabold disabled:opacity-60"
      >
        {chosen.length === 0
          ? t("Pick at least one shop")
          : t("Message {n} shops").replace("{n}", String(chosen.length))}
      </button>
      <p className="mt-2 text-center text-[11px] text-faint">
        {t("Your plan can start up to {cap} new conversations at once.").replace("{cap}", String(cap))}
      </p>
    </Modal>
  );
}
