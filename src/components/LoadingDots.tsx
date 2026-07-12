"use client";

// The app-wide loading indicator: three playful bouncing dots.
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
            className={`h-1.5 w-1.5 animate-bounce rounded-full ${
              light ? "bg-white" : "bg-brandblue"
            }`}
            style={{ animationDelay: `${i * 0.15}s`, animationDuration: "0.9s" }}
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
