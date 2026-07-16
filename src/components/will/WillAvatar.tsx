// Will's face - a tiny, alive SVG companion in WheelDeal brand colors.
// Pure CSS keyframes drive the life (occasional blink + look-around, a wave
// every ~35s, glowing antenna) - defined in globals.css with
// prefers-reduced-motion guards, so this component stays server-safe and
// dependency-free.
//
// Moods (className hooks, no JS animation):
//   idle        - blink, look around, occasional wave
//   thinking    - darting eyes + fast antenna (agents are working)
//   sleeping    - eyes closed, no wave, slow antenna (long-idle)
//   celebrating - fast wave + happy bounce (a deal just improved)

export type WillMood = "idle" | "thinking" | "sleeping" | "celebrating";

export function WillAvatar({
  size = 44,
  wave = true,
  mood = "idle",
  className = "",
}: {
  size?: number;
  /** Show the little waving hand (off for very small or busy contexts). */
  wave?: boolean;
  mood?: WillMood;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={`will-mood-${mood} ${className}`}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="willHeadGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7cb0ff" />
          <stop offset="1" stopColor="#3b82f6" />
        </linearGradient>
      </defs>
      {/* waving arm - drawn first so it peeks out from behind the head */}
      {wave && mood !== "sleeping" && (
        <g className="will-arm">
          <rect x="52" y="30" width="7" height="17" rx="3.5" fill="#3b82f6" />
          <circle cx="55.5" cy="27.5" r="5.2" fill="#7cb0ff" />
        </g>
      )}
      {/* antenna */}
      <rect x="30.75" y="3" width="2.5" height="7" rx="1.25" fill="#3b82f6" />
      <circle className="will-antenna" cx="32" cy="4" r="2.8" fill="#fbbf24" />
      {/* helmet head */}
      <rect x="8" y="9" width="48" height="44" rx="17" fill="url(#willHeadGrad)" />
      {/* visor */}
      <rect x="15" y="18" width="34" height="25" rx="12.5" fill="#0b1220" />
      {/* eyes - outer group looks around (translate), inner group blinks
          (scaleY) - separate groups so the transforms never fight */}
      <g className="will-eyes-move">
        <g className="will-eyes">
          <circle cx="25.5" cy="28.5" r="3.4" fill="#eaf1ff" />
          <circle cx="38.5" cy="28.5" r="3.4" fill="#eaf1ff" />
        </g>
      </g>
      {/* mouth: smile awake, a soft "zzz" line asleep */}
      {mood === "sleeping" ? (
        <path
          d="M27 36 H37"
          stroke="#eaf1ff"
          strokeWidth="2.4"
          strokeLinecap="round"
          fill="none"
        />
      ) : (
        <path
          d="M26 35 Q32 39.5 38 35"
          stroke="#eaf1ff"
          strokeWidth="2.4"
          strokeLinecap="round"
          fill="none"
        />
      )}
    </svg>
  );
}
