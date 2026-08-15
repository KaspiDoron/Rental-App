"use client";

// The app-wide inline loading indicator: three breathing dots, in the greys of
// the background.
//
// NO BRAND HUE, BY RULE (Loading v4). These went from three different brand
// hues (a small rainbow) to one brand hue on a lightness ramp, and now to no
// hue at all: the owner's instruction was to take the blue out of the loading
// components completely and let the ambient wash behind the app carry every
// colour. The ramp survives, because the ramp was never the problem - three
// dots walked deep -> mid -> light in oklch read as one material with depth,
// which is exactly as true of a neutral as it was of a blue.
//
// There are roughly sixty LoadingDots sites in this app - inline, in buttons,
// inside list rows. That is the other reason they stay this cheap: three
// background-colours and one keyframe, no gradients, no blur, nothing that
// asks the phone for a composite layer per row.
const DOT_RAMP = [
  // Deep -> mid -> light: one neutral, three oklch lightness steps.
  "color-mix(in oklch, var(--wd-load-ink) 78%, #000)",
  "var(--wd-load-ink)",
  "color-mix(in oklch, var(--wd-load-ink) 72%, #fff)",
];
export function LoadingDots({
  label,
  className = "",
  light = false,
}: {
  label?: string;
  className?: string;
  light?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-2 ${className}`}
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={label || "Loading"}
    >
      <span className="inline-flex items-end gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="wd-dot-breathe h-1.5 w-1.5 rounded-full"
            style={{
              // `light` still wins outright: on a dark or coloured backdrop the
              // hue ramp loses contrast, and legibility outranks family
              // resemblance every time.
              background: light ? "#ffffff" : DOT_RAMP[i],
              // NEGATIVE, so the three dots start already mid-cycle instead of
              // lighting up in a visible left-to-right row on the first frame.
              animationDelay: `${-0.45 + i * 0.18}s`,
            }}
          />
        ))}
      </span>
      {label && (
        <span className={`text-[13px] font-bold ${light ? "text-white" : "text-soft"}`}>
          {label}
        </span>
      )}
    </span>
  );
}
