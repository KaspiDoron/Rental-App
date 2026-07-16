"use client";

// Will as a persistent, LIVING companion on the edge of the screen - the one
// Will entry point everywhere (the old bottom composer is gone; the TabBar is
// the primary bottom element again). He blinks, looks around, waves every
// ~35s, thinks while the agents work, celebrates when a deal improves, dozes
// off when nothing happens for a while, and boops when tapped. Never blocks
// content (sits above the TabBar, half outside the screen), dismissible for
// the session with one tap on ×.

import { useEffect, useRef, useState } from "react";
import { WillAvatar, type WillMood } from "./WillAvatar";
import { startNav } from "../NavVeil";
import { useI18n } from "@/lib/i18n";

const HIDE_KEY = "wd_will_companion";
const SLEEP_AFTER_MS = 90_000;

export function WillCompanion({
  note,
  alert = false,
  busy = false,
  celebrateKey,
  onOpen,
}: {
  /** A short contextual line Will says in a bubble (auto-hides). */
  note?: string;
  /** Something needs the user - show the attention dot and keep the bubble. */
  alert?: boolean;
  /** The agents are actively working - Will thinks along. */
  busy?: boolean;
  /** Bump this number when something worth celebrating happens (new offer). */
  celebrateKey?: number;
  /** Where a tap leads. Default: back to the workspace with the chat open. */
  onOpen?: () => void;
}) {
  const { t } = useI18n();
  const [hidden, setHidden] = useState(true);
  const [bubble, setBubble] = useState(false);
  const [celebrating, setCelebrating] = useState(false);
  const [asleep, setAsleep] = useState(false);
  const [boop, setBoop] = useState(false);
  const lastCelebrate = useRef<number | undefined>(celebrateKey);
  const sleepTimer = useRef<ReturnType<typeof setTimeout>>();

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
    setBubble(false);
    const show = setTimeout(() => setBubble(true), 1200);
    const hide = alert ? null : setTimeout(() => setBubble(false), 10_000);
    return () => {
      clearTimeout(show);
      if (hide) clearTimeout(hide);
    };
  }, [note, alert]);

  // Celebrate for a few seconds whenever the key increases (a better offer,
  // a locked deal) - joy with a purpose, then back to work.
  useEffect(() => {
    if (celebrateKey == null) return;
    const prev = lastCelebrate.current;
    lastCelebrate.current = celebrateKey;
    if (prev != null && celebrateKey > prev) {
      setCelebrating(true);
      setAsleep(false);
      const id = setTimeout(() => setCelebrating(false), 6_000);
      return () => clearTimeout(id);
    }
  }, [celebrateKey]);

  // Doze off when nothing has happened for a while; anything lively wakes him.
  useEffect(() => {
    clearTimeout(sleepTimer.current);
    if (busy || alert || celebrating) {
      setAsleep(false);
      return;
    }
    sleepTimer.current = setTimeout(() => setAsleep(true), SLEEP_AFTER_MS);
    return () => clearTimeout(sleepTimer.current);
  }, [busy, alert, celebrating, note, celebrateKey]);

  if (hidden) return null;

  const mood: WillMood = celebrating
    ? "celebrating"
    : busy
      ? "thinking"
      : asleep
        ? "sleeping"
        : "idle";

  const open = () => {
    // Tap: a delighted boop, wake up, then act.
    setBoop(true);
    setAsleep(false);
    setTimeout(() => setBoop(false), 550);
    if (onOpen) {
      onOpen();
      return;
    }
    startNav();
    window.location.href = "/?will=1";
  };

  return (
    <div
      data-tour="will"
      className="fixed right-0 z-40 flex flex-col items-end"
      style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 96px)" }}
    >
      {bubble && note && (
        <button
          onClick={open}
          className="relative mb-1.5 mr-3 max-w-[230px] rounded-2xl rounded-br-md bg-card2/95 px-3 py-2 text-left text-[11px] font-bold leading-snug text-soft shadow-lg backdrop-blur animate-slide-up"
        >
          {note}
          <span aria-hidden className="absolute -bottom-1 right-4 h-2 w-2 rotate-45 bg-card2/95" />
        </button>
      )}
      <div className="relative mr-[-10px]">
        <button
          onClick={open}
          aria-label={t("Open Will")}
          className={`block transition-transform ${boop ? "will-boop" : "active:scale-95"}`}
        >
          <WillAvatar size={54} mood={mood} className="drop-shadow-xl" />
          {busy && !celebrating && (
            <span className="absolute -left-0.5 top-0.5 h-2.5 w-2.5 animate-ping rounded-full bg-brandyellow" />
          )}
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
