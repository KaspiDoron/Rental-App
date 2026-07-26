// OrbitDots - a premium orbiting-dots loader that replaces the plain
// border-spinner rings. Three dots sit on a circular track; the whole track
// rotates (orbit-spin keyframe in globals.css), and each dot fades on a
// staggered phase so it reads as a living orbit rather than a spinning border.
//
// Pure CSS, self-contained, no deps. size = ring diameter in px. `light` tints
// the dots white for use on dark / colored backgrounds. role="status" + a
// visually-hidden label keep it accessible.

export function OrbitDots({
  size = 20,
  light = false,
  className = "",
  label = "Loading",
}: {
  size?: number;
  light?: boolean;
  className?: string;
  label?: string;
}) {
  const dot = Math.max(3, Math.round(size * 0.22));
  const color = light ? "#ffffff" : "currentColor";
  // Three dots at 0deg / 120deg / 240deg on the ring, each on its own opacity
  // phase for the chasing-comet look.
  const dots = [0, 1, 2];
  return (
    <span
      role="status"
      aria-label={label}
      className={`relative inline-block align-middle ${className}`}
      style={{ width: size, height: size }}
    >
      <span
        className="orbit-spin absolute inset-0"
        style={{ display: "block" }}
      >
        {dots.map((i) => {
          const angle = (i * 120 * Math.PI) / 180;
          const r = (size - dot) / 2;
          const cx = size / 2 + r * Math.sin(angle) - dot / 2;
          const cy = size / 2 - r * Math.cos(angle) - dot / 2;
          return (
            <span
              key={i}
              className="absolute rounded-full"
              style={{
                width: dot,
                height: dot,
                left: cx,
                top: cy,
                background: color,
                opacity: 1 - i * 0.28,
              }}
            />
          );
        })}
      </span>
    </span>
  );
}
