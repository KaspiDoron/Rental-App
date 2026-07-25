"use client";

// Reusable browser-push controller for a real on/off toggle. Server truth (a row
// in push_subscriptions) is authoritative; localStorage is only a hint. Used by
// the Profile "Alerts" section. The funnel keeps its own inline opt-in flow.

import { useCallback, useEffect, useState } from "react";

export type PushState =
  | "loading"
  | "unconfigured" // server has no VAPID keys
  | "unsupported" // browser can't do push
  | "ios-install" // iOS Safari not installed to Home Screen
  | "off"
  | "on"
  | "busy"
  | "denied"
  | "error";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export interface UsePushAlerts {
  state: PushState;
  devices: number;
  note: string | null;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function usePushAlerts(): UsePushAlerts {
  const [state, setState] = useState<PushState>("loading");
  const [devices, setDevices] = useState(0);
  const [note, setNote] = useState<string | null>(null);

  const supported = () =>
    typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window;
  const standalone = () =>
    typeof window !== "undefined" &&
    ((window.navigator as unknown as { standalone?: boolean }).standalone === true ||
      window.matchMedia?.("(display-mode: standalone)").matches === true);

  const refresh = useCallback(async () => {
    try {
      const d = await (await fetch("/api/push/subscribe")).json();
      setDevices(Number(d?.devices ?? 0));
      if (!d?.configured) {
        setState("unconfigured");
        return;
      }
      if (!supported()) {
        const iOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
        setState(iOS && !standalone() ? "ios-install" : "unsupported");
        return;
      }
      if (typeof Notification !== "undefined" && Notification.permission === "denied") {
        setState("denied");
        return;
      }
      setState(d?.on ? "on" : "off");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const enable = useCallback(async () => {
    setNote(null);
    if (!supported()) {
      const iOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
      setState(iOS && !standalone() ? "ios-install" : "unsupported");
      return;
    }
    setState("busy");
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setState("denied");
        return;
      }
      const vapid = await (await fetch("/api/push/vapid")).json();
      if (!vapid?.key) {
        setState("unconfigured");
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js");
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid.key) as BufferSource,
      });
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.ok === false) {
        setState("error");
        setNote("Couldn't save your alert subscription - try again.");
        return;
      }
      try {
        localStorage.setItem("wd_push_on", "1");
      } catch {}
      await refresh();
    } catch {
      setState("error");
      setNote("Something interrupted turning on alerts - try again.");
    }
  }, [refresh]);

  const disable = useCallback(async () => {
    setNote(null);
    setState("busy");
    try {
      // Best-effort browser-side unsubscribe (so the device stops receiving too).
      if (supported()) {
        const reg = await navigator.serviceWorker.getRegistration();
        const sub = await reg?.pushManager.getSubscription();
        await sub?.unsubscribe().catch(() => {});
      }
      await fetch("/api/push/subscribe", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}" });
      try {
        localStorage.removeItem("wd_push_on");
      } catch {}
      await refresh();
    } catch {
      setState("error");
      setNote("Couldn't turn alerts off - try again.");
    }
  }, [refresh]);

  return { state, devices, note, enable, disable, refresh };
}
