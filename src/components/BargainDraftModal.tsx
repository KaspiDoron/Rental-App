"use client";

import { useEffect, useState } from "react";
import type { Vendor, StructuredRFQ } from "@/lib/types";
import { Modal } from "./Modal";
import { LoadingDots } from "./LoadingDots";

// Adaptive Bargaining Agent UI: composes the next message to send the shop,
// learned from the tactic playbook + the owner's real transcripts, with the
// English level matched to the shop's region. User copies or sends on WhatsApp.
export function BargainDraftModal({
  vendor,
  rfq,
  region,
  round,
  currentPricePerDay,
  rivalPricePerDay,
  onClose,
}: {
  vendor: Vendor;
  rfq: StructuredRFQ;
  region?: string;
  round: number;
  currentPricePerDay?: number;
  rivalPricePerDay?: number;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<{ message: string; tacticLabel: string } | null>(null);
  const [busy, setBusy] = useState(true);
  const [copied, setCopied] = useState(false);

  async function compose() {
    setBusy(true);
    try {
      const res = await fetch("/api/bargain-draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendor,
          rfq,
          region,
          round,
          currentPricePerDay,
          rivalPricePerDay,
        }),
      });
      const data = await res.json();
      if (data.message) setDraft(data);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    compose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const waNumber = vendor.whatsapp.replace(/[^\d]/g, "");

  return (
    <Modal onClose={onClose}>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-extrabold text-strong">Bargain draft 🥊</h2>
          <p className="text-[12px] text-faint">{vendor.name}</p>
        </div>
        <button onClick={onClose} className="btn btn-sm btn-ghost rounded-xl px-3" aria-label="Close">
          ✕
        </button>
      </div>

      {busy ? (
        <div className="flex justify-center py-8">
          <LoadingDots label="Agent writing the perfect message" />
        </div>
      ) : draft ? (
        <>
          <div className="mb-2 inline-flex rounded-full bg-brandred-soft px-2.5 py-1 text-[11px] font-extrabold text-brandred">
            Tactic: {draft.tacticLabel}
          </div>
          <p className="rounded-2xl bg-card2 p-3 text-[14px] leading-relaxed text-strong">
            {draft.message}
          </p>
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => {
                navigator.clipboard?.writeText(draft.message);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="btn btn-ghost flex-1 rounded-2xl py-2.5 text-[13px]"
            >
              {copied ? "Copied ✓" : "Copy"}
            </button>
            <button onClick={compose} className="btn btn-ghost flex-1 rounded-2xl py-2.5 text-[13px]">
              Rewrite
            </button>
            {waNumber && (
              <a
                href={`https://wa.me/${waNumber}?text=${encodeURIComponent(draft.message)}`}
                target="_blank"
                rel="noreferrer"
                className="btn flex-1 rounded-2xl bg-savings py-2.5 text-center text-[13px] font-extrabold text-white"
              >
                WhatsApp
              </a>
            )}
          </div>
          <p className="mt-2 text-center text-[11px] text-faint">
            When the shop answers, tap &quot;Add vendor reply&quot; on the card so the
            agents keep learning.
          </p>
        </>
      ) : (
        <p className="py-6 text-center text-[13px] text-faint">
          Could not compose a draft. Try again.
        </p>
      )}
    </Modal>
  );
}
