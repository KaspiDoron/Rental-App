"use client";

import { useEffect, useRef, useState } from "react";
import { LoadingDots } from "./LoadingDots";
import { WaTermsModal } from "./WaTermsModal";
import { useI18n } from "@/lib/i18n";

// The ONE WhatsApp-connect experience, used identically in signup and in the
// Profile page. Pairing-code first (works on the same phone - no camera or
// gallery needed), QR as the secondary path for a second device.
export function WaConnect({
  phone,
  compact = false,
  onConnected,
}: {
  phone?: string;
  compact?: boolean;
  onConnected?: () => void;
}) {
  const { t } = useI18n();
  const [wa, setWa] = useState<{
    available: boolean;
    connected: boolean;
    reconnecting?: boolean;
  } | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [copied, setCopied] = useState(false);
  const [method, setMethod] = useState<"code" | "qr">("code");
  const [showTerms, setShowTerms] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    fetch("/api/wa/status")
      .then((r) => r.json())
      .then((d) => setWa(d))
      .catch(() => {});
    return () => clearInterval(poll.current);
  }, []);

  async function connect() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/wa/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const d = await res.json();
      if (!d.available) {
        setErr(d.error ?? t("The WhatsApp connector is not set up yet."));
        return;
      }
      if (d.pairingCode) setPairingCode(d.pairingCode);
      if (d.qr) setQr(d.qr);
      // Soft error (reachable but no code/QR yet) - surface it but keep the UI.
      if (d.error) setErr(d.error);
      else if (!d.pairingCode && !d.qr) {
        setErr(t("Could not get a code yet - tap Try again in a few seconds."));
      }
      clearInterval(poll.current);
      poll.current = setInterval(async () => {
        const s = await (await fetch("/api/wa/status")).json();
        setWa(s);
        if (s.connected) {
          clearInterval(poll.current);
          setQr(null);
          setPairingCode(null);
          onConnected?.();
        }
      }, 3000);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await fetch("/api/wa/disconnect", { method: "POST" });
      setWa((w) => (w ? { ...w, connected: false } : w));
      setQr(null);
      setPairingCode(null);
    } finally {
      setBusy(false);
    }
  }

  if (wa && !wa.available) {
    return (
      <p className="rounded-2xl bg-brandyellow-soft p-3 text-[12px] font-bold text-[#8a6100] dark:text-brandyellow">
        {t("The WhatsApp connector is not set up yet (owner: Admin -> Keys -> Evolution API).")}
      </p>
    );
  }

  if (wa?.connected) {
    return (
      <div className={`rounded-2xl p-3 ${wa.reconnecting ? "bg-brandyellow-soft" : "bg-savings-soft"}`}>
        <div className="flex items-center justify-between">
          <span
            className={`text-[13px] font-extrabold ${
              wa.reconnecting ? "text-[#8a6100] dark:text-brandyellow" : "text-savings"
            }`}
          >
            {wa.reconnecting
              ? `↻ ${t("WhatsApp linked - reconnecting the server...")}`
              : `✓ ${t("WhatsApp connected - agents bargain as you")}`}
          </span>
          <button
            onClick={disconnect}
            disabled={busy}
            className="btn btn-sm chip rounded-xl bg-card px-3 text-[11px] font-bold text-brandred disabled:opacity-60"
          >
            {busy ? <LoadingDots /> : t("Disconnect")}
          </button>
        </div>
      </div>
    );
  }

  const showingCode = pairingCode || qr;

  return (
    <div>
      {!showingCode && (
        <>
          {!compact && (
            <p className="mb-2 text-[12px] text-soft">
              {t("Connect your WhatsApp so the agents can ask shops for prices and bargain as YOU - replies land back here automatically. Takes ~30 seconds.")}
            </p>
          )}
          <label
            dir="ltr"
            className="mb-2 flex items-start gap-2 rounded-2xl bg-card2 p-2.5 text-left text-[12px] leading-relaxed text-soft"
          >
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--blue)]"
            />
            <span>
              {t("I have read and accept the")}{" "}
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  setShowTerms(true);
                }}
                className="font-extrabold text-brandblue underline"
              >
                {t("WhatsApp Linking Terms, Waiver & Release of Liability")}
              </button>
              {t(", and I accept full and sole responsibility for any consequence to my number.")}
            </span>
          </label>
          {showTerms && <WaTermsModal onClose={() => setShowTerms(false)} />}
          <button
            onClick={connect}
            disabled={busy || !consent}
            className="btn btn-primary w-full rounded-2xl py-3 text-[14px] disabled:opacity-50"
          >
            {busy ? <LoadingDots light label={t("Preparing your code")} /> : `💬 ${t("Connect my WhatsApp")}`}
          </button>
        </>
      )}

      {showingCode && (
        <div className="rounded-2xl bg-card2 p-3">
          {/* Method switch */}
          <div className="mb-2 flex gap-1.5">
            <button
              onClick={() => setMethod("code")}
              className={`btn btn-sm chip flex-1 rounded-xl border-2 py-1.5 text-[11px] font-extrabold ${
                method === "code" ? "border-brandblue bg-brandblue-soft text-brandblue" : "border-line text-soft"
              }`}
            >
              🔢 {t("Code (same phone)")}
            </button>
            <button
              onClick={() => setMethod("qr")}
              className={`btn btn-sm chip flex-1 rounded-xl border-2 py-1.5 text-[11px] font-extrabold ${
                method === "qr" ? "border-brandblue bg-brandblue-soft text-brandblue" : "border-line text-soft"
              }`}
            >
              📷 {t("QR (second device)")}
            </button>
          </div>

          {method === "code" && (
            <>
              {pairingCode ? (
                <button
                  onClick={() => {
                    navigator.clipboard?.writeText(pairingCode.replace(/-/g, ""));
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                  className="btn mx-auto block rounded-2xl bg-card px-6 py-3 text-center"
                >
                  <span className="font-mono text-2xl font-extrabold tracking-[0.3em] text-strong">
                    {pairingCode}
                  </span>
                  <span className="block text-[10px] font-bold text-brandblue">
                    {copied ? `✓ ${t("Copied")}` : t("Tap to copy")}
                  </span>
                </button>
              ) : (
                <p className="rounded-xl bg-brandyellow-soft p-2 text-center text-[11px] font-bold text-[#8a6100] dark:text-brandyellow">
                  {err ||
                    t("Preparing your code... tap Try again in a few seconds. If it keeps failing, use the QR tab from a computer.")}
                </p>
              )}
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-[11px] font-bold text-soft">
                <li>
                  <a href="whatsapp://" className="text-brandblue underline">
                    {t("Open WhatsApp")}
                  </a>{" "}
                  {t("on this phone.")}
                </li>
                <li>
                  🍏 {t("iPhone: Settings tab (bottom right) -> Linked Devices.")}{" "}
                  🤖 {t("Android: 3 dots (top right) -> Linked devices.")}
                </li>
                <li>{t("Tap Link a Device, then 'Link with phone number instead'.")}</li>
                <li>{t("Type the code above - done! This screen turns green by itself.")}</li>
              </ol>
            </>
          )}

          {method === "qr" &&
            (qr ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={qr} alt="WhatsApp QR" className="mx-auto h-40 w-40 rounded-xl bg-white p-2" />
                <p className="mt-1.5 text-center text-[11px] font-bold text-soft">
                  {t("Open this page on your computer or a second phone, then scan with WhatsApp -> Linked Devices -> Link a Device.")}
                </p>
              </>
            ) : (
              <p className="text-center text-[11px] font-bold text-faint">{t("QR not available - use the code method.")}</p>
            ))}

          <div className="mt-2 flex items-center justify-between">
            <button onClick={connect} disabled={busy} className="btn btn-sm chip rounded-xl bg-card px-3 text-[11px] font-bold text-brandblue disabled:opacity-60">
              {busy ? <LoadingDots /> : `↻ ${t("Try again / new code")}`}
            </button>
            <LoadingDots label={t("Waiting for the link")} />
          </div>
        </div>
      )}

      {err && (
        <p className="mt-2 rounded-xl bg-brandyellow-soft p-2 text-[11px] font-bold text-[#8a6100] dark:text-brandyellow">
          {err}
        </p>
      )}
    </div>
  );
}
