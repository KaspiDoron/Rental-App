import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";

// IS THE DANGEROUS RPC ACTUALLY LOCKED, ON THE DATABASE THIS APP IS TALKING TO?
//
// `prune_old_rows` is SECURITY DEFINER, and PostgreSQL hands EXECUTE to PUBLIC
// by default - which Supabase then exposes over PostgREST to `anon`, the key
// that ships inside every browser. supabase/retention.sql revokes it as part of
// creating it, but a database set up before that change still has the hole and
// nothing in the app could tell the owner which one they are running.
//
// So ASK, the same way an attacker would: call the RPC with the ANON key and a
// retention window of 100 years. If the revoke is in place PostgREST refuses
// before any SQL runs. If it is NOT in place the function does execute - and
// deletes nothing, because no row in this database is a century old. That is
// what makes this probe honest AND safe to run from an admin screen: it
// measures the real permission on the real project rather than asserting that
// a file was pasted somewhere.
//
// Three outcomes, and "unknown" is a real one: without the anon key on the
// server there is no way to test the anon path, and a green light that means
// "we did not check" is exactly the kind of reassurance this codebase refuses
// to ship.
export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "")
    .trim()
    .replace(/\/$/, "");
  const anon = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim();
  if (!url) {
    return NextResponse.json({
      state: "unknown",
      detail: "Supabase is not configured here, so there is nothing to probe.",
    });
  }
  if (!anon) {
    return NextResponse.json({
      state: "unknown",
      detail:
        "NEXT_PUBLIC_SUPABASE_ANON_KEY is not set on the server, so the anon path cannot be tested from here. Re-run supabase/retention.sql (it revokes the grant as part of creating the function) to be certain.",
    });
  }

  try {
    const res = await fetch(`${url}/rest/v1/rpc/prune_old_rows`, {
      method: "POST",
      headers: {
        apikey: anon,
        Authorization: `Bearer ${anon}`,
        "Content-Type": "application/json",
      },
      // 100 years: matches no row, so an EXPOSED function deletes nothing.
      body: JSON.stringify({ retain_days: 36500 }),
      cache: "no-store",
    });
    if (res.ok) {
      return NextResponse.json({
        state: "exposed",
        detail:
          "ANYONE HOLDING THE PUBLIC ANON KEY CAN CALL prune_old_rows AND DELETE YOUR HISTORY. Open the Supabase SQL editor and run supabase/retention.sql (or supabase/security-fix.sql for the one-line repair) now.",
      });
    }
    // 401/403 = permission refused, 404 = PostgREST will not even name a
    // function this role cannot execute. Both mean the anon key is locked out.
    if ([401, 403, 404].includes(res.status)) {
      return NextResponse.json({
        state: "locked",
        detail: `The anon key cannot call prune_old_rows (Supabase answered ${res.status}). This is the state you want.`,
      });
    }
    const body = await res.text().catch(() => "");
    return NextResponse.json({
      state: "unknown",
      detail: `Supabase answered ${res.status}, which is neither a refusal nor a success: ${body.slice(0, 160)}`,
    });
  } catch (e) {
    return NextResponse.json({
      state: "unknown",
      detail: `Could not reach Supabase to check: ${e instanceof Error ? e.message : "network error"}`,
    });
  }
}
