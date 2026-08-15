"use client";

// Thin global strip shown while the owner's TEST_MODE switch is on - every
// user (especially testers on free Ultra + sandbox billing) can see the app
// is not in live-production mode. Disappears the moment the switch goes off.

import { useEffect, useState } from "react";
import { loadPublicConfig } from "@/lib/client/public-config";

export function TestModeBanner() {
  const [on, setOn] = useState(false);

  useEffect(() => {
    let alive = true;
    void loadPublicConfig().then((d) => {
      if (alive) setOn(d.testMode);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!on) return null;
  return (
    <div
      className="fixed inset-x-0 top-0 z-[1900] bg-brandyellow py-1 text-center text-[10px] font-extrabold uppercase tracking-wide text-[#4a3300]"
      style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 2px)" }}
      role="status"
    >
      Test mode - subscriptions sandboxed · WhatsApp + searches are REAL · data may be reset
    </div>
  );
}
