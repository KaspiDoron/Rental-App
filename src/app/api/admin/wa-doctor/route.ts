// WA DOCTOR (management-only): a one-tap incident tracer for the inbound
// pipeline. GET returns a full checklist for a user (and, optionally, a specific
// shop number): host health, live connection, the webhook URL Evolution ACTUALLY
// holds vs what we expect (token current/foreign/none), and - per number - the
// exact ingest-gate verdict WITH the reason, the RFQ-thread presence,
// takeover/pause holds, recent inbound, and the last silent-drop trace. POST
// {action:"rearm"} force-re-arms the webhook. This turns the next "shops replied
// but nothing happened" incident into one click instead of screenshot forensics.

import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { sbSelect } from "@/lib/runtime-config";
import { webhookDiagnostics, reassertWebhook, instanceNameFor } from "@/lib/evolution";
import { classifyIngestDetailed, type GateRaw } from "@/lib/wa/thread-gate";
import { threadNumberOr } from "@/lib/wa/phone-key";
import { resolveThreadContext } from "@/lib/wa/thread-context";
import { isThreadTakenOver, isSessionPaused } from "@/lib/session-flags";
import { digitsOnly } from "@/lib/phone";
import { publicRequestOrigin } from "@/lib/request-origin";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const email = (url.searchParams.get("email") || "").trim().toLowerCase();
  const number = digitsOnly(url.searchParams.get("number") || "");
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });

  const enc = encodeURIComponent(email);
  // Forwarded-aware: lets the expected-URL diagnosis work from the live public
  // host even before APP_DOMAIN is saved (the canonicalizer still prefers it).
  const reqOrigin = publicRequestOrigin(req) ?? undefined;
  const [diag, sessionRow, waOk, wa403] = await Promise.all([
    webhookDiagnostics(email, reqOrigin).catch(() => null),
    sbSelect<{ status: string | null; host_url: string | null; updated_at: string | null }>(
      "wa_sessions",
      `select=status,host_url,updated_at&email=eq.${enc}&limit=1`
    ).catch(() => []),
    sbSelect<{ created_at: string }>(
      "agent_events",
      `select=created_at&kind=eq.webhook-ok&order=created_at.desc&limit=1`
    ).catch(() => []),
    sbSelect<{ created_at: string }>(
      "agent_events",
      `select=created_at&kind=eq.webhook-403&order=created_at.desc&limit=1`
    ).catch(() => []),
  ]);

  const report: Record<string, unknown> = {
    email,
    instance: instanceNameFor(email),
    hosts: diag?.hosts ?? [],
    session: {
      status: sessionRow[0]?.status ?? null,
      hostUrl: sessionRow[0]?.host_url ?? null,
      updatedAt: sessionRow[0]?.updated_at ?? null,
    },
    liveState: diag?.liveState ?? null,
    webhook: {
      ...(diag?.webhook ?? { expectedUrl: null, registeredUrl: null, tokenState: "none", originMatch: null }),
      lastAcceptedAt: waOk[0]?.created_at ?? null,
      last403At: wa403[0]?.created_at ?? null,
    },
  };

  // ---- Optional per-number thread trace (the "why no reply" answer) ---------
  if (number) {
    const encNum = encodeURIComponent(number);
    const outOr = threadNumberOr("to_number", number);
    const inOr = threadNumberOr("from_number", number);
    const [outbound, inbound, dropTrace] = await Promise.all([
      // TOLERANT matching, exactly like the engine. An exact `to_number=eq.`
      // read here could show "0 anchors" for a thread the resolver finds fine
      // (or vice versa) because a shop's number may be stored in a national
      // spelling - a doctor that disagrees with the engine sends you hunting
      // the wrong bug.
      sbSelect<{ received_at: string; raw: GateRaw | null }>(
        "whatsapp_messages",
        `select=received_at,raw&direction=eq.outbound&raw->>sender=eq.${enc}&order=received_at.desc&limit=10${
          outOr ? `&or=${outOr}` : `&to_number=eq.${encNum}`
        }`
      ).catch(() => []),
      sbSelect<{ id: number; received_at: string }>(
        "whatsapp_messages",
        `select=id,received_at&direction=eq.inbound&raw->>receiver=eq.${enc}&order=received_at.desc&limit=5${
          inOr ? `&or=${inOr}` : `&from_number=eq.${encNum}`
        }`
      ).catch(() => []),
      sbSelect<{ created_at: string; detail: string | null }>(
        "agent_events",
        `select=created_at,detail&kind=eq.inbound-dropped&user_email=eq.${enc}&order=created_at.desc&limit=5`
      ).catch(() => []),
    ]);

    const gate = classifyIngestDetailed(
      outbound.map((o) => ({ received_at: o.received_at, raw: o.raw })),
      Date.now()
    );
    // THE ANCHOR VERDICT MUST COME FROM THE ENGINE'S OWN RESOLVER. This used to
    // be `outbound[0]?.raw?.rfq != null` - the newest row only - which is the
    // exact predicate resolveThreadContext was written to replace. So the doctor
    // could report "RFQ anchor MISSING" on a thread the agent handles perfectly
    // (any rfq-less row on top), or the reverse. One predicate, one truth.
    const resolved = await resolveThreadContext(number, email).catch(() => null);
    const [takenOver, paused] = await Promise.all([
      isThreadTakenOver(email, number).catch(() => null),
      isSessionPaused(email).catch(() => null),
    ]);
    // ONLY this number's drop traces. The old `?? dropTrace[0]` fallback showed
    // an unrelated thread's drop as if it belonged to this one - which is how a
    // stale trace from another shop reads as a live failure here.
    const lastDrop = dropTrace.find((d) => (d.detail ?? "").includes(number)) ?? null;

    // The shop's profile picture, and - when there is none - WHY. Every avatar
    // on the board came back blank in the field while the shops plainly had
    // photos in WhatsApp; without the upstream reason there was nothing to act
    // on from a phone. `error` absent means "this shop simply has no picture".
    const avatar = await import("@/lib/evolution")
      .then((m) => m.fetchProfilePicture(email, number))
      .catch((e) => ({ url: null, error: e instanceof Error ? e.message : "failed" }));

    report.thread = {
      digits: number,
      avatar: { found: Boolean(avatar.url), error: avatar.error ?? null },
      anchors: outbound.map((o) => ({
        at: o.received_at,
        kind: o.raw?.kind ?? null,
        hasRfq: o.raw?.rfq != null,
      })),
      gate: { ingestible: gate.ok, reason: gate.reason },
      // What the AGENT sees, not what the newest row happens to carry.
      ctxRfqPresent: resolved?.rfq != null,
      /** true when the anchor came from self-healing recovery, not a stored row. */
      anchorRepaired: resolved?.repaired === true,
      takenOver,
      paused,
      recentInbound: inbound.map((i) => ({ at: i.received_at, id: String(i.id) })),
      lastDropTrace: lastDrop
        ? { at: lastDrop.created_at, detail: lastDrop.detail ?? "" }
        : null,
    };
  }

  return NextResponse.json(report);
}

export async function POST(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const action = String(body?.action ?? "");
  const email = String(body?.email ?? "").trim().toLowerCase();
  if (action !== "rearm" || !email) {
    return NextResponse.json({ error: "action:rearm + email required" }, { status: 400 });
  }
  // Forwarded-aware: the re-arm works from the live public host even before
  // APP_DOMAIN is saved (canonicalWebhookOrigin prefers APP_DOMAIN and rejects
  // unroutable bind addresses, so this can never register 0.0.0.0).
  const result = await reassertWebhook(email, {
    force: true,
    requestOrigin: publicRequestOrigin(req) ?? undefined,
  }).catch((e) => ({
    ok: false,
    changed: false,
    registeredUrl: null,
    error: e instanceof Error ? e.message : "rearm failed",
  }));
  return NextResponse.json(result);
}
