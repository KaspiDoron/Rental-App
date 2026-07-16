"use client";

// Will as a persistent companion on pages that don't carry the full dock
// (My deals, Profile). He peeks in from the right edge - blinking, waving,
// occasionally saying something useful - and one tap brings you back to the
// workspace with his chat open. Never blocks content (sits above the TabBar,
// half outside the screen), dismissible for the session with one tap on ×.

import { useEffect, useState } from "react";
import { WillAvatar } from "./WillAvatar";
import { startNav } from "../NavVeil";
import { useI18n } from "@/lib/i18n";

const HIDE_KEY = "wd_will_companion";

export function WillCompanion({
  note,
  alert = false,
}: {
  /** A short contextual line Will says in a bubble (auto-hides). */
  note?: string;
  /** Something needs the user - show the attention dot and keep the bubble. */
  alert?: boolean;
}) {
  const { t } = useI18n();
  const [hidden, setHidden] = useState(true);
  const [bubble, setBubble] = useState(false);

  useEffect(() => {
    try {
      setHidden(sessionStorage.getItem(HIDE_KEY) === "off");
    } catch {
      setHidden(false);
    }
  }, []);

  // The bubble appears after a beat and quietly leaves unless it's an alert.
  useEffect(() => {
    if (!note) return;
    const show = setTimeout(() => setBubble(true), 1200);
    const hide = alert ? null : setTimeout(() => setBubble(false), 10_000);
    return () => {
      clearTimeout(show);
      if (hide) clearTimeout(hide);
    };
  }, [note, alert]);

  if (hidden) return null;

  const open = () => {
    startNav();
    window.location.href = "/?will=1";
  };

  return (
    <div
      className="fixed right-0 z-40 flex flex-col items-end"
      style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 96px)" }}
    >
      {bubble && note && (
        <button
          onClick={open}
          className="relative mb-1.5 mr-3 max-w-[220px] rounded-2xl rounded-br-md bg-card2/95 px-3 py-2 text-left text-[11px] font-bold leading-snug text-soft shadow-lg backdrop-blur animate-slide-up"
        >
          {note}
          <span aria-hidden className="absolute -bottom-1 right-4 h-2 w-2 rotate-45 bg-card2/95" />
        </button>
      )}
      <div className="relative mr-[-10px]">
        <button
          onClick={open}
          aria-label={t("Open Will")}
          className="block transition-transform active:scale-95"
        >
          <WillAvatar size={54} className="drop-shadow-xl" />
          {alert && (
            <span className="absolute left-0 top-0.5 flex h-3 w-3">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brandred opacity-60" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-brandred" />
            </span>
          )}
        </button>
        <button
          onClick={() => {
            try {
              sessionStorage.setItem(HIDE_KEY, "off");
            } catch {}
            setHidden(true);
          }}
          aria-label={t("Hide Will")}
          className="absolute -left-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-card2 text-[10px] font-bold text-faint shadow"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
