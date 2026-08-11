import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { sbSelect, sbInsert, sbInsertClaim } from "@/lib/runtime-config";

// Scooter Dash leaderboard.
// GET  -> top 20 published scores + the caller's own best
// POST -> submit { score, publish: "name" | "anonymous" } (private scores are
//         never sent here at all - localStorage keeps them on the device)
//
// Abuse resistance without ceremony: session required, integer score clamped
// to the schema's sanity range, a plausibility gate (the game earns ~10/coin
// + drip - five digits is already superhuman), and one submit per 30s per
// user via the existing claim-row primitive.

const MAX_PLAUSIBLE = 5000;

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const rows = await sbSelect<{
    display_name: string | null;
    score: number;
    created_at: string;
    user_email: string;
  }>(
    "game_scores",
    "select=display_name,score,created_at,user_email&order=score.desc,created_at.asc&limit=60"
  ).catch(() => []);

  // Best score per player (the table keeps history; the board shows bests).
  const seen = new Set<string>();
  const top: { name: string; score: number; you: boolean }[] = [];
  for (const r of rows) {
    if (seen.has(r.user_email)) continue;
    seen.add(r.user_email);
    top.push({
      name: r.display_name || "Traveller",
      score: r.score,
      you: r.user_email === session.email,
    });
    if (top.length >= 20) break;
  }
  // YOUR OWN BEST SCORE IS NOT A FACT ABOUT THE LEADERBOARD.
  //
  // `mine` was computed by filtering the SAME global top-60 slice - so a player
  // whose best did not make the global top 60 saw their own score as 0. The
  // table keeps full history (one row per submission), so a handful of high
  // scorers with many attempts is enough to push everyone else out.
  //
  // One extra scoped read answers it exactly, and cannot be crowded out.
  const own = await sbSelect<{ score: number }>(
    "game_scores",
    `select=score&user_email=eq.${encodeURIComponent(
      session.email
    )}&order=score.desc&limit=1`
  ).catch(() => []);
  const mine = Math.max(
    own[0]?.score ?? 0,
    // The board slice is still consulted, so a read failure above degrades to
    // the old behaviour rather than to zero.
    rows.filter((r) => r.user_email === session.email).reduce((m, r) => Math.max(m, r.score), 0)
  );

  return NextResponse.json({ top, myBest: mine });
}

export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const body = await req.json().catch(() => ({}));

  const score = Math.floor(Number(body.score));
  if (!Number.isFinite(score) || score < 1 || score > MAX_PLAUSIBLE) {
    return NextResponse.json({ ok: false, error: "That score doesn't look right." }, { status: 400 });
  }
  const publish = body.publish === "name" ? "name" : body.publish === "anonymous" ? "anonymous" : null;
  if (!publish) {
    return NextResponse.json({ ok: false, error: "Pick how to publish." }, { status: 400 });
  }
  // CONSENT: a display name is stored ONLY when the player chose to publish
  // under a name, and it is their own free text (sanitized), never the email.
  const displayName =
    publish === "name"
      ? String(body.displayName ?? "")
          .replace(/[<>\n\r]/g, "")
          .trim()
          .slice(0, 24) || null
      : null;
  if (publish === "name" && !displayName) {
    return NextResponse.json({ ok: false, error: "Add a name to publish under." }, { status: 400 });
  }

  // One submit per 30s per user (claim-row primitive; missing table = allow).
  const slot = `game:${Math.floor(Date.now() / 30_000)}`;
  const claim = await sbInsertClaim("wa_send_claims", {
    sender_key: session.email,
    slot_key: slot,
  });
  if (claim === "lost") {
    return NextResponse.json({ ok: false, error: "Easy, champion - try again in a moment." }, { status: 429 });
  }

  const ok = await sbInsert("game_scores", [
    { user_email: session.email, display_name: displayName, score },
  ]);
  if (!ok) {
    return NextResponse.json(
      { ok: false, error: "The leaderboard is warming up - your score is saved on this device." },
      { status: 503 }
    );
  }
  return NextResponse.json({ ok: true });
}

export const maxDuration = 60;
