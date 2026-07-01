// The WheelDeal mark (half motorbike / half car) as an inline React SVG.

export function BrandMark({
  size = 40,
  className = "",
  rounded = 12,
}: {
  size?: number;
  className?: string;
  rounded?: number;
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
      <defs>
        <linearGradient id="bm-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#059669" />
          <stop offset="0.55" stopColor="#10b981" />
          <stop offset="1" stopColor="#22d3ee" />
        </linearGradient>
        <radialGradient id="bm-glow" cx="0.3" cy="0.2" r="0.9">
          <stop offset="0" stopColor="#a3e635" stopOpacity="0.55" />
          <stop offset="1" stopColor="#10b981" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="512" height="512" rx={rounded * (512 / size)} fill="url(#bm-g)" />
      <rect width="512" height="512" rx={rounded * (512 / size)} fill="url(#bm-glow)" />
      <g
        fill="none"
        stroke="#ffffff"
        strokeWidth="20"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="120" cy="360" r="52" />
        <circle cx="120" cy="360" r="10" fill="#ffffff" />
        <path d="M120 360 L176 270 L250 270" />
        <path d="M176 270 L150 210 L210 210" />
        <path d="M250 270 C232 320 210 340 176 350" />
        <path d="M250 270 L286 232" />
        <line x1="256" y1="150" x2="256" y2="410" stroke="#a3e635" strokeWidth="8" opacity="0.5" />
        <path d="M300 372 L308 320 C312 300 326 292 344 292 L438 292 C456 292 470 302 476 320 L486 360" />
        <path d="M330 292 L352 250 L430 250 L452 292" />
        <path d="M300 372 L486 372" />
        <circle cx="356" cy="384" r="30" fill="#070b13" />
        <circle cx="446" cy="384" r="30" fill="#070b13" />
      </g>
    </svg>
  );
}
