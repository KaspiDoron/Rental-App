import { NextResponse } from "next/server";
import { requireManagement, setAdmin, adminEmails, isOwner } from "@/lib/session";
import { listUsers, setUserStatus, deleteUser } from "@/lib/access";
import { disconnectInstance } from "@/lib/evolution";
import { sbDelete } from "@/lib/runtime-config";

async function payload() {
  const [admins, users] = await Promise.all([adminEmails(), listUsers()]);
  return {
    users: users.map((u) => ({
      ...u,
      role: isOwner(u.email) ? "owner" : admins.includes(u.email) ? "admin" : "user",
    })),
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
