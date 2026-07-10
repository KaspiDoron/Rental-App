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
  // HERMETIC BETA: dev quick-entry is disabled by default. It only works when
  // ENABLE_DEV_LOGIN=1 is set explicitly (for local development), so it can
  // never be used to bypass the invite lock in the deployed beta.
  if ((process.env.ENABLE_DEV_LOGIN ?? "") !== "1") {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
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
