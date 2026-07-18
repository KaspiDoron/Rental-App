import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sbDeleteReturning } from "@/lib/runtime-config";

// Wipe THIS user's imported shop-conversation data: the inbound WhatsApp
// messages their number received and the derived vendor_replies. Used to clear
// any historically mis-ingested rows (a personal chat that was shown as a shop
// reply before the ingestion fixes). Strictly scoped to the caller - it can
// NEVER touch another user's data. Going forward, correctly-scoped replies
// re-populate as shops actually reply, so this is a safe reset, not a loss of
// anything live.
export async function POST() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const me = encodeURIComponent(session.email);

  let removed = 0;
  const purge = async (table: string, filter: string) => {
    const rows = await sbDeleteReturning<{ id?: number }>(table, filter).catch(() => []);
    removed += rows.length;
  };

  // Derived shop replies shown in the feed/deals timeline (the poison surface).
  await purge("vendor_replies", `user_email=eq.${me}`);
  // The raw ingested inbound rows, scoped to this user as the receiver.
  await purge("whatsapp_messages", `direction=eq.inbound&raw->>receiver=eq.${me}`);

  return NextResponse.json({ ok: true, removed });
}

export const maxDuration = 30;
