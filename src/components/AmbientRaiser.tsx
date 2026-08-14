"use client";

import { useEffect } from "react";
import { lowerAmbient, raiseAmbient } from "./AmbientGlow";

// THE AMBIENT'S CLIENT LEAF (owner report 4, item 9). The route-level
// loading.tsx files are server components - they cannot call raiseAmbient()
// themselves, which is why hard navigations and RSC suspense showed the
// heartbeat with NO wash behind it while every client-side raiser glowed.
// Rendering this leaf inside them (and inside any other big loading state)
// turns the wash on for exactly the lifetime of the fallback; AmbientGlow's
// own escape hatches (pathname change, pageshow, 30s cap) cover a leaked
// unmount, so this cannot strand the glow.
export function AmbientRaiser() {
  useEffect(() => {
    raiseAmbient();
    return () => lowerAmbient();
  }, []);
  return null;
}
