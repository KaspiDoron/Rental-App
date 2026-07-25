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
import { isThreadTakenOver, isSessionPaused } from "@/lib/session-flags";
import { digitsOnly } from "@/lib/phone";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const email = (url.searchParams.get("email") || "").trim().toLowerCase();
  const number = digitsOnly(url.searchParams.get("number") || "");
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });

  const enc = encodeURIComponent(email);
  const [diag, sessionRow, waOk, wa403] = await Promise.all([
    webhookDiagnostics(email).catch(() => null),
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
    const [outbound, inbound, dropTrace] = await Promise.all([
      sbSelect<{ received_at: string; raw: GateRaw | null }>(
        "whatsapp_messages",
        `select=received_at,raw&direction=eq.outbound&to_number=eq.${encNum}&raw->>sender=eq.${enc}&order=received_at.desc&limit=10`
      ).catch(() => []),
      sbSelect<{ id: number; received_at: string }>(
        "whatsapp_messages",
        `select=id,received_at&direction=eq.inbound&from_number=eq.${encNum}&raw->>receiver=eq.${enc}&order=received_at.desc&limit=5`
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
    const newestCtx = outbound[0]?.raw;
    const [takenOver, paused] = await Promise.all([
      isThreadTakenOver(email, number).catch(() => null),
      isSessionPaused(email).catch(() => null),
    ]);
    // Match this number's drop traces (detail carries the digits).
    const lastDrop =
      dropTrace.find((d) => (d.detail ?? "").includes(number)) ?? dropTrace[0] ?? null;

    report.thread = {
      digits: number,
      anchors: outbound.map((o) => ({
        at: o.received_at,
        kind: o.raw?.kind ?? null,
        hasRfq: o.raw?.rfq != null,
      })),
      gate: { ingestible: gate.ok, reason: gate.reason },
      ctxRfqPresent: newestCtx?.rfq != null,
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
  const result = await reassertWebhook(email, { force: true }).catch((e) => ({
    ok: false,
    changed: false,
    registeredUrl: null,
    error: e instanceof Error ? e.message : "rearm failed",
  }));
  return NextResponse.json(result);
}
