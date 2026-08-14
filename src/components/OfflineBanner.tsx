"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";

// Global offline indicator. Without it, a dropped connection makes every
// action fail with misleading errors ("connect your WhatsApp") - the honest
// answer is "you're offline". Mounted once in the root layout.
export function OfflineBanner() {
  const { t } = useI18n();
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    setOffline(typeof navigator !== "undefined" && !navigator.onLine);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  if (!offline) return null;
  return (
    <div className="fixed inset-x-0 top-0 z-[2000] bg-brandred py-1.5 text-center text-[12px] font-extrabold text-white">
      📡 {t("No internet connection - actions will resume when you're back online.")}
    </div>
  );
}
