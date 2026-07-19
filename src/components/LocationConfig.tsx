"use client";

// LocationConfig (Module 5) - the ONE place a traveller configures what shops
// may learn about where they stay.
//
//   1. TEXT ADDRESS (default): type/pick the hotel or street via
//      PlaceAutocomplete - saved as the stay LABEL. This text is what the
//      agent shares when a shop asks about delivery ("I stay at X").
//   2. "Share precise location" TOGGLE (default OFF): the ONLY path that
//      captures coordinates - via the pin-drop map or the autocomplete's
//      resolved place - and flips shareConsent=true. While OFF, any
//      coordinates from the autocomplete are DISCARDED and the backend
//      (sanitizeStayInput) strips them again as the hard gate.
//
// Honest preview copy always states exactly what shops will see.

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { PlaceAutocomplete } from "./PlaceAutocomplete";
import { useI18n } from "@/lib/i18n";
import { LoadingDots } from "./LoadingDots";

const OriginPinPicker = dynamic(() => import("./OriginPinPicker"), { ssr: false });

interface StayState {
  label: string;
  shareConsent: boolean;
  lat?: number;
  lng?: number;
}

export default function LocationConfig({
  onSaved,
  compact = false,
}: {
  onSaved?: (stay: { label: string; shareConsent: boolean }) => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const [stay, setStay] = useState<StayState>({ label: "", shareConsent: false });
  const [pendingCoords, setPendingCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Load the current stay (coords arrive only when previously consented).
  useEffect(() => {
    let alive = true;
    fetch("/api/profile/stay")
      .then((r) => r.json())
      .then((d) => {
        if (!alive || !d?.stay) return;
        setStay({
          label: d.stay.label ?? "",
          shareConsent: Boolean(d.stay.shareConsent),
        });
        if (typeof d.stay.lat === "number" && typeof d.stay.lng === "number") {
          setPendingCoords({ lat: d.stay.lat, lng: d.stay.lng });
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const body: Record<string, unknown> = {
        label: stay.label,
        shareConsent: stay.shareConsent,
      };
      // Coordinates leave the device ONLY with the toggle ON - the client-side
      // half of the hard gate (the server strips them again regardless).
      if (stay.shareConsent && pendingCoords) {
        body.lat = pendingCoords.lat;
        body.lng = pendingCoords.lng;
      }
      const res = await fetch("/api/profile/stay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (res.ok && d.ok !== false) {
        setMsg(t("Saved") + " ✓");
        onSaved?.({ label: stay.label, shareConsent: stay.shareConsent });
      } else {
        setMsg(d.error ?? t("Could not update."));
      }
    } catch {
      setMsg(t("Could not update."));
    } finally {
      setBusy(false);
    }
  }

  const preciseReady = Boolean(stay.shareConsent && pendingCoords);

  return (
    <div>
      {!compact && (
        <p className="mt-1 text-[11px] text-soft">
          {t("If a shop asks where to deliver, your agent shares this address - and nothing more.")}
        </p>
      )}

      {/* 1. The typed address - the DEFAULT and only unconditional share. */}
      <PlaceAutocomplete
        placeholder={t("Hotel or street address")}
        value={stay.label}
        onText={(text) => setStay((s) => ({ ...s, label: text.slice(0, 160) }))}
        onPick={(p) => {
          setStay((s) => ({ ...s, label: p.label.slice(0, 160) }));
          // Coordinates from the autocomplete are HELD locally and only ever
          // sent when the precise toggle is ON at save time.
          if (typeof p.lat === "number" && typeof p.lng === "number") {
            setPendingCoords({ lat: p.lat, lng: p.lng });
          }
        }}
        className="mt-2"
      />

      {/* 2. The default-OFF precise-location gate. */}
      <label className="mt-3 flex items-start gap-2 text-[12px] font-bold text-soft">
        <input
          type="checkbox"
          checked={stay.shareConsent}
          onChange={(e) => setStay((s) => ({ ...s, shareConsent: e.target.checked }))}
          className="mt-0.5 h-4 w-4"
        />
        <span>
          {t("Share precise location")}
          <span className="block font-normal">
            {t("Adds an exact map pin so the shop finds you faster. Off = they only see the address text above.")}
          </span>
        </span>
      </label>

      {stay.shareConsent && (
        <div className="mt-2 rounded-xl border-2 border-line p-2">
          <div className="text-[11px] font-bold text-soft">
            {preciseReady
              ? `📍 ${t("Exact pin ready")} (${pendingCoords!.lat.toFixed(4)}, ${pendingCoords!.lng.toFixed(4)})`
              : t("No pin yet - drop one on the map or pick your hotel above.")}
          </div>
          <button
            type="button"
            onClick={() => setPinOpen(true)}
            className="btn btn-ghost btn-sm mt-2 rounded-xl text-[12px]"
          >
            🗺️ {t("Drop the pin on a map")}
          </button>
        </div>
      )}

      {/* Honest preview: exactly what shops will see. */}
      {stay.label.trim() && (
        <p className="mt-2 text-[11px] text-soft">
          {t("Shops will see")}: <span className="font-bold">{stay.label.trim()}</span>
          {preciseReady ? ` + ${t("exact map pin")}` : ""}
        </p>
      )}

      <button
        onClick={save}
        disabled={busy || !stay.label.trim()}
        className="btn btn-primary btn-sm mt-3 w-full rounded-xl text-[12px] disabled:opacity-60"
      >
        {busy ? <LoadingDots light label={t("Saving")} /> : t("Save")}
      </button>
      {msg && <p className="mt-2 text-[12px] font-bold text-savings">{msg}</p>}

      {pinOpen && (
        <OriginPinPicker
          initial={pendingCoords}
          radiusKm={1}
          onConfirm={(o) => {
            setPendingCoords({ lat: o.lat, lng: o.lng });
            if (o.label && !stay.label.trim()) setStay((s) => ({ ...s, label: o.label }));
            setPinOpen(false);
          }}
          onClose={() => setPinOpen(false)}
        />
      )}
    </div>
  );
}
