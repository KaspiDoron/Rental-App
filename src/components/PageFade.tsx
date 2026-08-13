"use client";

import { usePathname } from "next/navigation";

// THE CANVAS, KEYED PER ROUTE.
//
// `page-fade` is a mount animation: under full-document navigation every page
// load was a fresh document so it always ran, but with client-side tab hops
// the canvas div persists and the fade never fires again - the new page pops.
// Keying the div on the pathname remounts it per route, so each landing eases
// in exactly like a cold load.
//
// THE ONE HARD RULE (inherited from the canvas): this element must NEVER
// carry a transform, a filter, or an animation that leaves one behind - it
// would become the containing block for every `position: fixed` descendant,
// which is the mid-screen-TabBar defect class. `page-fade` animates opacity
// only; chrome-layout.test.ts pins it.
export function PageFade({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div key={pathname} className="app-canvas page-fade">
      {children}
    </div>
  );
}
