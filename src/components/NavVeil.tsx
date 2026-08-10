"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { OrbitDots } from "./OrbitDots";
import { AURORA } from "../lib/aurora";

// Global navigation veil: instant visual feedback the moment ANY page change
// or heavy button action starts. Mounted once in the root layout; triggered
// from anywhere with startNav(). Clears itself when the route actually
// changes, on page show (bfcache restores) and on a safety timeout, so it can
// never get stuck.

type Listener = (on: boolean) => void;
const listeners = new Set<Listener>();

/** Show the global loading veil (auto-clears on route change / timeout). */
export function startNav() {
  listeners.forEach((l) => l(true));
}

/** Hide the veil immediately (e.g. an action failed and we stay put). */
export function stopNav() {
  listeners.forEach((l) => l(false));
}

export function NavVeil() {
  const [on, setOn] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    const l: Listener = (v) => setOn(v);
    listeners.add(l);
    // bfcache restore (iOS back-swipe) re-shows the old page: clear the veil.
    const onShow = () => setOn(false);
    window.addEventListener("pageshow", onShow);
    return () => {
      listeners.delete(l);
      window.removeEventListener("pageshow", onShow);
    };
  }, []);

  // Route change = navigation done.
  useEffect(() => {
    setOn(false);
  }, [pathname]);

  // Safety valve: never let the veil block the app for more than 8s.
  useEffect(() => {
    if (!on) return;
    const t = setTimeout(() => setOn(false), 8000);
    return () => clearTimeout(t);
  }, [on]);

  if (!on) return null;
  return (
    <div className="fixed inset-0 z-[1400] flex items-center justify-center bg-black/35 backdrop-blur-[2px]">
      {/* M5/M16: the veil's spinner wears the SAME glow the skeleton cards
          wear, so the whole app has one visual answer to "something is
          happening" instead of a different one per surface. The glow is on a
          wrapper rather than on OrbitDots itself - the dots are also used in
          places that are not loading states, and a primitive that cannot be
          used without its glow is not a primitive. */}
      <div className={`${AURORA} rounded-full p-3`}>
        <OrbitDots size={44} light label="Loading" />
      </div>
    </div>
  );
}
