"use client";

import { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    adsbygoogle?: unknown[];
  }
}

// Google AdSense slot. Renders ONLY for free-plan users - paid plans are 100%
// ad-free. The slot is ALWAYS visible on the free tier so the layout shows
// where ads live: before Google's review approves the site (or when no client
// id is set yet) it renders as a labelled placeholder, and real ads take over
// automatically once AdSense starts serving.
export function AdBanner({
  plan,
  slot = "auto",
}: {
  plan: string | undefined;
  slot?: string;
}) {
  const [client, setClient] = useState<string | null>(null);
  const pushed = useRef(false);

  const free = !plan || plan === "free";

  useEffect(() => {
    if (!free) return;
    fetch("/api/config/public")
      .then((r) => r.json())
      .then((d) => setClient(d.adsenseClient ?? null))
      .catch(() => {});
  }, [free]);

  useEffect(() => {
    if (!client || pushed.current) return;
    const id = "adsbygoogle-js";
    if (!document.getElementById(id)) {
      const s = document.createElement("script");
      s.id = id;
      s.async = true;
      s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${client}`;
      s.crossOrigin = "anonymous";
      document.head.appendChild(s);
    }
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
      pushed.current = true;
    } catch {
      /* ad blocked - fine */
    }
  }, [client]);

  if (!free) return null;

  return (
    <div className="mt-3 overflow-hidden rounded-blob border-2 border-line">
      <div className="bg-card2 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-faint">
        Sponsored
      </div>
      <div className="relative" style={{ minHeight: 100 }}>
        {/* Placeholder shown until AdSense fills the space */}
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 bg-card2/60">
          <span className="text-[12px] font-extrabold text-faint">Ad space</span>
          <span className="text-[10px] text-faint">
            {client ? "waiting for Google to serve" : "activates after Google review"}
          </span>
        </div>
        {client && (
          <ins
            className="adsbygoogle relative block"
            style={{ display: "block", minHeight: 100 }}
            data-ad-client={client}
            data-ad-slot={slot !== "auto" ? slot : undefined}
            data-ad-format="auto"
            data-full-width-responsive="true"
          />
        )}
      </div>
    </div>
  );
}
