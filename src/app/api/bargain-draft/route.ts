import { NextResponse } from "next/server";
import { composeBargain, runSafety, currencyForRegion } from "@/lib/agents";
import { getSession } from "@/lib/session";
import { sbInsert, sbSelect } from "@/lib/runtime-config";
import type { Vendor, StructuredRFQ } from "@/lib/types";
import { digitsOnly } from "@/lib/phone";
import { can, localLanguageAllowed } from "@/lib/entitlements";

// Adaptive Bargaining Agent: composes the next negotiation message to send.
// This is the SAME brain the automatic funnel uses - market-floor anchored
// target, cross-shop rival leverage from the user's own session, and the real
// thread history so it never re-asks something the shop already answered.
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body?.vendor || !body?.rfq) {
    return NextResponse.json({ error: "vendor and rfq required" }, { status: 400 });
  }

  // Local-language street bargaining is an Ultra perk (management included).
  //
  // Named for what it CHECKS, not for the tier that currently satisfies it.
  // `isUltra` was a feature check wearing a tier's name, which is how a second
  // surface ends up hardcoding `plan === "ultra"` to "match" it.
  const wantsLocal = body.language === "local";
  const localAllowed = localLanguageAllowed({ requested: true, plan: session.plan });
  if (wantsLocal && !localAllowed) {
    return NextResponse.json(
      {
        error: "Bargaining in the shop's local language is an Ultra feature.",
        upgrade: true,
      },
      { status: 403 }
    );
  }

  const rfq = body.rfq as StructuredRFQ;
  const vendor = body.vendor as Vendor;
  const region: string | undefined = body.region || undefined;
  const quoted: number | undefined = body.currentPricePerDay;
  const cur = currencyForRegion(region) || "USD";

  // SERVER-AUTHORITATIVE LANGUAGE (owner report 5 #14). This route used to
  // trust body.language verbatim while the modal invented its own default
  // (`isUltra ? "local" : "english"`) - so an English-only hunt composed its
  // FIRST draft in Thai. The send path (/api/outreach) already resolves the
  // thread's established mode and lets it win; the draft path now runs the
  // identical resolution, so what the traveller reviews is what would send.
  let composeLocal = wantsLocal && localAllowed;
  try {
    const digits = digitsOnly(String(vendor.whatsapp ?? ""));
    if (digits) {
      const { threadLanguageMode, resolveThreadLanguage } = await import(
        "@/lib/wa/thread-language"
      );
      const established = await threadLanguageMode(session.email, digits);
      composeLocal = resolveThreadLanguage({
        requested: localLanguageAllowed({ requested: wantsLocal, plan: session.plan }),
        established,
      }).localLang;
    }
  } catch {
    /* resolution is a guard - the entitlement gate above has already run */
  }

  // ONE MOVE PER HUMAN BEAT: inside the user-move window a second tap gets the
  // SAME draft back, not a freshly-worded one. Every dedupe downstream keys on
  // exact text - a re-composed draft is a new string by construction, which is
  // precisely how "Push harder" tapped twice put two near-identical bargains
  // into one shop's chat. Returning the last draft verbatim restores the
  // exact-text dedupe's power over the whole tap-again path.
  try {
    const { USER_MOVE_WINDOW_SEC } = await import("@/lib/wa/turn-lock");
    const since = new Date(Date.now() - USER_MOVE_WINDOW_SEC * 1000).toISOString();
    const recent = await sbSelect<{ tactic: string | null; message: string | null }>(
      "bargain_drafts",
      `select=tactic,message&user_email=eq.${encodeURIComponent(
        session.email
      )}&vendor_id=eq.${encodeURIComponent(String(vendor.id ?? ""))}&created_at=gte.${encodeURIComponent(
        since
      )}&order=created_at.desc&limit=1`
    );
    if (recent[0]?.message) {
      return NextResponse.json({
        message: recent[0].message,
        tacticId: recent[0].tactic ?? "reused",
        reused: true,
      });
    }
  } catch {
    /* reuse is a guard, never a blocker - fall through to a fresh compose */
  }

  // Market floor: the same anchor the automatic agent uses, so the manual
  // Bargain button never proposes a weak or absurd number.
  let floorPrice: number | undefined;
  try {
    const { floorPriceFor } = await import("@/lib/market");
    const floor = await floorPriceFor(region, rfq);
    if (floor && floor.currency === cur) floorPrice = floor.floor;
  } catch {
    /* floor is an enhancement, never a blocker */
  }

  // Cross-shop leverage: the user's best OTHER offer for the same vehicle in
  // this session (client hint accepted, server data preferred).
  let rival: number | undefined = body.rivalPricePerDay;
  try {
    if (quoted) {
      const { vehicleKeyFor } = await import("@/lib/market");
      const { cheapestRivalFor } = await import("@/lib/search-session");
      const server = await cheapestRivalFor(session.email, {
        vendorId: String(vendor.id ?? ""),
        currency: cur,
        vehicleKey: vehicleKeyFor(rfq),
        belowPrice: quoted,
      });
      if (server) rival = Math.min(rival ?? Infinity, server);
      if (!Number.isFinite(rival ?? Infinity)) rival = undefined;
    }
  } catch {
    /* leverage is an enhancement */
  }

  // Thread history: what we and the shop already said - the draft must never
  // repeat an answered question.
  //
  // PRIVACY holds: both directions are filtered to THIS user in JS below
  // (outbound by sender, inbound by receiver), so no other user's message can
  // ever reach the prompt. There is no leak here and never was.
  //
  // WHAT WAS BROKEN IS THE LIMIT'S POSITION. The comment above this block used
  // to claim the SQL filtered by user; it did not. `limit=20` was applied to a
  // query whose only predicate is `vendorId OR from_number` - and the comment
  // itself explains why that is cross-user: a Google place id is shared by
  // every traveller, and so is a shop's number. For any shop several people are
  // talking to, the newest 20 rows are mostly other users', `mine` comes back
  // empty, and the bargaining prompt loses the traveller's own history - so the
  // agent re-asks questions the shop already answered, which is the exact
  // failure this block exists to prevent. It degrades silently, and gets worse
  // the more popular the shop is.
  //
  // Scoping the SQL to this user makes the 20 rows THEIR 20 rows. Both arms of
  // the OR are still needed (outbound rows carry vendorId; inbound rows are
  // matched by the shop's number), so the ownership predicate is expressed as a
  // second OR over the two directional stamps rather than one column.
  let history: string | undefined;
  try {
    const digits = digitsOnly(String(vendor.whatsapp ?? ""));
    const me = encodeURIComponent(session.email);
    const out = await sbSelect<{
      direction: string;
      body: string | null;
      raw: { sender?: string; receiver?: string } | null;
    }>(
      "whatsapp_messages",
      `select=direction,body,raw&or=(raw->>vendorId.eq.${encodeURIComponent(
        String(vendor.id ?? "")
      )},from_number.eq.${encodeURIComponent(digits || "none")})` +
        `&or=(raw->>sender.eq.${me},raw->>receiver.eq.${me})` +
        `&order=received_at.desc&limit=20`
    );
    // The JS filter stays. It is stricter than the SQL (it pairs the stamp with
    // the DIRECTION), and it is the guarantee - the query is an optimisation.
    const mine = out.filter((m) =>
      m.direction === "inbound"
        ? m.raw?.receiver === session.email
        : m.raw?.sender === session.email
    );
    if (mine.length) {
      history = mine
        .slice(0, 10)
        .reverse()
        .map((m) => `${m.direction === "outbound" ? "Us" : "Shop"}: ${(m.body ?? "").slice(0, 250)}`)
        .join("\n");
    }
  } catch {
    /* history is an enhancement */
  }

  // Target: aim at (or just under) the rival when we have one, floor-clamped.
  const target =
    quoted !== undefined
      ? Math.max(
          floorPrice ?? 0,
          rival ? Math.min(Math.round(quoted * 0.85), rival) : Math.round(quoted * 0.85)
        )
      : undefined;

  const draft = await composeBargain({
    rfq,
    vendor,
    currentPricePerDay: quoted,
    rivalPricePerDay: rival,
    region,
    round: Math.max(0, Number(body.round ?? 0)),
    currency: cur,
    localLanguage: composeLocal,
    targetPricePerDay: target,
    floorPricePerDay: floorPrice,
    history,
    voiceKey: session.email,
  });

  // Safety-screen even our own composed drafts before they can be sent.
  const verdict = await runSafety(draft.message);
  if (!verdict.allowed) {
    return NextResponse.json(
      { error: "Draft failed the safety screen - try again." },
      { status: 500 }
    );
  }

  await sbInsert("bargain_drafts", [
    {
      user_email: session.email,
      vendor_id: String(vendor.id ?? ""),
      tactic: draft.tacticId,
      message: draft.message,
    },
  ]);

  // The language the draft was ACTUALLY composed in, so the modal can reflect
  // reality when the server overrode the request (thread already in English,
  // hunt not local, plan not entitled).
  return NextResponse.json({ ...draft, languageUsed: composeLocal ? "local" : "english" });
}

// maxDuration: lift the request-timeout ceiling for slow AI upstreams.
export const maxDuration = 60;
