// Web Push (browser notifications that arrive even when the app is CLOSED).
// Free for every plan. Degrades gracefully: with no VAPID keys configured the
// whole feature is a silent no-op, so the app always builds and runs.
//
// Flow: the browser subscribes (service worker + PushManager) -> we store the
// subscription in push_subscriptions -> when a shop replies, the webhook path
// sends a push to that user's devices. Keys come from the Key Vault / env
// (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY), so no rebuild is needed to enable it.

import "server-only";
import webpush from "web-push";
import { getConfig, sbInsert, sbSelect, sbDelete } from "./runtime-config";

interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

let configured: string | null = null; // cache the public key we set VAPID with

async function ensureVapid(): Promise<string | null> {
  const [pub, priv] = await Promise.all([
    getConfig("VAPID_PUBLIC_KEY"),
    getConfig("VAPID_PRIVATE_KEY"),
  ]);
  if (!pub || !priv) return null;
  if (configured !== pub) {
    const admins = (await getConfig("ADMIN_EMAILS")) || "";
    const subject = admins.split(",")[0]?.trim();
    // Fallback subject derives from the admin-set APP_DOMAIN so push identity
    // follows the brand domain without a redeploy.
    let host = "wheeldeal.app";
    try {
      const domain = await getConfig("APP_DOMAIN");
      if (domain) host = new URL(domain.startsWith("http") ? domain : `https://${domain}`).hostname;
    } catch {}
    webpush.setVapidDetails(subject ? `mailto:${subject}` : `mailto:hello@${host}`, pub, priv);
    configured = pub;
  }
  return pub;
}

/** The public key the browser needs to subscribe (null when push is off). */
export async function vapidPublicKey(): Promise<string | null> {
  return (await getConfig("VAPID_PUBLIC_KEY")) || null;
}

/** Persist a browser push subscription for a user (idempotent on endpoint). */
export async function saveSubscription(email: string, sub: PushSub): Promise<boolean> {
  if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return false;
  // De-dupe: drop any existing row for this endpoint first, then insert.
  await sbDelete("push_subscriptions", `endpoint=eq.${encodeURIComponent(sub.endpoint)}`).catch(() => {});
  return sbInsert("push_subscriptions", [
    { user_email: email, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth },
  ]);
}

interface SubRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Send a push to all of a user's subscribed devices. Best-effort: prunes dead
 * subscriptions (410 Gone / 404) and never throws. No-op when VAPID is unset.
 */
export async function sendPushToUser(
  email: string,
  payload: { title: string; body: string; url?: string }
): Promise<void> {
  if (!email) return;
  const pub = await ensureVapid();
  if (!pub) return; // push not configured - silent no-op
  const subs = await sbSelect<SubRow>(
    "push_subscriptions",
    `select=endpoint,p256dh,auth&user_email=eq.${encodeURIComponent(email)}&limit=20`
  ).catch(() => [] as SubRow[]);
  if (!subs.length) return;
  const data = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url ?? "/",
  });
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          data
        );
      } catch (e: any) {
        const code = e?.statusCode;
        if (code === 404 || code === 410) {
          await sbDelete("push_subscriptions", `endpoint=eq.${encodeURIComponent(s.endpoint)}`).catch(() => {});
        }
      }
    })
  );
}
