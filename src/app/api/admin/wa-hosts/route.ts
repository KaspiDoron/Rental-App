import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { hostsStatus, testOneHost } from "@/lib/evolution";

// Live health + load of every configured Evolution host (owner pool monitor).
// GET ?test=<hostUrl> runs a fresh, deep test of a single host instead.
export async function GET(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const test = new URL(req.url).searchParams.get("test");
  if (test) {
    return NextResponse.json(await testOneHost(test));
  }

  const hosts = await hostsStatus();
  return NextResponse.json({
    hosts,
    healthy: hosts.filter((h) => h.healthy).length,
    total: hosts.length,
    users: hosts.reduce((s, h) => s + h.users, 0),
  });
}
