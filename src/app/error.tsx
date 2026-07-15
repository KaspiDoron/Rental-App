"use client";

import { useEffect } from "react";

// Route-level error boundary. Without this, a client-side exception paints a
// blank WHITE page (the "Application error: a client-side exception has
// occurred" that shows in a Home-Screen PWA, where the browser console is
// hidden). This turns any crash into a readable, recoverable screen.
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Best-effort: surface the message so it is not swallowed on mobile.
    // eslint-disable-next-line no-console
    console.error("WheelDeal client error:", error);
  }, [error]);

  return (
    <div
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
        background: "var(--bg, #0b0f1a)",
        color: "var(--strong, #f4f6fb)",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <div style={{ maxWidth: 380, textAlign: "center" }}>
        <div style={{ fontSize: 40 }}>🛵</div>
        <h1 style={{ fontSize: 20, fontWeight: 800, margin: "12px 0 6px" }}>
          Something hiccuped
        </h1>
        <p style={{ fontSize: 14, opacity: 0.75, lineHeight: 1.5 }}>
          The app hit a snag loading this screen. It is usually a stale cached
          version - reloading fixes it.
        </p>
        <div style={{ display: "flex", gap: 10, marginTop: 18, justifyContent: "center" }}>
          <button
            onClick={() => reset()}
            style={{
              padding: "12px 18px",
              borderRadius: 14,
              border: "none",
              background: "var(--blue, #2f6fed)",
              color: "#fff",
              fontWeight: 700,
              fontSize: 14,
            }}
          >
            Try again
          </button>
          <button
            onClick={() => {
              try {
                if ("serviceWorker" in navigator) {
                  navigator.serviceWorker
                    .getRegistrations()
                    .then((rs) => Promise.all(rs.map((r) => r.unregister())))
                    .catch(() => {})
                    .finally(() => location.reload());
                  return;
                }
              } catch {
                /* fall through */
              }
              location.reload();
            }}
            style={{
              padding: "12px 18px",
              borderRadius: 14,
              border: "1px solid var(--line, #2a3244)",
              background: "transparent",
              color: "var(--strong, #f4f6fb)",
              fontWeight: 700,
              fontSize: 14,
            }}
          >
            Reload app
          </button>
        </div>
        {error?.digest && (
          <p style={{ fontSize: 11, opacity: 0.4, marginTop: 14 }}>ref: {error.digest}</p>
        )}
      </div>
    </div>
  );
}
