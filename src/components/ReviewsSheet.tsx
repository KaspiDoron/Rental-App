"use client";

import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { Vendor, VendorReview } from "@/lib/types";
import { Modal } from "./Modal";
import { Icon, Stars } from "./icons";

// Real Google reviews for a rental place, with word search + sorting.
export function ReviewsSheet({
  vendor,
  onClose,
}: {
  vendor: Vendor;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [reviews, setReviews] = useState<VendorReview[]>([]);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [note, setNote] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"newest" | "highest" | "lowest">("newest");

  useEffect(() => {
    if (!vendor.placeId) {
      setAvailable(false);
      setNote(
        vendor.demo
          ? "Demo vendors have no Google profile. Real vendors show live Google reviews here."
          : "This vendor has no Google reviews yet."
      );
      return;
    }
    fetch(`/api/reviews?placeId=${encodeURIComponent(vendor.placeId)}`)
      .then((r) => r.json())
      .then((d) => {
        setAvailable(Boolean(d.available));
        setReviews(d.reviews ?? []);
        if (d.note) setNote(d.note);
      })
      .catch(() => setAvailable(false));
  }, [vendor]);

  const shown = useMemo(() => {
    let list = reviews;
    const needle = q.trim().toLowerCase();
    if (needle) list = list.filter((r) => r.text.toLowerCase().includes(needle));
    list = [...list].sort((a, b) =>
      sort === "newest"
        ? b.timestamp - a.timestamp
        : sort === "highest"
        ? b.rating - a.rating
        : a.rating - b.rating
    );
    return list;
  }, [reviews, q, sort]);

  return (
    <Modal onClose={onClose}>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-extrabold text-strong">{vendor.name}</h2>
          <div className="flex items-center gap-1.5 text-[13px] text-soft">
            <Stars value={vendor.rating ?? 0} size="h-4 w-4" />
            <b className="text-strong">{vendor.rating?.toFixed(1)}</b>
            <span>· {vendor.reviews} Google reviews</span>
          </div>
        </div>
        <button onClick={onClose} className="btn btn-sm btn-ghost rounded-xl px-3" aria-label="Close">
          ✕
        </button>
      </div>

      {available === null && <div className="skeleton h-20 rounded-2xl" />}

      {available === false && (
        <div className="rounded-2xl bg-brandyellow-soft p-3 text-[13px] font-semibold text-warn">
          {note}
        </div>
      )}

      {available && (
        <>
          <div className="mb-2 flex gap-2">
            <div className="flex flex-1 items-center gap-2 rounded-xl border-2 border-line bg-card px-3">
              <Icon name="filter" className="h-4 w-4 shrink-0 text-faint" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search reviews (e.g. helmet, deposit)..."
                className="w-full bg-transparent py-2 text-[14px] text-strong placeholder:text-faint focus:outline-none"
              />
            </div>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as typeof sort)}
              className="rounded-xl border-2 border-line bg-card px-2 text-[13px] font-bold text-soft"
            >
              <option value="newest">{t("Newest")}</option>
              <option value="highest">{t("Highest")}</option>
              <option value="lowest">{t("Lowest")}</option>
            </select>
          </div>

          <div className="space-y-2">
            {shown.map((r, i) => (
              <div key={i} className="rounded-2xl bg-card2 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-extrabold text-strong">{r.author}</span>
                  <span className="text-[12px] text-faint">{r.timeAgo}</span>
                </div>
                <div className="mt-0.5">
                  <Stars value={r.rating} size="h-3.5 w-3.5" />
                </div>
                <p className="mt-1 text-[13px] leading-relaxed text-soft">{r.text}</p>
              </div>
            ))}
            {shown.length === 0 && (
              <div className="rounded-2xl bg-card2 p-3 text-center text-[13px] text-faint">
                No reviews match &quot;{q}&quot;.
              </div>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
