import { NextResponse } from "next/server";
import { setSessionCookie, getSession, ownerEmail, setAdmin } from "@/lib/session";
import { registerUser, setPlan } from "@/lib/access";
import type { PlanId } from "@/lib/access";

// TEMPORARY development entry buttons (remove before public launch).
// Personas: owner, manager, free, pro, ultra.
const PERSONAS: Record<string, { email: string; plan: PlanId; admin?: boolean }> = {
  owner: { email: "", plan: "ultra" }, // filled with ownerEmail() below
  manager: { email: "dev-manager@wheeldeal.dev", plan: "ultra", admin: true },
  free: { email: "dev-free@wheeldeal.dev", plan: "free" },
  pro: { email: "dev-pro@wheeldeal.dev", plan: "pro" },
  ultra: { email: "dev-ultra@wheeldeal.dev", plan: "ultra" },
};

export async function POST(req: Request) {
  const { persona } = await req.json().catch(() => ({}));
  const p = PERSONAS[String(persona)];
  if (!p) return NextResponse.json({ error: "Unknown persona" }, { status: 400 });

  const email = persona === "owner" ? ownerEmail() : p.email;
  await registerUser({
    email,
    provider: "dev",
    acceptedTerms: true,
    plan: p.plan,
    phone: "+10000000000",
  });
  if (p.admin) await setAdmin(email, true);
  if (persona !== "owner") await setPlan(email, p.plan);

  setSessionCookie(email);
  const session = await getSession();
  return NextResponse.json({ ok: true, session });
}
