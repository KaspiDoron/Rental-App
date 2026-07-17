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

// Dismissal is a NAP, never a disappearance: Will is a core surface of the
// product, so ✕ hides him for 20 minutes and he quietly returns (a permanent
// per-session hide once made him vanish with no way back - a regression a
// real user hit). New key name deliberately ignores the old "off" flag.
const NAP_KEY = "wd_will_nap_until";
const NAP_MS = 20 * 60_000;
const SLEEP_AFTER_MS = 90_000;

// Draggable companion: position persists across visits (localStorage), snaps
// to the nearest screen edge on release, and always stays clear of the TabBar
// and safe areas. A quick tap still opens Will - drag starts only after the
// pointer moves past a small threshold, so the two gestures never fight.
const POS_KEY = "wd_will_pos";
const DRAG_THRESHOLD_PX = 8;
const TABBAR_CLEARANCE = 96; // px above the bottom safe area (TabBar height + gap)
const TOP_CLEARANCE = 72;

interface WillPos {
  side: "left" | "right";
  /** Distance from the bottom safe-area edge, px. */
  bottom: number;
}

function loadPos(): WillPos {
  try {
    const raw = JSON.parse(localStorage.getItem(POS_KEY) ?? "null") as WillPos | null;
    if (raw && (raw.side === "left" || raw.side === "right") && Number.isFinite(raw.bottom)) {
      return { side: raw.side, bottom: clampBottom(raw.bottom) };
    }
  } catch {}
  return { side: "right", bottom: TABBAR_CLEARANCE };
}

function clampBottom(b: number): number {
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  return Math.min(Math.max(b, TABBAR_CLEARANCE), Math.max(TABBAR_CLEARANCE, vh - TOP_CLEARANCE - 80));
}

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

  // ---- drag state ----------------------------------------------------------
  const [pos, setPos] = useState<WillPos>({ side: "right", bottom: TABBAR_CLEARANCE });
  const [dragging, setDragging] = useState(false);
  // Live pixel offset while dragging (transform, GPU-cheap); null when parked.
  const [dragXY, setDragXY] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    moved: boolean;
    pointerId: number;
  } | null>(null);
  const reduceMotion = useRef(false);

  useEffect(() => {
    setPos(loadPos());
    try {
      reduceMotion.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {}
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    dragRef.current = { startX: e.clientX, startY: e.clientY, moved: false, pointerId: e.pointerId };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    if (!d.moved) {
      d.moved = true;
      setDragging(true);
      setBubble(false);
    }
    setDragXY({ x: dx, y: dy });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(d.pointerId);
    } catch {}
    if (!d.moved) {
      // A tap, not a drag - open Will as always.
      open();
      return;
    }
    // Park: snap to the nearest horizontal edge, clamp vertically, persist.
    const vw = window.innerWidth;
    const side: WillPos["side"] = e.clientX < vw / 2 ? "left" : "right";
    const nextBottom = clampBottom(pos.bottom - (e.clientY - d.startY));
    const next: WillPos = { side, bottom: nextBottom };
    setDragXY(null);
    setDragging(false);
    setPos(next);
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(next));
    } catch {}
  };

  useEffect(() => {
    let wake: ReturnType<typeof setTimeout> | undefined;
    try {
      const until = Number(sessionStorage.getItem(NAP_KEY) ?? 0);
      const napping = Number.isFinite(until) && until > Date.now();
      setHidden(napping);
      // He comes back on his own when the nap ends - never gone for good.
      if (napping) wake = setTimeout(() => setHidden(false), until - Date.now());
    } catch {
      setHidden(false);
    }
    return () => clearTimeout(wake);
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

  const onLeft = pos.side === "left";
  return (
    <div
      data-tour="will"
      className={`fixed z-[60] flex flex-col ${onLeft ? "left-0 items-start" : "right-0 items-end"} ${
        dragging || reduceMotion.current ? "" : "transition-all duration-300 ease-out"
      }`}
      style={{
        bottom: `calc(env(safe-area-inset-bottom, 0px) + ${pos.bottom}px)`,
        transform: dragXY ? `translate(${dragXY.x}px, ${dragXY.y}px)` : undefined,
        // Only the companion itself refuses touch scrolling - the page keeps
        // scrolling normally everywhere else.
        touchAction: "none",
      }}
    >
      {bubble && note && !dragging && (
        <button
          onClick={open}
          className={`relative mb-1.5 max-w-[230px] rounded-2xl bg-card2/95 px-3 py-2 text-left text-[11px] font-bold leading-snug text-soft shadow-lg backdrop-blur animate-slide-up ${
            onLeft ? "ml-3 rounded-bl-md" : "mr-3 rounded-br-md"
          }`}
        >
          {note}
          <span
            aria-hidden
            className={`absolute -bottom-1 h-2 w-2 rotate-45 bg-card2/95 ${onLeft ? "left-4" : "right-4"}`}
          />
        </button>
      )}
      <div className={`relative ${onLeft ? "ml-[-10px]" : "mr-[-10px]"}`}>
        <button
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            dragRef.current = null;
            setDragXY(null);
            setDragging(false);
          }}
          aria-label={t("Open Will (drag to move him)")}
          className={`block ${dragging ? "cursor-grabbing scale-110" : "transition-transform"} ${
            boop ? "will-boop" : dragging ? "" : "active:scale-95"
          }`}
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
              sessionStorage.setItem(NAP_KEY, String(Date.now() + NAP_MS));
            } catch {}
            setHidden(true);
          }}
          aria-label={t("Hide Will for a bit")}
          title={t("Hide Will for 20 minutes")}
          className={`absolute -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-card2 text-[10px] font-bold text-faint shadow ${
            onLeft ? "-right-2" : "-left-2"
          }`}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
