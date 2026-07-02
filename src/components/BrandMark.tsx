// The WheelDeal mark (emoji-style half scooter / half car) as inline SVG.
// Transparent background so it sits on any surface.

export function BrandMark({
  size = 40,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
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
