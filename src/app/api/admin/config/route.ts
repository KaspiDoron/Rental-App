import { NextResponse } from "next/server";
import { requireManagement, getSession } from "@/lib/session";
import { listKeys, setKey, persistenceEnabled, revealKeys } from "@/lib/config";

export async function GET(req: Request) {
  const session = await requireManagement();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Owner-only: reveal raw values for viewing/copying.
  const reveal = new URL(req.url).searchParams.get("reveal") === "1";
  if (reveal) {
    const s = await getSession();
    if (s?.role !== "owner") {
      return NextResponse.json({ error: "Owner only" }, { status: 403 });
    }
    return NextResponse.json({ values: await revealKeys() });
  }

  return NextResponse.json({
    keys: await listKeys(),
    persistent: persistenceEnabled(),
  });
}

export async function POST(req: Request) {
  const session = await requireManagement();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { name, value } = await req.json().catch(() => ({}));
  if (!name) {
    return NextResponse.json({ error: "name required" }, { status: 400 });
  }
  const updated = await setKey(String(name), String(value ?? ""));
  if (!updated) {
    return NextResponse.json(
      { error: "Unknown or read-only key" },
      { status: 400 }
    );
  }
  // Only ever return the masked view - never echo the raw secret back.
  return NextResponse.json({ key: updated.key, warning: updated.warning });
}
