"use client";

// Profile "Alerts" section: a real on/off toggle for shop-reply push
// notifications, bound to SERVER truth (has-subscription), with honest per-state
// help text. Replaces the old dead-end where the only path was the funnel button
// and there was no way to turn alerts off.

import { usePushAlerts } from "@/lib/use-push";

export function AlertsToggle({ t }: { t: (s: string) => string }) {
  const { state, devices, note, enable, disable } = usePushAlerts();

  const isOn = state === "on";
  const busy = state === "busy" || state === "loading";
  const canToggle = state === "on" || state === "off" || state === "busy";

  const help = (() => {
    switch (state) {
      case "unconfigured":
        return t("Alerts are being switched on for everyone - check back soon.");
      case "unsupported":
        return t("This browser can't do push alerts. Try Chrome, or install the app.");
      case "ios-install":
        return t("Add WheelDeal to your Home Screen first (Share -> Add to Home Screen), then enable alerts.");
      case "denied":
        return t("Notifications are blocked in your browser settings - allow them there, then try again.");
      case "on":
        return `${t("On for")} ${devices} ${devices === 1 ? t("device") : t("devices")} - ${t("we'll ping you when a shop replies, even with the app closed.")}`;
      case "off":
        return t("Get a notification the moment a shop replies, even when the app is closed.");
      default:
        return t("Get a notification the moment a shop replies, even when the app is closed.");
    }
  })();

  return (
    <section className="surface rounded-blob p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="text-[13px] font-extrabold text-strong">🔔 {t("Alerts")}</div>
        {canToggle ? (
          <button
            role="switch"
            aria-checked={isOn}
            disabled={busy}
            onClick={() => (isOn ? disable() : enable())}
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
              isOn ? "bg-savings" : "bg-line"
            }`}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
                isOn ? "left-[22px]" : "left-0.5"
              }`}
            />
          </button>
        ) : (
          <span className="rounded-full bg-card2 px-2 py-0.5 text-[10px] font-extrabold text-faint">
            {state === "unconfigured" ? t("Soon") : t("Unavailable")}
          </span>
        )}
      </div>
      <p className="text-[11px] font-medium text-soft">{help}</p>
      {note && <p className="mt-1 text-[11px] font-bold text-brandred">{note}</p>}
    </section>
  );
}
