import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { listUsers, setUserStatus } from "@/lib/access";

export async function GET() {
  const session = getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json({ users: listUsers() });
}

export async function POST(req: Request) {
  const session = getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { email, status } = await req.json().catch(() => ({}));
  if (!email || !["active", "blocked"].includes(status)) {
    return NextResponse.json({ error: "email and valid status required" }, { status: 400 });
  }
  setUserStatus(String(email), status);
  return NextResponse.json({ users: listUsers() });
}
