"use client";

// Top-level error boundary - catches exceptions thrown in the root layout
// itself (where the normal error.tsx cannot reach). Must render its own
// <html>/<body>. This is the last line of defence against a blank white
// screen in a Home-Screen PWA.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          minHeight: "100dvh",
          margin: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          background: "#0b0f1a",
          color: "#f4f6fb",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        <div style={{ maxWidth: 380, textAlign: "center" }}>
          <div style={{ fontSize: 40 }}>🛵</div>
          <h1 style={{ fontSize: 20, fontWeight: 800, margin: "12px 0 6px" }}>
            WheelDeal needs a reload
          </h1>
          <p style={{ fontSize: 14, opacity: 0.75, lineHeight: 1.5 }}>
            The app could not start this time - a fresh reload almost always
            fixes it.
          </p>
          <button
            onClick={() => reset()}
            style={{
              marginTop: 18,
              padding: "12px 22px",
              borderRadius: 14,
              border: "none",
              background: "#2f6fed",
              color: "#fff",
              fontWeight: 700,
              fontSize: 14,
            }}
          >
            Reload
          </button>
          {error?.digest && (
            <p style={{ fontSize: 11, opacity: 0.4, marginTop: 14 }}>ref: {error.digest}</p>
          )}
        </div>
      </body>
    </html>
  );
}
