"use client";

// The alerts control that lives INSIDE the waiting panel on Find Deals.
//
// It used to be a one-way street: a "🔔 Notify me" button that, once tapped,
// became a dead green "✅ Alerts on" label with no way back. Turning alerts off
// meant finding the toggle on the Profile screen - and the two surfaces kept
// their own state, so they could disagree about whether alerts were even on.
//
// Now both read the same controller (`usePushAlerts`, whose truth is the
// push_subscriptions row on the server), and this one is a real switch: on,
// off, and honest about every state in between.

import { usePushAlerts } from "@/lib/use-push";
import { LoadingDots } from "./LoadingDots";

export function AlertsChip({ t }: { t: (s: string) => string }) {
  const { state, devices, note, enable, disable } = usePushAlerts();

  // Nothing to offer: the server has no push keys, or this browser cannot.
  // Say so quietly rather than lead the traveller to a dead end.
  if (state === "unconfigured") return null;

  const on = state === "on";
  const busy = state === "busy" || state === "loading";
  const blocked = state === "denied" || state === "unsupported" || state === "ios-install";

  const label = (() => {
    if (busy) return null;
    if (on) return `🔔 ${t("Alerts on")} · ${t("tap to turn off")}`;
    if (state === "ios-install") return `🔔 ${t("Add to Home Screen for alerts")}`;
    if (state === "unsupported") return `🔔 ${t("Alerts need Chrome or the installed app")}`;
    if (state === "denied") return `🔔 ${t("Alerts blocked in your browser")}`;
    return `🔔 ${t("Alert me when a shop replies")}`;
  })();

  return (
    <>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        disabled={busy || blocked}
        onClick={() => (on ? disable() : enable())}
        className={`btn btn-sm flex items-center gap-1.5 rounded-xl px-2.5 py-1 text-[11px] font-extrabold transition disabled:opacity-60 ${
          on
            ? "bg-savings text-white"
            : blocked
              ? "border-2 border-line text-faint"
              : "border-2 border-brandblue text-brandblue"
        }`}
      >
        {busy ? <LoadingDots label={t("Working")} /> : label}
        {/* A real switch reads as a switch - the little track makes the OFF
            state discoverable instead of looking like a finished action. */}
        {!blocked && !busy && (
          <span
            aria-hidden
            className={`relative ml-0.5 inline-block h-3.5 w-6 shrink-0 rounded-full ${
              on ? "bg-white/35" : "bg-line"
            }`}
          >
            <span
              className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white shadow transition-all ${
                on ? "left-[13px]" : "left-0.5"
              }`}
            />
          </span>
        )}
      </button>
      {on && devices > 1 && (
        <span className="self-center text-[10px] font-bold text-brandblue/80">
          {devices} {t("devices")}
        </span>
      )}
      {note && (
        <p className="mt-1 w-full text-[10px] font-bold text-brandblue/80">{note}</p>
      )}
    </>
  );
}
