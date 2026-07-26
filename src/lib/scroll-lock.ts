// One shared, ref-counted, iOS-safe body scroll-lock (Bug 5).
//
// The old bug: five components (Modal, Onboarding, WaitGame, PhotoGallery,
// MapView) each did `document.body.style.overflow='hidden'` and restored it
// blindly on unmount. With overlapping/nested overlays their restores desynced,
// and - worse - toggling `overflow` on a scrolled page is the documented iOS
// WebKit trigger for `position:fixed` elements (the TabBar) rendering at a
// stale scroll offset, i.e. floating mid-screen.
//
// The fix: a single lock that (a) ref-counts, so N overlays share one lock and
// the body only unlocks when the LAST one releases; and (b) uses the iOS-safe
// technique - pin the body with `position:fixed; top:-scrollY` while locked and
// restore the exact scroll position on release. This keeps the visual scroll
// position AND stops WebKit from ever recompositing fixed elements against a
// stale viewport.

let locks = 0;
let savedScrollY = 0;
let saved: {
  overflow: string;
  position: string;
  top: string;
  width: string;
  left: string;
  right: string;
} | null = null;

function isBrowser(): boolean {
  return typeof document !== "undefined" && typeof window !== "undefined";
}

/** Acquire the shared lock. Returns a release fn - call it exactly once. */
export function lockBodyScroll(): () => void {
  if (!isBrowser()) return () => {};

  if (locks === 0) {
    const body = document.body;
    savedScrollY = window.scrollY || window.pageYOffset || 0;
    saved = {
      overflow: body.style.overflow,
      position: body.style.position,
      top: body.style.top,
      width: body.style.width,
      left: body.style.left,
      right: body.style.right,
    };
    // NOTE the missing `overflow: hidden`. Pinning the body with
    // `position: fixed` already makes the document unscrollable, and toggling
    // `overflow` on a scrolled page is the exact WebKit trigger this file was
    // written to avoid - it came back as "the nav bar jumped into the middle of
    // the screen". The overflow value is still saved/restored below so an
    // older inline style set by anything else survives a lock cycle.
    body.style.position = "fixed";
    body.style.top = `-${savedScrollY}px`;
    body.style.left = "0";
    body.style.right = "0";
    body.style.width = "100%";
  }
  locks += 1;

  let released = false;
  return () => {
    if (released) return; // idempotent - a double release must not underflow
    released = true;
    locks = Math.max(0, locks - 1);
    if (locks === 0 && isBrowser()) {
      const body = document.body;
      if (saved) {
        body.style.overflow = saved.overflow;
        body.style.position = saved.position;
        body.style.top = saved.top;
        body.style.width = saved.width;
        body.style.left = saved.left;
        body.style.right = saved.right;
        saved = null;
      }
      // Restore the exact pre-lock scroll position.
      window.scrollTo(0, savedScrollY);
    }
  };
}
