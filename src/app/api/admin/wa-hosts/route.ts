import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { hostsStatus } from "@/lib/evolution";

// Live health + load of every configured Evolution host (owner pool monitor).
export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const hosts = await hostsStatus();
  return NextResponse.json({
    hosts,
    healthy: hosts.filter((h) => h.healthy).length,
    total: hosts.length,
    users: hosts.reduce((s, h) => s + h.users, 0),
  });
}
