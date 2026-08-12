"use client";

// The app-wide inline loading indicator: three bouncing dots, in the brand hue.
//
// WHY THESE DO NOT CARRY THE GLOW. There are roughly sixty LoadingDots sites in
// this app - inline, in buttons, inside list rows. Giving each one a conic
// gradient under an 18px blur would be sixty full-glow elements competing for
// repaint on the phone this product is built for, and visually it would be a
// light show rather than a status.
//
// They join the family by COLOUR instead: each dot takes one stop from the same
// brand-seeded hue set the aurora sweeps through, so an inline wait reads as
// the same system as the heartbeat on the search screen - at the cost of three
// background-color declarations. The heavy signal stays where it means
// something: one per screen, on the surface actually doing the work.
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
              // hue stops lose contrast, and legibility outranks family
              // resemblance every time.
              background: light ? "#ffffff" : `var(--wd-hue-${i + 1})`,
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
