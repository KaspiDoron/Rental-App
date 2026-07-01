// Central brand system: colours + the WheelDeal mark (half motorbike / half car).
// Kept framework-agnostic (plain strings) so it can power React components,
// static SVG files, and next/og raster generation from a single source.

export const BRAND = {
  name: "WheelDeal",
  tagline: "Cheapest local rides, negotiated for you",
  bg: "#070b13",
  bgSoft: "#0b1220",
  emerald: "#10b981",
  mint: "#34d399",
  teal: "#22d3ee",
  lime: "#a3e635",
  gold: "#f5c451",
  ink: "#04070d",
};

/**
 * The mark artwork on a transparent background, viewBox 0 0 512 512.
 * Left half: motorbike silhouette. Right half: car silhouette. A soft divider
 * of light sits on the seam so the two halves read as one badge.
 */
export const MARK_ARTWORK = `
<g fill="none" stroke="#ffffff" stroke-width="20" stroke-linecap="round" stroke-linejoin="round">
  <!-- motorbike (left) -->
  <circle cx="120" cy="360" r="52" />
  <circle cx="120" cy="360" r="10" fill="#ffffff" />
  <path d="M120 360 L176 270 L250 270" />
  <path d="M176 270 L150 210 L210 210" />
  <path d="M250 270 C232 320 210 340 176 350" />
  <path d="M250 270 L286 232" />
  <!-- seam glow -->
  <line x1="256" y1="150" x2="256" y2="410" stroke="#a3e635" stroke-width="8" opacity="0.5" />
  <!-- car (right) -->
  <path d="M300 372 L308 320 C312 300 326 292 344 292 L438 292 C456 292 470 302 476 320 L486 360" />
  <path d="M330 292 L352 250 L430 250 L452 292" />
  <path d="M300 372 L486 372" />
  <circle cx="356" cy="384" r="30" fill="#070b13" />
  <circle cx="446" cy="384" r="30" fill="#070b13" />
</g>`;

/** Full badge SVG string: rounded square, brand gradient, mark centred. */
export function markSvg(size = 512): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="wd-g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#059669"/>
      <stop offset="0.55" stop-color="#10b981"/>
      <stop offset="1" stop-color="#22d3ee"/>
    </linearGradient>
    <radialGradient id="wd-glow" cx="0.3" cy="0.2" r="0.9">
      <stop offset="0" stop-color="#a3e635" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#10b981" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="512" height="512" rx="116" fill="url(#wd-g)"/>
  <rect width="512" height="512" rx="116" fill="url(#wd-glow)"/>
  ${MARK_ARTWORK}
</svg>`;
}
