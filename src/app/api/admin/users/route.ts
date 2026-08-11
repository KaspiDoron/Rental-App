import { NextResponse } from "next/server";
import { requireManagement, setAdmin, adminEmails, isOwner } from "@/lib/session";
import { listUsers, setUserStatus, deleteUser } from "@/lib/access";
import { disconnectInstance } from "@/lib/evolution";
import { sbDelete } from "@/lib/runtime-config";

/**
 * THE MANAGEMENT LIST SHIPPED EVERY PASSWORD HASH TO A BROWSER.
 *
 * `...u` spread the whole UserRecord, so this endpoint returned every account's
 * scrypt `passwordHash` and their home-stay coordinates - to any admin session,
 * over the network, into a browser's memory, its network log and whatever
 * extension is watching. Nothing in the admin UI has ever read either field;
 * they rode along because the spread was easier than a projection.
 *
 * An admin is trusted to manage accounts. That is not the same as being handed
 * offline-crackable material for every user, and `stayLat`/`stayLng` are where
 * a traveller sleeps - the single most sensitive value this product stores, and
 * the one the whole `stayShareConsentAt` gate exists to protect. A consent gate
 * on the shop-facing path means nothing if the admin path spreads it anyway.
 *
 * ALLOW-LIST, not a deny-list: a deny-list leaks every field added later, and
 * this record has grown four times since it was written.
 */
function publicUser(u: import("@/lib/access").UserRecord, role: string) {
  return {
    email: u.email,
    phone: u.phone,
    name: u.name,
    provider: u.provider,
    status: u.status,
    plan: u.plan,
    termsAcceptedAt: u.termsAcceptedAt,
    termsVersion: u.termsVersion,
    waRiskAcceptedAt: u.waRiskAcceptedAt,
    aiResponsibilityAcceptedAt: u.aiResponsibilityAcceptedAt,
    // The LABEL is what a human needs to recognise a traveller's stay. The
    // coordinates are not, so they do not leave the server.
    stayLabel: u.stayLabel,
    stayShareConsentAt: u.stayShareConsentAt,
    addedAt: u.addedAt,
    lastSeen: u.lastSeen,
    role,
  };
}

async function payload() {
  const [admins, users] = await Promise.all([adminEmails(), listUsers()]);
  return {
    users: users.map((u) =>
      publicUser(u, isOwner(u.email) ? "owner" : admins.includes(u.email) ? "admin" : "user")
    ),
    admins,
  };
}

export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json(await payload());
}

export async function POST(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { email, action, status } = await req.json().catch(() => ({}));
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });

  if (action === "delete") {
    // Permanently erase the user: sever their WhatsApp link, delete their
    // account and their app data. The owner can never be erased.
    if (isOwner(String(email))) {
      return NextResponse.json({ error: "The owner cannot be erased." }, { status: 400 });
    }
    const target = String(email).toLowerCase();
    await disconnectInstance(target); // logout + delete WhatsApp everywhere
    // Purge the rows we key by their email so nothing about them remains.
    for (const table of ["bookings", "searches", "feedback", "wa_sessions"]) {
      await sbDelete(table, `email=eq.${encodeURIComponent(target)}`);
    }
    await deleteUser(target);
    return NextResponse.json(await payload());
  }

  if (action === "promote" || action === "demote") {
    // Only management may manage management; the owner can never be demoted.
    if (isOwner(String(email)) && action === "demote") {
      return NextResponse.json({ error: "The owner cannot be demoted." }, { status: 400 });
    }
    await setAdmin(String(email), action === "promote");
  } else if (status === "active" || status === "blocked") {
    if (isOwner(String(email))) {
      return NextResponse.json({ error: "The owner cannot be blocked." }, { status: 400 });
    }
    await setUserStatus(String(email), status);
  } else {
    return NextResponse.json({ error: "Provide an action or status." }, { status: 400 });
  }
  return NextResponse.json(await payload());
}
