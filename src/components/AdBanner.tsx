"use client";

import { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    adsbygoogle?: unknown[];
  }
}

// Google AdSense slot. Renders ONLY for free-plan users and ONLY when an
// AdSense client id is configured (Admin -> Keys -> ADSENSE_CLIENT).
// Paid plans are 100% ad-free.
export function AdBanner({ plan }: { plan: string | undefined }) {
  const [client, setClient] = useState<string | null>(null);
  const pushed = useRef(false);

  useEffect(() => {
    if (plan && plan !== "free") return;
    fetch("/api/config/public")
      .then((r) => r.json())
      .then((d) => setClient(d.adsenseClient ?? null))
      .catch(() => {});
  }, [plan]);

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

  if ((plan && plan !== "free") || !client) return null;

  return (
    <div className="mt-3 overflow-hidden rounded-blob border-2 border-line">
      <div className="bg-card2 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-faint">
        Sponsored
      </div>
      <ins
        className="adsbygoogle block"
        style={{ display: "block", minHeight: 90 }}
        data-ad-client={client}
        data-ad-format="auto"
        data-full-width-responsive="true"
      />
    </div>
  );
}
