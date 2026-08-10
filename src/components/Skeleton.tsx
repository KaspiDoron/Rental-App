// Shimmering placeholder blocks shown while a section's data is still loading,
// so the user always sees the page taking shape instead of a blank gap or a
// bare "loading..." line.
//
// The card wears the same glass the real cards wear, so a loading screen is the
// finished screen with its contents still arriving - not a different, greyer
// screen that swaps out. That is what makes the settle feel like one continuous
// surface rather than a flash.
//
// M5/M16: the Aurora glow is composed ON these, not built beside them. The
// shimmer says "this block is a placeholder"; the glow says "the system is
// working on it". They answer different questions and stack cleanly because
// they use different pseudo-elements.

import { aurora } from "../lib/aurora";

export function Skeleton({
  className = "",
  rounded = "rounded-xl",
}: {
  className?: string;
  rounded?: string;
}) {
  return <div className={`skeleton ${rounded} ${className}`} aria-hidden="true" />;
}

/**
 * A card-shaped placeholder that mirrors the app's surface cards.
 *
 * `glow` is opt-out rather than opt-in: a skeleton card is by definition a
 * surface with work behind it, so the default should be the honest one. The
 * escape hatch exists for the few places that stack many cards at once, where
 * a glow per card would be noise rather than signal.
 */
export function SkeletonCard({ lines = 3, glow = true }: { lines?: number; glow?: boolean }) {
  return (
    <div
      className={`glass-solid glass-rim fluid-in rounded-blob p-4 ${aurora(glow)}`}
      aria-hidden="true"
    >
      <Skeleton className="mb-2 h-4 w-1/3" />
      <Skeleton className="mb-3 h-3 w-2/3" />
      <div className="space-y-2">
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton key={i} className="h-3 w-full" />
        ))}
      </div>
    </div>
  );
}

/**
 * A stack of placeholder cards for a whole tab/section that is still loading.
 *
 * ONLY THE FIRST CARD GLOWS. Ten glowing cards is a light show, not a status -
 * the eye reads the leading edge of a list as "where the work is", and the rest
 * as the shape still to fill in. One signal, at the top, is the whole point of
 * having one primitive.
 */
export function SkeletonList({ count = 3, lines = 3 }: { count?: number; lines?: number }) {
  return (
    <div className="space-y-3" role="status" aria-label="Loading">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} lines={lines} glow={i === 0} />
      ))}
    </div>
  );
}
