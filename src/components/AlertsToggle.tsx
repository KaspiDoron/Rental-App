"use client";

// Profile "Alerts" section: a real on/off toggle for shop-reply push
// notifications, bound to SERVER truth (has-subscription), with honest per-state
// help text. Replaces the old dead-end where the only path was the funnel button
// and there was no way to turn alerts off.

import { usePushAlerts } from "@/lib/use-push";

export function AlertsToggle({ t }: { t: (s: string) => string }) {
  const { state, devices, note, enable, disable, disableEverywhere, test } = usePushAlerts();

  const isOn = state === "on";
  const busy = state === "busy" || state === "loading";
  // "on-elsewhere" and "stale" are OFF for this phone - the toggle must offer
  // to fix THIS device, which is exactly what enable() now does.
  const canToggle =
    state === "on" || state === "off" || state === "busy" || state === "on-elsewhere" || state === "stale";

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
      case "on-elsewhere":
        // The field failure, named: the account has alerts, THIS phone does not.
        return t("Alerts are on for another device, but not this one - turn them on here to get notified on this phone.");
      case "stale":
        return t("This phone's alert registration is out of date (that happens after an update) - tap to fix it.");
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
      {(state === "on-elsewhere" || state === "stale") && (
        <button
          onClick={() => enable()}
          className="btn btn-sm mt-2 w-full rounded-xl bg-brandblue py-2 text-[12px] font-extrabold text-white"
        >
          📲 {t("Fix alerts on this phone")}
        </button>
      )}
      {/* PROVE IT. Nothing else in the UI can tell "registered" from
          "arriving" - this sends a real push and reports what happened. */}
      {(state === "on" || state === "on-elsewhere" || state === "stale") && (
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => test()}
            className="btn btn-sm flex-1 rounded-xl border-2 border-line py-2 text-[11.5px] font-extrabold text-soft"
          >
            {t("Send test alert")}
          </button>
          {devices > 1 && (
            <button
              onClick={() => disableEverywhere()}
              className="btn btn-sm flex-1 rounded-xl border-2 border-line py-2 text-[11.5px] font-extrabold text-soft"
            >
              {t("Turn off everywhere")}
            </button>
          )}
        </div>
      )}
      {note && <p className="mt-1 text-[11px] font-bold text-brandred">{note}</p>}
    </section>
  );
}
