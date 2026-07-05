// Shimmering placeholder blocks shown while a section's data is still loading,
// so the user always sees the page taking shape instead of a blank gap or a
// bare "loading..." line. Uses the .skeleton shimmer defined in globals.css.

export function Skeleton({
  className = "",
  rounded = "rounded-xl",
}: {
  className?: string;
  rounded?: string;
}) {
  return <div className={`skeleton ${rounded} ${className}`} aria-hidden="true" />;
}

/** A card-shaped placeholder that mirrors the app's surface cards. */
export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  return (
    <div className="surface rounded-blob p-4" aria-hidden="true">
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

/** A stack of placeholder cards for a whole tab/section that is still loading. */
export function SkeletonList({ count = 3, lines = 3 }: { count?: number; lines?: number }) {
  return (
    <div className="space-y-3" role="status" aria-label="Loading">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} lines={lines} />
      ))}
    </div>
  );
}
