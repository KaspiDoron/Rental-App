// Minimal inline icon set (no icon dependency).

export function Icon({
  name,
  className = "w-5 h-5",
}: {
  name: string;
  className?: string;
}) {
  const paths: Record<string, React.ReactNode> = {
    map: <path d="M9 3 4 5v16l5-2 6 2 5-2V3l-5 2-6-2Zm0 0v16m6-14v16" />,
    list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
    pin: (
      <>
        <path d="M12 21s-7-6.5-7-11a7 7 0 1 1 14 0c0 4.5-7 11-7 11Z" />
        <circle cx="12" cy="10" r="2.5" />
      </>
    ),
    star: (
      <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 17l-5.2 2.6 1-5.8L3.5 9.7l5.9-.9L12 3.5Z" />
    ),
    bolt: <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />,
    check: <path d="M20 6 9 17l-5-5" />,
    spark: (
      <path d="M12 3v4m0 10v4m9-9h-4M7 12H3m14.5-6.5-2.8 2.8M9.3 14.7l-2.8 2.8m0-11.3 2.8 2.8m5.4 5.4 2.8 2.8" />
    ),
    car: (
      <>
        <path d="M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11" />
        <path d="M3 16v-3a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3a1 1 0 0 1-1 1h-1v1a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H8v1a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-1H4a1 1 0 0 1-1-1Z" />
        <circle cx="7.5" cy="14" r="1" />
        <circle cx="16.5" cy="14" r="1" />
      </>
    ),
    bike: (
      <>
        <circle cx="6" cy="17" r="3" />
        <circle cx="18" cy="17" r="3" />
        <path d="M6 17l4-8h4l-2 4m5 4-3-8h-3" />
      </>
    ),
    filter: <path d="M3 5h18l-7 8v6l-4-2v-4L3 5Z" />,
    shield: (
      <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z" />
    ),
    lock: (
      <>
        <rect x="5" y="11" width="14" height="9" rx="2" />
        <path d="M8 11V8a4 4 0 1 1 8 0v3" />
      </>
    ),
    logout: <path d="M15 12H3m0 0 4-4m-4 4 4 4m6-11h4a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-4" />,
    calendar: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M3 9h18M8 3v4M16 3v4" />
      </>
    ),
    send: <path d="M4 12l16-8-6 16-3-6-7-2Z" />,
    chevron: <path d="M9 6l6 6-6 6" />,
    arrowDown: <path d="M12 5v14m0 0 6-6m-6 6-6-6" />,
    chat: (
      <path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-4.5A8 8 0 1 1 21 12Z" />
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    home: <path d="M4 11l8-7 8 7M6 10v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-9" />,
    user: (
      <>
        <circle cx="12" cy="8" r="3.5" />
        <path d="M5 20a7 7 0 0 1 14 0" />
      </>
    ),
    heart: (
      <path d="M12 20s-7-4.5-9.2-9C1.3 8.2 2.8 5 6 5c2 0 3.2 1.3 4 2.5C10.8 6.3 12 5 14 5c3.2 0 4.7 3.2 3.2 6-2.2 4.5-9.2 9-9.2 9Z" />
    ),
    card: (
      <>
        <rect x="3" y="6" width="18" height="12" rx="2" />
        <path d="M3 10h18" />
      </>
    ),
    cog: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1M7.7 16.3l-2.1 2.1" />
      </>
    ),
    bell: (
      <>
        <path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" />
        <path d="M10 19a2 2 0 0 0 4 0" />
      </>
    ),
    pause: <path d="M9 5v14M15 5v14" />,
    play: <path d="M7 4.5 19 12 7 19.5v-15Z" />,
    whatsapp: (
      <>
        <path d="M12 3.5a8.5 8.5 0 0 0-7.3 12.9L3.5 20.5l4.2-1.1A8.5 8.5 0 1 0 12 3.5Z" />
        <path d="M9 8.8c.4-.9 1-.9 1.3-.2l.6 1.3c.1.3 0 .6-.2.8l-.5.5c.5 1 1.4 1.9 2.4 2.4l.5-.5c.2-.2.5-.3.8-.2l1.3.6c.7.3.7.9-.2 1.3-2.7 1.3-7.3-3.3-6-6Z" />
      </>
    ),
    alert: (
      <>
        <path d="M12 4 2.5 20h19L12 4Z" />
        <path d="M12 10v4m0 3h.01" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5V12l3 2" />
      </>
    ),
    money: (
      <>
        <rect x="3" y="7" width="18" height="11" rx="2" />
        <circle cx="12" cy="12.5" r="2.5" />
        <path d="M6.5 10h.01m11 5h.01" />
      </>
    ),
    compare: (
      <>
        <path d="M9 4v16M4 8h5m-5 8h5" />
        <path d="M15 4v16m0-12h5m-5 8h5" />
      </>
    ),
    sparkles: (
      <>
        <path d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6L12 4Z" />
        <path d="M18.5 15.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2Z" />
      </>
    ),
    shieldCheck: (
      <>
        <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z" />
        <path d="M9 12l2 2 4-4" />
      </>
    ),
    doc: (
      <>
        <path d="M7 3h7l4 4v14H7V3Z" />
        <path d="M14 3v4h4M10 12h5m-5 4h5" />
      </>
    ),
    mic: (
      <>
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
      </>
    ),
    eyeOff: (
      <>
        <path d="M4 4l16 16" />
        <path d="M10.6 6.3A9.8 9.8 0 0 1 12 6.2c5 0 8.5 4 9.5 5.8-.4.8-1.4 2.2-2.9 3.4M7 7.6C4.9 9 3.3 10.9 2.5 12c1 1.8 4.5 5.8 9.5 5.8 1.2 0 2.4-.2 3.4-.7" />
        <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      </>
    ),
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {paths[name] ?? null}
    </svg>
  );
}

const STAR_PATH =
  "M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 17l-5.2 2.6 1-5.8L3.5 9.7l5.9-.9L12 3.5Z";

/** A single SOLID star (filled or empty) - the outline Icon can't show fill. */
function Star({ filled, className = "" }: { filled: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path
        d={STAR_PATH}
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Star-rating row - filled gold stars up to `value`, hollow after. */
export function Stars({
  value,
  size = "h-4 w-4",
}: {
  value: number;
  size?: string;
}) {
  const rounded = Math.round(value);
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${value} out of 5`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <Star
          key={i}
          filled={i < rounded}
          className={`${size} ${i < rounded ? "text-brandyellow" : "text-faint/40"}`}
        />
      ))}
    </span>
  );
}
