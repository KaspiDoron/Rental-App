// Shimmering placeholder blocks shown while a section's data is still loading,
// so the user always sees the page taking shape instead of a blank gap or a
// bare "loading..." line.
//
// The card wears the same glass the real cards wear, so a loading screen is the
// finished screen with its contents still arriving - not a different, greyer
// screen that swaps out. That is what makes the settle feel like one continuous
// surface rather than a flash.
//
// THE GLOW IS GONE, AND THE PLACEHOLDER IS BETTER FOR IT.
//
// These cards used to wear a coloured "aurora" bloom whose job was to say "the
// system is working on it" while the shimmer said "this block is a
// placeholder". Two signals, one surface, and the owner's verdict on the
// coloured one was final. What replaced it is not a quieter glow but a better
// plate: .skeleton is now a material - a lit top edge, a soft top-down grade,
// and a raking sheen - which says both things at once, in the greys of the
// background, at a fraction of the paint cost. Colour now lives only in the
// page-level ambient wash behind the whole app.

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
 * The `glow` prop is gone rather than deprecated. It selected between two
 * visual states of a thing that no longer exists, and a prop that silently
 * does nothing is worse than a compile error at every call site - this
 * codebase has been bitten more than once by a value that was still being
 * passed long after anything read it.
 */
export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="glass-solid glass-rim fluid-in rounded-blob p-4" aria-hidden="true">
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
 * EVERY CARD IS IDENTICAL, AND THAT IS THE POINT. The old stack singled the
 * first card out with a glow, on the reasoning that ten glowing cards is a
 * light show. With the glow gone the correct arrangement is the one every
 * shipped design system converges on: one plate, one sheen, one duration, no
 * per-card offsets. A stack of placeholders sweeping in unison reads as a
 * single surface still resolving; the same stack sweeping out of step reads as
 * a page that cannot make up its mind.
 */
export function SkeletonList({ count = 3, lines = 3 }: { count?: number; lines?: number }) {
  return (
    <div className="space-y-3" role="status" aria-label="Loading">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} lines={lines} />
      ))}
    </div>
  );
}
