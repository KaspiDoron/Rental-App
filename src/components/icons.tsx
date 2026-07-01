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
