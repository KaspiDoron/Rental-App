"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { BrandPulse } from "./BrandPulse";

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
    <div className="wd-loader-veil layer-veil fixed inset-0 flex items-center justify-center">
      {/* ONE ANSWER TO "SOMETHING IS HAPPENING", EVERYWHERE.
          This used to be orbiting dots inside the glow, on a flat black scrim -
          a second loading vocabulary sitting next to the skeletons' one. It is
          now the same heartbeat the search screen shows, on the same blurred
          veil, so a route change and a search read as the same system working
          rather than as two different apps. The veil blurs the page instead of
          blacking it out: the app is still there, just out of focus. */}
      <BrandPulse size={58} />
    </div>
  );
}
