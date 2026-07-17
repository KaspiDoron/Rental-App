// Shared time formatting - `toLocaleTimeString([], { hour: "2-digit",
// minute: "2-digit" })` was hand-repeated across 11 sites / 8 files.
// Isomorphic + dependency-free.

/** "14:32" (locale-aware) from an ISO string, Date or epoch ms. */
export function formatClock(at: string | number | Date | null | undefined): string {
  if (at == null) return "";
  const d = at instanceof Date ? at : new Date(at);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
