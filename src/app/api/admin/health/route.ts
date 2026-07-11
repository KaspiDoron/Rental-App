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

    // Lemon Squeezy billing.
    (async (): Promise<ServiceHealth> => {
      const { getConfig } = await import("@/lib/runtime-config");
      const [key, store] = await Promise.all([
        getConfig("LEMONSQUEEZY_API_KEY"),
        getConfig("LEMONSQUEEZY_STORE_ID"),
      ]);
      if (!key || !store) {
        return { id: "billing", label: "Lemon Squeezy (billing)", status: "off", latencyMs: null, detail: "Not configured - plans stay free." };
      }
      const r = await timed(async () => {
        const res = await fetch("https://api.lemonsqueezy.com/v1/stores/" + encodeURIComponent(store), {
          headers: { Authorization: `Bearer ${key}`, Accept: "application/vnd.api+json" },
          cache: "no-store",
        });
        return res.ok;
      });
      return {
        id: "billing",
        label: "Lemon Squeezy (billing)",
        status: r.out === true ? "ok" : "down",
        latencyMs: r.ms,
        detail: r.out === true ? "Store reachable." : "API rejected the key/store - test in Keys.",
      };
    })(),
  ];

  const services = await Promise.all(checks);
  return NextResponse.json({ services, checkedAt: new Date().toISOString() });
}

// Vercel: allow slow upstreams (Hobby default is ~10s - too short).
export const maxDuration = 60;
