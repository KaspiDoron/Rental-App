import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { listKeys, setKey } from "@/lib/config";

export async function GET() {
  const session = getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json({ keys: listKeys() });
}

export async function POST(req: Request) {
  const session = getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { name, value } = await req.json().catch(() => ({}));
  if (!name) {
    return NextResponse.json({ error: "name required" }, { status: 400 });
  }
  const updated = setKey(String(name), String(value ?? ""));
  if (!updated) {
    return NextResponse.json({ error: "Unknown key" }, { status: 400 });
  }
  // Only ever return the masked view — never echo the raw secret back.
  return NextResponse.json({ key: updated });
}
