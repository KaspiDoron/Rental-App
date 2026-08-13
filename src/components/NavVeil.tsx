"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { BrandPulseVeil } from "./BrandPulse";
import { raiseAmbient, lowerAmbient } from "./AmbientGlow";

// Global navigation veil: instant visual feedback the moment ANY page change
// or heavy button action starts. Mounted once in the root layout; triggered
// from anywhere with startNav(). Clears itself when the route actually
// changes, on page show (bfcache restores) and on a safety timeout, so it can
// never get stuck.

type Listener = (on: boolean) => void;
const listeners = new Set<Listener>();

/** Show the global loading veil (auto-clears on route change / timeout). */
export function startNav() {
  // The whole-screen wash rides along: a navigation is exactly the wait the
  // ambient exists for. AmbientGlow clears itself on route-landed/pageshow,
  // so the pair cannot leak even when stopNav is never called.
  raiseAmbient();
  listeners.forEach((l) => l(true));
}

/** Hide the veil immediately (e.g. an action failed and we stay put). */
export function stopNav() {
  lowerAmbient();
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
  // ONE ANSWER TO "SOMETHING IS HAPPENING", EVERYWHERE. The exact component
  // the route-level loading.tsx files render, at the veil rung (a navigation
  // veil must cover open dialogs - the page under them is leaving).
  return <BrandPulseVeil size={58} layer="layer-veil" />;
}
