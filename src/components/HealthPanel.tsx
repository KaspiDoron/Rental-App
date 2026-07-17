"use client";

// Live service health (item #12): one bar per measurable service, refreshed
// automatically every 10 minutes while the Keys tab is open, with the last
// check time and a countdown to the next one.

import { useEffect, useRef, useState } from "react";
import { LoadingDots } from "./LoadingDots";

interface ServiceHealth {
  id: string;
  label: string;
  status: "ok" | "degraded" | "down" | "off";
  latencyMs: number | null;
  detail: string;
}

const REFRESH_MS = 10 * 60_000;

const STATUS_META: Record<ServiceHealth["status"], { bar: string; width: string; label: string; text: string }> = {
  ok: { bar: "bg-savings", width: "w-full", label: "HEALTHY", text: "text-savings" },
  degraded: { bar: "bg-brandyellow", width: "w-2/3", label: "DEGRADED", text: "text-[#8a6100] dark:text-brandyellow" },
  down: { bar: "bg-brandred", width: "w-1/4", label: "DOWN", text: "text-brandred" },
  off: { bar: "bg-line", width: "w-1/12", label: "NOT SET", text: "text-faint" },
};

export function HealthPanel() {
  const [services, setServices] = useState<ServiceHealth[] | null>(null);
  const [guardCounters, setGuardCounters] = useState<Record<string, number> | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [busy, setBusy] = useState(false);
  const [nextInS, setNextInS] = useState(REFRESH_MS / 1000);
  const timer = useRef<ReturnType<typeof setInterval>>();

  async function check() {
    setBusy(true);
    try {
      const d = await (await fetch("/api/admin/health")).json();
      if (Array.isArray(d.services)) {
        setServices(d.services);
        setCheckedAt(new Date());
        setNextInS(REFRESH_MS / 1000);
      }
      if (d.guardCounters) setGuardCounters(d.guardCounters);
    } catch {
      /* keep the last snapshot */
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    check();
    const refresh = setInterval(check, REFRESH_MS);
    timer.current = setInterval(() => setNextInS((s) => Math.max(0, s - 1)), 1000);
    return () => {
      clearInterval(refresh);
      clearInterval(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const live = services?.filter((s) => s.status !== "off") ?? [];
  const okCount = live.filter((s) => s.status === "ok").length;
  const overall =
    live.length === 0
      ? "off"
      : live.some((s) => s.status === "down")
      ? "down"
      : live.some((s) => s.status === "degraded")
      ? "degraded"
      : "ok";
  const overallMeta = STATUS_META[overall as ServiceHealth["status"]];
  const mins = Math.floor(nextInS / 60);

  return (
    <div className="surface rounded-blob p-4">
      <div className="mb-1 flex items-center justify-between">
        <div className="text-[13px] font-extrabold text-strong">🩺 Service health</div>
        <button
          onClick={check}
          disabled={busy}
          className="btn btn-sm chip rounded-xl border-2 border-line px-3 text-[11px] font-extrabold text-brandblue disabled:opacity-60"
        >
          {busy ? <LoadingDots /> : "↻ Check now"}
        </button>
      </div>
      <p className="mb-2 text-[10px] text-faint">
        {checkedAt
          ? `Last checked ${checkedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · next auto-check in ${mins}m ${Math.floor(nextInS % 60)}s`
          : "Running the first check..."}
      </p>

      {/* Overall bar */}
      {services && (
        <div className="mb-3 rounded-2xl bg-card2 p-2.5">
          <div className="flex items-center justify-between text-[11px] font-extrabold">
            <span className="text-strong">Overall</span>
            <span className={overallMeta.text}>
              {okCount}/{live.length || 0} healthy
            </span>
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-line/50">
            <div
              className={`h-full rounded-full ${overallMeta.bar} transition-all`}
              style={{ width: live.length ? `${Math.max(8, (okCount / live.length) * 100)}%` : "8%" }}
            />
          </div>
        </div>
      )}

      {!services ? (
        <LoadingDots label="Probing every service" />
      ) : (
        <div className="space-y-2">
          {services.map((s) => {
            const m = STATUS_META[s.status];
            return (
              <div key={s.id} className="rounded-2xl bg-card2 p-2.5">
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="font-extrabold text-strong">{s.label}</span>
                  <span className={`shrink-0 font-extrabold ${m.text}`}>
                    {m.label}
                    {s.latencyMs != null && s.status !== "off" ? ` · ${s.latencyMs}ms` : ""}
                  </span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-line/50">
                  <div className={`h-full rounded-full ${m.bar} ${m.width} transition-all`} />
                </div>
                <p className="mt-1 text-[10px] text-faint">{s.detail}</p>
              </div>
            );
          })}
        </div>
      )}

      {guardCounters && Object.values(guardCounters).some((n) => n > 0) && (
        <div className="mt-2 rounded-2xl bg-card2 p-2.5">
          <div className="text-[11px] font-extrabold text-strong">Send-pipeline guardrails (24h)</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {Object.entries(guardCounters)
              .filter(([, n]) => n > 0)
              .map(([k, n]) => (
                <span
                  key={k}
                  className="rounded-full bg-card px-2 py-0.5 text-[10px] font-bold text-soft"
                >
                  {k}: {n}
                </span>
              ))}
          </div>
        </div>
      )}
      <CronUrlCard />
    </div>
  );
}

// Ready-made cron ping URL (with the derived security token) to paste straight
// into cron-job.org - so the owner never has to compute the token by hand.
function CronUrlCard() {
  const [data, setData] = useState<
    { tokenReady: boolean; pingUrl?: string; webhookUrl?: string; reason?: string } | null
  >(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/ping-url")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setData(d))
      .catch(() => {});
  }, []);

  async function copy(text: string, which: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard blocked - the field is selectable anyway */
    }
  }

  if (!data) return null;

  return (
    <div className="mt-3 rounded-2xl border-2 border-line p-3">
      <div className="text-[12px] font-extrabold text-strong">⏰ Cron keep-alive URL</div>
      {!data.tokenReady ? (
        <p className="mt-1 text-[11px] font-bold text-brandred">{data.reason}</p>
      ) : (
        <>
          <p className="mt-1 text-[10px] text-faint">
            Point cron-job.org (or any free pinger) at this every 5-10 minutes. It keeps the
            WhatsApp hosts awake and sends any queued messages. The token is built in - do NOT
            change it.
          </p>
          {(
            [
              ["Ping URL", data.pingUrl!, "ping"],
              ["Evolution webhook URL", data.webhookUrl!, "hook"],
            ] as [string, string, string][]
          ).map(([label, url, key]) => (
            <div key={key} className="mt-2">
              <div className="text-[10px] font-bold text-faint">{label}</div>
              <div className="mt-1 flex items-center gap-1.5">
                <input
                  readOnly
                  value={url}
                  onFocus={(e) => e.currentTarget.select()}
                  className="min-w-0 flex-1 rounded-lg border-2 border-line bg-card p-2 font-mono text-[11px] text-strong"
                />
                <button
                  onClick={() => copy(url, key)}
                  className="btn btn-sm shrink-0 rounded-lg bg-brandblue px-3 py-2 text-[11px] font-extrabold text-white"
                >
                  {copied === key ? "Copied ✓" : "Copy"}
                </button>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
