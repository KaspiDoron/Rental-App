// Honest attribution for Google-sourced shop data (Places results come from
// the Google Maps Platform). Rendered as the recognizable multi-colour
// wordmark so users trust the data source - NOT slapped on the map tiles
// (those are CARTO/OSM and carry their own attribution). Attribution of real
// Google data, never an endorsement claim.

const LETTER_COLORS = ["#4285F4", "#EA4335", "#FBBC05", "#4285F4", "#34A853", "#EA4335"];

export function GoogleWordmark({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex select-none items-baseline font-bold leading-none tracking-tight ${className}`}
      style={{ fontFamily: "Arial, Helvetica, sans-serif" }}
      aria-label="Google"
      role="img"
    >
      {"Google".split("").map((ch, i) => (
        <span key={i} style={{ color: LETTER_COLORS[i] }}>
          {ch}
        </span>
      ))}
    </span>
  );
}
