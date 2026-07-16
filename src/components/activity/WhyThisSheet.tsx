"use client";

// "Why this move?" for LIVE negotiations: renders the persisted director
// ladder - every possible move in priority order, whether it was legal, the
// plain-language reason, and which one was chosen. Same mental model as the
// admin Playground, now traveller-facing.

import { useEffect, useState } from "react";
import { Modal } from "../Modal";
import { LoadingDots } from "../LoadingDots";
import { Icon } from "../icons";
import { useI18n } from "@/lib/i18n";

interface Rung {
  e: string; // edgeId
  l: string; // label
  k: string; // node kind
  legal: boolean;
  chosen: boolean;
  why: string;
}

export function WhyThisSheet({
  decisionId,
  onClose,
}: {
  decisionId: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [ladder, setLadder] = useState<Rung[] | null | undefined>(undefined);
  const [vendorName, setVendorName] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/activity?why=${encodeURIComponent(decisionId)}`)
      .then((r) => r.json())
      .then((d) => {
        setLadder(Array.isArray(d.ladder) ? d.ladder : null);
        setVendorName(d.vendorName ?? null);
      })
      .catch(() => setLadder(null));
  }, [decisionId]);

  return (
    <Modal onClose={onClose}>
      <div className="mb-2 flex items-center justify-between">
        <div>
          <h2 className="text-[16px] font-extrabold text-strong">{t("Why this move?")}</h2>
          <p className="text-[11px] text-faint">
            {vendorName ? `${vendorName} · ` : ""}
            {t("Will checks every possible move in priority order - here's that exact decision")}
          </p>
        </div>
        <button onClick={onClose} className="btn btn-sm btn-ghost rounded-xl px-3" aria-label={t("Close")}>
          ✕
        </button>
      </div>

      {ladder === undefined && <LoadingDots label={t("Fetching the decision")} />}
      {ladder === null && (
        <p className="rounded-2xl bg-card2 p-3 text-[12px] text-soft">
          {t("This decision's reasoning is no longer available (older decisions are pruned).")}
        </p>
      )}
      {Array.isArray(ladder) && (
        <div className="no-scrollbar max-h-[55vh] space-y-1.5 overflow-y-auto">
          {ladder.map((r, i) => (
            <div
              key={r.e}
              className={`rounded-2xl p-2.5 ${
                r.chosen
                  ? "border-2 border-brandblue bg-brandblue-soft"
                  : r.legal
                  ? "bg-card2"
                  : "bg-card2 opacity-60"
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-extrabold ${
                    r.chosen ? "bg-brandblue text-white" : "bg-card text-faint"
                  }`}
                >
                  {i + 1}
                </span>
                <span className="text-[12px] font-extrabold text-strong">{r.l}</span>
                {r.chosen ? (
                  <span className="ml-auto flex items-center gap-1 rounded-full bg-brandblue px-2 py-0.5 text-[9px] font-extrabold text-white">
                    <Icon name="check" className="h-2.5 w-2.5" /> {t("CHOSEN")}
                  </span>
                ) : r.legal ? (
                  <span className="ml-auto rounded-full bg-savings-soft px-2 py-0.5 text-[9px] font-extrabold text-savings">
                    {t("possible")}
                  </span>
                ) : (
                  <span className="ml-auto rounded-full bg-card px-2 py-0.5 text-[9px] font-extrabold text-faint">
                    {t("skipped")}
                  </span>
                )}
              </div>
              <p className="mt-1 pl-7 text-[11px] leading-relaxed text-soft">{r.why}</p>
            </div>
          ))}
          <p className="pt-1 text-center text-[10px] text-faint">
            {t("Moves are tried top to bottom - the first sensible one wins unless Will has a strong reason to differ.")}
          </p>
        </div>
      )}
    </Modal>
  );
}
