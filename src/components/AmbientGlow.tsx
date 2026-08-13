"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

// THE PAGE-LEVEL GLOW'S ONE MOUNT (owner report 3, item 5).
//
// `.wd-ambient` shipped as dead CSS: the stylesheet was tested, the class was
// referenced by nothing, and the premium loading wash the owner asked for
// never painted a single frame. This component is the mount, permanent in the
// root layout, driven by a NavVeil-style module store so any raiser anywhere
// (search dispatch, mass bargain, route transitions) can turn it on without
// prop-drilling through the tree.
//
// REF-COUNTED, not boolean: two overlapping waits (a search while a route
// loads) must not have the first `lower` kill the second wait's glow. And
// because a leaked `raise` would leave the wash on forever, three escape
// hatches reset the count outright: route landed (pathname change), bfcache
// restore (pageshow), and a 30s timeout - long enough for a real hunt
// dispatch, short enough that a leak is a blip. The glow itself is
// pointer-transparent, so unlike NavVeil a stale ambient never BLOCKS
// anything; the escapes are cosmetic honesty, not an unsticking mechanism.

type Listener = (count: number) => void;
let count = 0;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l(count));

/** Turn the ambient wash on (pair every call with lowerAmbient). */
export function raiseAmbient() {
  count++;
  emit();
}

/** Release one raise; the wash eases out when the last one goes. */
export function lowerAmbient() {
  count = Math.max(0, count - 1);
  emit();
}

function resetAmbient() {
  count = 0;
  emit();
}

export function AmbientGlow() {
  const [on, setOn] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    const l: Listener = (n) => setOn(n > 0);
    listeners.add(l);
    const onShow = () => resetAmbient();
    window.addEventListener("pageshow", onShow);
    return () => {
      listeners.delete(l);
      window.removeEventListener("pageshow", onShow);
    };
  }, []);

  // The route landed - whatever raised for the transition is done.
  useEffect(() => {
    resetAmbient();
  }, [pathname]);

  useEffect(() => {
    if (!on) return;
    const t = setTimeout(() => resetAmbient(), 30_000);
    return () => clearTimeout(t);
  }, [on]);

  // Always mounted: visibility is a class toggle, so the ease-out transition
  // has an element to run on (an unmount would pop it off in one frame).
  return <div aria-hidden className={`wd-ambient ${on ? "wd-ambient-on" : ""}`} />;
}
