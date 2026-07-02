// Central brand system. Playful palette: blue / red / yellow on clean
// white-gray. The mark is an emoji-style mashup: front half automatic scooter
// (red), rear half car (blue), savings bolt on the seam. Transparent background.

export const BRAND = {
  name: "WheelDeal",
  tagline: "Cheapest local rides, negotiated for you",
  bgLight: "#f4f6f9",
  bgDark: "#17191d",
  blue: "#2f6fed",
  blueStrong: "#1d5cd6",
  red: "#ef4444",
  yellow: "#ffb703",
  green: "#16a34a",
  ink: "#212837",
};

/** The mark artwork (transparent bg), viewBox 0 0 512 512, optically centred. */
export const MARK_ARTWORK = `
<g transform="translate(-26,0)">
  <ellipse cx="258" cy="434" rx="196" ry="20" fill="#212837" opacity="0.10"/>
  <path d="M256 214 L336 214 C346 190 368 174 396 174 C424 174 446 190 456 214 L462 214 C482 214 496 230 496 250 L496 342 C496 360 482 372 464 372 L256 372 Z" fill="#2f6fed"/>
  <path d="M256 322 L496 322 L496 342 C496 360 482 372 464 372 L256 372 Z" fill="#1d5cd6"/>
  <path d="M352 224 C360 204 376 192 396 192 C416 192 432 204 440 224 L444 252 L348 252 Z" fill="#dceaff"/>
  <path d="M352 224 C360 204 376 192 396 192 L396 252 L348 252 Z" fill="#ffffff" opacity="0.55"/>
  <rect x="404" y="272" width="40" height="12" rx="6" fill="#1d5cd6"/>
  <rect x="482" y="252" width="14" height="26" rx="7" fill="#ffb703"/>
  <path d="M256 214 L214 214 C186 214 166 232 156 258 L136 316 L136 344 C136 360 148 372 164 372 L256 372 Z" fill="#ef4444"/>
  <path d="M256 322 L136 322 L136 344 C136 360 148 372 164 372 L256 372 Z" fill="#d13434"/>
  <path d="M196 236 L156 156 L136 156" fill="none" stroke="#ef4444" stroke-width="26" stroke-linecap="round"/>
  <circle cx="128" cy="156" r="16" fill="#212837"/>
  <rect x="118" y="120" width="20" height="18" rx="9" fill="#212837"/>
  <circle cx="150" cy="262" r="18" fill="#ffb703"/>
  <circle cx="144" cy="256" r="7" fill="#fff3d1"/>
  <path d="M262 196 L234 268 L258 268 L246 330 L286 250 L262 250 L278 196 Z" fill="#ffb703" stroke="#e79b00" stroke-width="4" stroke-linejoin="round"/>
  <g>
    <circle cx="150" cy="384" r="58" fill="#212837"/>
    <circle cx="150" cy="384" r="34" fill="#eef1f6"/>
    <circle cx="150" cy="384" r="12" fill="#ffb703"/>
    <rect x="146" y="352" width="8" height="24" rx="4" fill="#c3cad6"/>
    <rect x="146" y="392" width="8" height="24" rx="4" fill="#c3cad6"/>
    <rect x="118" y="380" width="24" height="8" rx="4" fill="#c3cad6"/>
    <rect x="158" y="380" width="24" height="8" rx="4" fill="#c3cad6"/>
  </g>
  <g>
    <circle cx="392" cy="384" r="58" fill="#212837"/>
    <circle cx="392" cy="384" r="34" fill="#eef1f6"/>
    <circle cx="392" cy="384" r="12" fill="#2f6fed"/>
    <rect x="388" y="352" width="8" height="24" rx="4" fill="#c3cad6"/>
    <rect x="388" y="392" width="8" height="24" rx="4" fill="#c3cad6"/>
    <rect x="360" y="380" width="24" height="8" rx="4" fill="#c3cad6"/>
    <rect x="400" y="380" width="24" height="8" rx="4" fill="#c3cad6"/>
  </g>
  <path d="M96 84 L104 104 L124 112 L104 120 L96 140 L88 120 L68 112 L88 104 Z" fill="#ffb703"/>
  <path d="M420 92 L426 106 L440 112 L426 118 L420 132 L414 118 L400 112 L414 106 Z" fill="#ef4444" opacity="0.85"/>
  <circle cx="352" cy="64" r="10" fill="#2f6fed" opacity="0.8"/>
</g>`;

/** Full SVG. `bg` paints a rounded backdrop (iOS icons need one); omit for transparent. */
export function markSvg(size = 512, bg?: string): string {
  const backdrop = bg
    ? `<rect width="512" height="512" rx="116" fill="${bg}"/>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">${backdrop}${MARK_ARTWORK}</svg>`;
}
