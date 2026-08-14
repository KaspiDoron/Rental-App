"use client";

// The app-wide inline loading indicator: three breathing dots, in the brand hue.
//
// WHY THESE DO NOT CARRY THE GLOW. There are roughly sixty LoadingDots sites in
// this app - inline, in buttons, inside list rows. Giving each one a conic
// gradient under an 18px blur would be sixty full-glow elements competing for
// repaint on the phone this product is built for, and visually it would be a
// light show rather than a status.
//
// ONE HUE, A LIGHTNESS RAMP (Loading v3). The dots used to take three DIFFERENT
// brand hues (--wd-hue-1/2/3) - the same rainbow tell the owner named on the
// aurora, just smaller. Now all three are ONE hue (--wd-hue-1) walked across
// three oklch lightness steps (deep -> pure -> light), so the row reads as one
// premium colour with depth rather than a traffic light, and still ties to the
// single-hue horizon on the search screen. The heavy signal stays where it
// means something: one horizon per screen, on the surface doing the work.
const DOT_RAMP = [
  // Deep -> pure -> light: one hue, three oklch lightness steps.
  "color-mix(in oklch, var(--wd-hue-1) 82%, #000)",
  "var(--wd-hue-1)",
  "color-mix(in oklch, var(--wd-hue-1) 78%, #fff)",
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
