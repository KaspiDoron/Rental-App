"use client";

import { useEffect, useState } from "react";
import type { Vendor, StructuredRFQ } from "@/lib/types";
import { Modal } from "./Modal";
import { LoadingDots } from "./LoadingDots";
import { useI18n } from "@/lib/i18n";

// Adaptive Bargaining Agent UI: composes the next message and sends it to the
// shop from INSIDE the app (official Cloud API). Ultra members can flip the
// agent into the shop's local language - real street-smart haggling.
export function BargainDraftModal({
  vendor,
  rfq,
  region,
  round,
  plan,
  currentPricePerDay,
  rivalPricePerDay,
  onClose,
}: {
  vendor: Vendor;
  rfq: StructuredRFQ;
  region?: string;
  round: number;
  plan?: string;
  currentPricePerDay?: number;
  rivalPricePerDay?: number;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const isUltra = plan === "ultra";
  const [language, setLanguage] = useState<"english" | "local">(
    isUltra ? "local" : "english"
  );
  const [draft, setDraft] = useState<{ message: string; tacticLabel: string } | null>(null);
  const [busy, setBusy] = useState(true);
  const [sendState, setSendState] = useState<"idle" | "sending" | "sent" | "manual">("idle");
  const [upgradeNote, setUpgradeNote] = useState(false);

  async function compose(langChoice = language) {
    setBusy(true);
    setSendState("idle");
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
          language: langChoice,
        }),
      });
      const data = await res.json();
      if (data.message) setDraft(data);
      else if (data.upgrade) setUpgradeNote(true);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    compose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function sendInApp() {
    if (!draft) return;
    setSendState("sending");
    try {
      const res = await fetch("/api/outreach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: vendor.whatsapp || undefined,
          placeId: vendor.placeId,
          vendorId: vendor.id,
          vendorName: vendor.name,
          message: draft.message,
          kind: "bargain",
          rfq,
          round,
          region,
        }),
      });
      const d = await res.json();
      setSendState(d.sent ? "sent" : "manual");
    } catch {
      setSendState("manual");
    }
  }

  return (
    <Modal onClose={onClose}>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-extrabold text-strong">{t("Bargain draft")} 🥊</h2>
          <p className="text-[12px] text-faint">{vendor.name}</p>
        </div>
        <button onClick={onClose} className="btn btn-sm btn-ghost rounded-xl px-3" aria-label="Close">
          ✕
        </button>
      </div>

      {/* Language: English / shop's local language (Ultra) */}
      <div className="mb-3 flex gap-1.5">
        <button
          onClick={() => {
            setLanguage("english");
            setUpgradeNote(false);
            compose("english");
          }}
          className={`btn btn-sm chip flex-1 rounded-xl border-2 py-2 text-[12px] font-extrabold ${
            language === "english"
              ? "border-brandblue bg-brandblue-soft text-brandblue"
              : "border-line text-soft"
          }`}
        >
          🇬🇧 {t("English")}
        </button>
        <button
          onClick={() => {
            if (!isUltra) {
              setUpgradeNote(true);
              return;
            }
            setLanguage("local");
            compose("local");
          }}
          className={`btn btn-sm chip flex-1 rounded-xl border-2 py-2 text-[12px] font-extrabold ${
            language === "local" && isUltra
              ? "badge-ultra border-transparent"
              : "border-line text-soft"
          }`}
        >
          🌍 {t("Local language")}
          {!isUltra && " 🔒"}
        </button>
      </div>
      {language === "local" && isUltra && (
        <div className="badge-ultra mb-2 rounded-full px-3 py-1 text-center text-[11px] font-extrabold">
          ⚡ ULTRA · {t("Street-smart haggling in the shop's own language")}
        </div>
      )}
      {upgradeNote && (
        <p className="mb-2 rounded-xl bg-brandyellow-soft p-2 text-[12px] font-bold text-[#8a6100] dark:text-brandyellow">
          {t("Bargaining in the local language is an Ultra perk - locals get local prices. Upgrade to unlock it.")}
        </p>
      )}

      {busy ? (
        <div className="flex justify-center py-8">
          <LoadingDots label={t("Agent writing the perfect message")} />
        </div>
      ) : draft ? (
        <>
          <div className="mb-2 inline-flex rounded-full bg-brandred-soft px-2.5 py-1 text-[11px] font-extrabold text-brandred">
            {t("Tactic:")} {draft.tacticLabel}
          </div>
          <p className="rounded-2xl bg-card2 p-3 text-[14px] leading-relaxed text-strong">
            {draft.message}
          </p>
          <div className="mt-3 flex gap-2">
            <button
              onClick={sendInApp}
              disabled={sendState === "sending" || sendState === "sent"}
              className="btn flex-1 rounded-2xl bg-savings py-2.5 text-center text-[13px] font-extrabold text-white disabled:opacity-70"
            >
              {sendState === "sending" ? (
                <LoadingDots light label={t("Sending")} />
              ) : sendState === "sent" ? (
                `✓ ${t("Sent from the app")}`
              ) : (
                t("Send from the app")
              )}
            </button>
            <button onClick={() => compose()} className="btn btn-ghost flex-1 rounded-2xl py-2.5 text-[13px]">
              {t("Rewrite")}
            </button>
          </div>
          {sendState === "manual" && (
            <a
              href="/profile"
              className="mt-2 block rounded-xl bg-brandyellow-soft p-2 text-center text-[11px] font-bold text-[#8a6100] dark:text-brandyellow"
            >
              {t("Not sent - connect your WhatsApp in Profile first.")} →
            </a>
          )}
          {sendState === "sent" && (
            <p className="mt-2 text-center text-[11px] font-bold text-savings">
              {t("The shop's answer will appear on the card automatically.")}
            </p>
          )}
        </>
      ) : !upgradeNote ? (
        <p className="py-6 text-center text-[13px] text-faint">
          {t("Could not compose a draft. Try again.")}
        </p>
      ) : null}
    </Modal>
  );
}
