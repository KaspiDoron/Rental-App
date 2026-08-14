// The WheelDeal mark (emoji-style half scooter / half car) as inline SVG.
// Transparent background so it sits on any surface.
//
// TWO VARIANTS (owner report 4, item 9):
//  - "solid" (default): the full-colour emoji mark. Used everywhere the brand
//    speaks - topbar, welcome, pricing. Changing the default would rebrand
//    the whole app, so the loader opts IN to the outline instead.
//  - "outline": the same silhouette as strokes only, in currentColor - the
//    luxury monoline treatment for the loading heartbeat. It inherits the
//    text colour, so both themes get it right for free, and a pure-CSS
//    draw-on shimmer (`.wd-draw` in globals.css) can animate the strokes
//    without a single JS timer.

const OUTLINE_PATHS = [
  // Car body (right half) + scooter body (left half), cabin, windshield.
  "M256 214 L336 214 C346 190 368 174 396 174 C424 174 446 190 456 214 L462 214 C482 214 496 230 496 250 L496 342 C496 360 482 372 464 372 L256 372 Z",
  "M352 224 C360 204 376 192 396 192 C416 192 432 204 440 224 L444 252 L348 252 Z",
  "M256 214 L214 214 C186 214 166 232 156 258 L136 316 L136 344 C136 360 148 372 164 372 L256 372 Z",
  // Handlebar + lightning bolt keep their line character.
  "M196 236 L156 156 L136 156",
  "M262 196 L234 268 L258 268 L246 330 L286 250 L262 250 L278 196 Z",
];

export function BrandMark({
  size = 40,
  className = "",
  variant = "solid",
}: {
  size?: number;
  className?: string;
  variant?: "solid" | "outline";
}) {
  if (variant === "outline") {
    // ~20/512 viewBox units reads as a crisp ~1.6px line at 40px render size.
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 512 512"
        className={className}
        aria-label="WheelDeal"
        role="img"
        fill="none"
        stroke="currentColor"
        strokeWidth="20"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <g transform="translate(-26,0)">
          {OUTLINE_PATHS.map((d, i) => (
            <path key={i} d={d} className="wd-draw" style={{ animationDelay: `${i * 120}ms` }} />
          ))}
          <circle cx="150" cy="384" r="58" className="wd-draw" style={{ animationDelay: "600ms" }} />
          <circle cx="150" cy="384" r="12" className="wd-draw" style={{ animationDelay: "720ms" }} />
          <circle cx="392" cy="384" r="58" className="wd-draw" style={{ animationDelay: "840ms" }} />
          <circle cx="392" cy="384" r="12" className="wd-draw" style={{ animationDelay: "960ms" }} />
        </g>
      </svg>
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      className={className}
      aria-label="WheelDeal"
      role="img"
    >
      <g transform="translate(-26,0)">
      <ellipse cx="258" cy="434" rx="196" ry="20" fill="#212837" opacity="0.1" />
      <path
        d="M256 214 L336 214 C346 190 368 174 396 174 C424 174 446 190 456 214 L462 214 C482 214 496 230 496 250 L496 342 C496 360 482 372 464 372 L256 372 Z"
        fill="#2f6fed"
      />
      <path d="M256 322 L496 322 L496 342 C496 360 482 372 464 372 L256 372 Z" fill="#1d5cd6" />
      <path d="M352 224 C360 204 376 192 396 192 C416 192 432 204 440 224 L444 252 L348 252 Z" fill="#dceaff" />
      <path d="M352 224 C360 204 376 192 396 192 L396 252 L348 252 Z" fill="#ffffff" opacity="0.55" />
      <rect x="404" y="272" width="40" height="12" rx="6" fill="#1d5cd6" />
      <rect x="482" y="252" width="14" height="26" rx="7" fill="#ffb703" />
      <path
        d="M256 214 L214 214 C186 214 166 232 156 258 L136 316 L136 344 C136 360 148 372 164 372 L256 372 Z"
        fill="#ef4444"
      />
      <path d="M256 322 L136 322 L136 344 C136 360 148 372 164 372 L256 372 Z" fill="#d13434" />
      <path d="M196 236 L156 156 L136 156" fill="none" stroke="#ef4444" strokeWidth="26" strokeLinecap="round" />
      <circle cx="128" cy="156" r="16" fill="#212837" />
      <rect x="118" y="120" width="20" height="18" rx="9" fill="#212837" />
      <circle cx="150" cy="262" r="18" fill="#ffb703" />
      <circle cx="144" cy="256" r="7" fill="#fff3d1" />
      <path
        d="M262 196 L234 268 L258 268 L246 330 L286 250 L262 250 L278 196 Z"
        fill="#ffb703"
        stroke="#e79b00"
        strokeWidth="4"
        strokeLinejoin="round"
      />
      <g>
        <circle cx="150" cy="384" r="58" fill="#212837" />
        <circle cx="150" cy="384" r="34" fill="#eef1f6" />
        <circle cx="150" cy="384" r="12" fill="#ffb703" />
      </g>
      <g>
        <circle cx="392" cy="384" r="58" fill="#212837" />
        <circle cx="392" cy="384" r="34" fill="#eef1f6" />
        <circle cx="392" cy="384" r="12" fill="#2f6fed" />
      </g>
      <path d="M96 84 L104 104 L124 112 L104 120 L96 140 L88 120 L68 112 L88 104 Z" fill="#ffb703" />
      </g>
    </svg>
  );
}
