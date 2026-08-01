import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";

// Live service health (item #12): one call probes EVERY measurable service in
// parallel and returns a uniform bar-friendly shape. The keys page refreshes
// this automatically every 10 minutes.
//
// status: "ok" (green) | "degraded" (amber) | "down" (red) | "off" (grey -
// not configured, which is fine: everything degrades gracefully).

interface ServiceHealth {
  id: string;
  label: string;
  status: "ok" | "degraded" | "down" | "off";
  latencyMs: number | null;
  detail: string;
}

const timed = async <T>(fn: () => Promise<T>, ms = 8000): Promise<{ out: T | null; ms: number; timedOut: boolean }> => {
  const t0 = Date.now();
  try {
    const out = await Promise.race<T | null>([
      fn(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
    ]);
    return { out, ms: Date.now() - t0, timedOut: out === null && Date.now() - t0 >= ms };
  } catch {
    return { out: null, ms: Date.now() - t0, timedOut: false };
  }
};

export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const checks: Promise<ServiceHealth>[] = [
    // Supabase - the durable store everything leans on.
    (async (): Promise<ServiceHealth> => {
      const { supabaseDiagnostics } = await import("@/lib/runtime-config");
      const r = await timed(() => supabaseDiagnostics());
      const d = r.out;
      if (!d) return { id: "supabase", label: "Supabase (database)", status: "down", latencyMs: r.ms, detail: "Diagnostics timed out." };
      if (!d.configured) return { id: "supabase", label: "Supabase (database)", status: "off", latencyMs: null, detail: "Not configured - demo mode." };
      const ok = d.reachable && d.appConfigOk;
      return {
        id: "supabase",
        label: "Supabase (database)",
        status: ok ? "ok" : d.reachable ? "degraded" : "down",
        latencyMs: r.ms,
        detail: d.detail || (ok ? "Connected." : "Connection failed."),
      };
    })(),

    // Google Maps - vendors, geocoding, photos.
    (async (): Promise<ServiceHealth> => {
      const { runMapsDiagnostics } = await import("@/lib/google");
      const r = await timed(() => runMapsDiagnostics());
      const d = r.out;
      if (!d) return { id: "maps", label: "Google Maps", status: "down", latencyMs: r.ms, detail: "Diagnostics timed out." };
      if (!d.keyConfigured) return { id: "maps", label: "Google Maps", status: "off", latencyMs: null, detail: "No key - demo shop list." };
      const parts = [d.placesNew.ok, d.placesLegacy.ok, d.geocoding.ok];
      const okCount = parts.filter(Boolean).length;
      return {
        id: "maps",
        label: "Google Maps",
        status: okCount === parts.length ? "ok" : okCount > 0 ? "degraded" : "down",
        latencyMs: r.ms,
        detail:
          okCount === parts.length
            ? "Places + Geocoding healthy."
            : `${okCount}/${parts.length} APIs answering - check the key restrictions.`,
      };
    })(),

    // AI brain - one real round-trip through the provider failover chain.
    (async (): Promise<ServiceHealth> => {
      const { aiEnabled, chat } = await import("@/lib/ai");
      if (!(await aiEnabled())) {
        return { id: "ai", label: "AI providers", status: "off", latencyMs: null, detail: "No AI key - deterministic agents." };
      }
      const r = await timed(() => chat([{ role: "user", content: "Reply with exactly: pong" }], { budgetMs: 9000 }), 10000);
      const ok = typeof r.out === "string" && r.out.length > 0;
      return {
        id: "ai",
        label: "AI providers",
        status: ok ? (r.ms > 6000 ? "degraded" : "ok") : "down",
        latencyMs: r.ms,
        detail: ok ? "Live completion round-trip succeeded." : "No provider answered - check keys/quotas.",
      };
    })(),

    // Evolution WhatsApp host pool.
    (async (): Promise<ServiceHealth> => {
      const { evolutionConfigured, pingAllHosts } = await import("@/lib/evolution");
      if (!(await evolutionConfigured())) {
        return { id: "whatsapp", label: "WhatsApp hosts", status: "off", latencyMs: null, detail: "No Evolution host configured." };
      }
      const r = await timed(() => pingAllHosts());
      const hosts = r.out ?? [];
      const up = hosts.filter((h) => h.ok).length;
      return {
        id: "whatsapp",
        label: "WhatsApp hosts",
        status: hosts.length === 0 ? "down" : up === hosts.length ? "ok" : up > 0 ? "degraded" : "down",
        latencyMs: r.ms,
        detail: hosts.length ? `${up}/${hosts.length} hosts awake.` : "No hosts reachable.",
      };
    })(),

    // Email (verification codes + feedback).
    (async (): Promise<ServiceHealth> => {
      const { emailVerificationAvailable } = await import("@/lib/verify");
      const r = await timed(() => emailVerificationAvailable());
      const on = r.out === true;
      return {
        id: "email",
        label: "Email (Gmail/Brevo/Resend)",
        status: on ? "ok" : "off",
        latencyMs: on ? r.ms : null,
        detail: on
          ? "A provider is configured - signup codes will send."
          : "No email key - invited testers sign up WITHOUT a code.",
      };
    })(),

    // PayPal billing.
    (async (): Promise<ServiceHealth> => {
      const { getConfig } = await import("@/lib/runtime-config");
      const [id, secret, env] = await Promise.all([
        getConfig("PAYPAL_CLIENT_ID"),
        getConfig("PAYPAL_CLIENT_SECRET"),
        getConfig("PAYPAL_ENV"),
      ]);
      if (!id || !secret) {
        return { id: "billing", label: "PayPal (billing)", status: "off", latencyMs: null, detail: "Not configured - plans stay free." };
      }
      const base =
        (env ?? "live").trim().toLowerCase() === "sandbox"
          ? "https://api-m.sandbox.paypal.com"
          : "https://api-m.paypal.com";
      const r = await timed(async () => {
        const basic = Buffer.from(`${id.trim()}:${secret.trim()}`).toString("base64");
        const res = await fetch(`${base}/v1/oauth2/token`, {
          method: "POST",
          headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
          body: "grant_type=client_credentials",
          cache: "no-store",
        });
        return res.ok;
      });
      return {
        id: "billing",
        label: "PayPal (billing)",
        status: r.out === true ? "ok" : "down",
        latencyMs: r.ms,
        detail: r.out === true ? "Credentials valid." : "API rejected the credentials - test in Keys.",
      };
    })(),
  ];

  const services = await Promise.all(checks);

  // Suppression/degradation counters (last 24h): the observability layer for
  // the send pipeline - a spike here is the first sign something is being
  // held back (cancellations firing, claims contended, fail-closed holds,
  // structurally illegal phase jumps).
  const { sbSelect } = await import("@/lib/runtime-config");
  const sinceIso = new Date(Date.now() - 24 * 3600_000).toISOString();
  const guardKinds = [
    "cancelled-send-blocked",
    "takeover-send-blocked",
    "claim-lost",
    "bargain-blocked",
    "phase-anomaly",
    "ambiguous-inbound",
    "wa-send-dropped",
    // THE GUARD'S OWN TERMINAL REFUSALS. `send-dropped` is what
    // recordSendDropped() writes when a message is refused for good -
    // duplicate-suppressed, rfq-dedup, engagement-halt - and it is a DIFFERENT
    // kind from "wa-send-dropped" (which the drain writes when a send is
    // attempted and fails). One letter of difference, and the consequence was
    // that the three most terminal drops in the system appeared on no admin
    // surface at all: they never touch wa_outbox either, so the queue view
    // cannot show them and this counter did not count them.
    "send-dropped",
    // A draft binned for being answered by events. Rare and important: it means
    // the shop moved on before we spoke, and the thread was handed a fresh turn.
    "wa-send-stale",
    // Which brain answered. A wakeup turn silently running the old engine is
    // exactly the failure that survived a full deploy-and-verify cycle.
    "engine-graph-turn",
  ];
  const eventRows = await sbSelect<{ kind: string }>(
    "agent_events",
    `select=kind&kind=in.(${guardKinds.join(",")})&created_at=gte.${encodeURIComponent(
      sinceIso
    )}&limit=500`
  ).catch(() => []);
  const guardCounters: Record<string, number> = {};
  for (const k of guardKinds) guardCounters[k] = 0;
  for (const r of eventRows) guardCounters[r.kind] = (guardCounters[r.kind] ?? 0) + 1;

  // WEBHOOK SILENCE DETECTOR: the launch-blocker signature is "we sent messages
  // recently, ≥1 session is open, but NO inbound arrived and NO webhook was
  // accepted in the last 30 min" - i.e. Evolution is 403ing our webhook (stale
  // token / lost registration). Surfaced so the Command tab can shout, instead
  // of the failure being invisible like it was in the live incident.
  const now = Date.now();
  const iso30 = new Date(now - 30 * 60_000).toISOString();
  const iso60 = new Date(now - 60 * 60_000).toISOString();
  const [outbound60, inbound30, webhookOk30, openSessions] = await Promise.all([
    sbSelect<{ id: number }>(
      "whatsapp_messages",
      `select=id&direction=eq.outbound&received_at=gte.${encodeURIComponent(iso60)}&limit=1`
    ).catch(() => []),
    sbSelect<{ id: number }>(
      "whatsapp_messages",
      `select=id&direction=eq.inbound&received_at=gte.${encodeURIComponent(iso30)}&limit=1`
    ).catch(() => []),
    sbSelect<{ id: number; created_at: string; detail: string | null }>(
      "agent_events",
      `select=id,created_at,detail&kind=eq.webhook-ok&created_at=gte.${encodeURIComponent(
        iso30
      )}&order=created_at.desc&limit=1`
    ).catch(() => []),
    sbSelect<{ email: string }>(
      "wa_sessions",
      `select=email&status=eq.open&limit=1`
    ).catch(() => []),
  ]);
  const webhookSilent =
    outbound60.length > 0 &&
    inbound30.length === 0 &&
    webhookOk30.length === 0 &&
    openSessions.length > 0;

  return NextResponse.json({
    services,
    guardCounters,
    webhookSilent,
    webhookLastAcceptedAt: webhookOk30[0]?.created_at ?? null,
    checkedAt: new Date().toISOString(),
  });
}

// maxDuration: lift the request-timeout ceiling for slow upstreams.
export const maxDuration = 60;
