"use client";

// WA DOCTOR card (management-only) - the one-tap inbound incident tracer. Enter
// a linked user's email (and optionally a shop number), Run, and read a
// green/amber/red checklist of the whole inbound chain, plus a "Re-arm webhook"
// button that force-pushes the current-token URL to Evolution.

import { useState } from "react";
import { LoadingDots } from "../LoadingDots";

type TokenState = "current" | "foreign" | "none";
interface DoctorReport {
  email: string;
  instance: string;
  hosts: { url: string; ok: boolean; detail: string }[];
  session: { status: string | null; hostUrl: string | null; updatedAt: string | null };
  liveState: string | null;
  webhook: {
    expectedUrl: string | null;
    registeredUrl: string | null;
    tokenState: TokenState;
    originMatch: boolean | null;
    lastAcceptedAt: string | null;
    last403At: string | null;
  };
  thread?: {
    digits: string;
    anchors: { at: string; kind: string | null; hasRfq: boolean }[];
    gate: { ingestible: boolean; reason: string };
    ctxRfqPresent: boolean;
    takenOver: boolean | null;
    paused: boolean | null;
    recentInbound: { at: string; id: string }[];
    lastDropTrace: { at: string; detail: string } | null;
  };
}

function Row({ ok, label, value }: { ok: boolean | null; label: string; value: string }) {
  const dot = ok === true ? "bg-savings" : ok === false ? "bg-brandred" : "bg-brandyellow";
  return (
    <div className="flex items-start justify-between gap-2 border-t border-line py-1.5 first:border-t-0">
      <span className="flex items-center gap-1.5 text-[11px] font-bold text-soft">
        <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
        {label}
      </span>
      <span className="max-w-[60%] break-words text-right text-[11px] font-extrabold text-strong">
        {value}
      </span>
    </div>
  );
}

export function WaDoctorCard() {
  const [email, setEmail] = useState("");
  const [number, setNumber] = useState("");
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [rearmMsg, setRearmMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (!email.trim()) return;
    setBusy(true);
    setErr(null);
    setRearmMsg(null);
    try {
      const q = new URLSearchParams({ email: email.trim() });
      if (number.trim()) q.set("number", number.trim());
      const res = await fetch(`/api/admin/wa-doctor?${q.toString()}`);
      const d = await res.json();
      if (d.error) setErr(String(d.error));
      else setReport(d as DoctorReport);
    } catch {
      setErr("Could not reach the doctor endpoint.");
    } finally {
      setBusy(false);
    }
  }

  async function rearm() {
    if (!email.trim()) return;
    setBusy(true);
    setRearmMsg(null);
    try {
      const res = await fetch("/api/admin/wa-doctor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rearm", email: email.trim() }),
      });
      const d = await res.json();
      setRearmMsg(
        d.ok
          ? d.changed
            ? "✓ Webhook re-armed with the current token."
            : "✓ Webhook already pointed at the current URL."
          : `⚠ Re-arm skipped${d.skipped ? ` (${d.skipped})` : ""}.`
      );
      await run();
    } catch {
      setRearmMsg("⚠ Re-arm request failed.");
    } finally {
      setBusy(false);
    }
  }

  const w = report?.webhook;
  const ago = (iso?: string | null) =>
    iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "never";

  return (
    <details className="surface rounded-blob p-4">
      <summary className="flex cursor-pointer list-none items-center justify-between">
        <span className="text-[13px] font-extrabold text-strong">🩺 WA doctor</span>
        <span className="rounded-full bg-brandblue-soft px-2 py-0.5 text-[10px] font-extrabold text-brandblue">
          inbound tracer ▾
        </span>
      </summary>

      <div className="mt-3 space-y-2">
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="user email (linked WhatsApp)"
            className="min-w-0 flex-1 rounded-xl border-2 border-line bg-card2 px-3 py-2 text-[13px] text-strong"
          />
          <input
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            placeholder="shop number (optional)"
            className="min-w-0 flex-1 rounded-xl border-2 border-line bg-card2 px-3 py-2 text-[13px] text-strong"
          />
        </div>
        <div className="flex gap-2">
          <button
            onClick={run}
            disabled={busy || !email.trim()}
            className="btn btn-sm btn-primary flex-1 rounded-xl py-2 text-[12px] font-extrabold disabled:opacity-50"
          >
            {busy ? <LoadingDots /> : "Run diagnosis"}
          </button>
          <button
            onClick={rearm}
            disabled={busy || !email.trim()}
            className="btn btn-sm rounded-xl border-2 border-brandblue px-3 text-[12px] font-extrabold text-brandblue disabled:opacity-50"
          >
            Re-arm webhook
          </button>
        </div>
        {rearmMsg && <p className="text-[11px] font-bold text-soft">{rearmMsg}</p>}
        {err && <p className="text-[11px] font-bold text-brandred">{err}</p>}

        {report && w && (
          <div className="mt-2 rounded-2xl bg-card2 p-3">
            <Row
              ok={w.tokenState === "current" && w.originMatch !== false}
              label="Webhook registered on Evolution"
              value={
                w.registeredUrl
                  ? `token: ${w.tokenState}${w.originMatch === false ? " · WRONG origin" : ""}`
                  : "none found"
              }
            />
            <Row
              ok={Boolean(w.lastAcceptedAt)}
              label="Last accepted webhook"
              value={ago(w.lastAcceptedAt)}
            />
            <Row
              ok={w.last403At ? false : null}
              label="Last 403 (rejected)"
              value={ago(w.last403At)}
            />
            <Row
              ok={String(report.session.status ?? "").toLowerCase() === "open" ? true : false}
              label="Session (durable mirror)"
              value={report.session.status ?? "none"}
            />
            <Row ok={report.liveState === "open" ? true : null} label="Live connection" value={report.liveState ?? "unknown"} />
            <Row
              ok={report.hosts.every((h) => h.ok) ? true : false}
              label="Evolution hosts"
              value={`${report.hosts.filter((h) => h.ok).length}/${report.hosts.length} healthy`}
            />

            {report.thread && (
              <>
                <div className="mt-2 border-t border-line pt-2 text-[11px] font-extrabold text-strong">
                  Thread {report.thread.digits}
                </div>
                <Row
                  ok={report.thread.gate.ingestible}
                  label="Ingest gate"
                  value={`${report.thread.gate.ingestible ? "OK" : "DROP"} · ${report.thread.gate.reason}`}
                />
                <Row ok={report.thread.ctxRfqPresent} label="RFQ thread anchor" value={report.thread.ctxRfqPresent ? "present" : "MISSING"} />
                <Row
                  ok={report.thread.takenOver === false ? true : report.thread.takenOver === true ? false : null}
                  label="Human takeover hold"
                  value={report.thread.takenOver === true ? "HELD" : report.thread.takenOver === false ? "no" : "unreadable"}
                />
                <Row
                  ok={report.thread.paused === false ? true : report.thread.paused === true ? false : null}
                  label="Session pause hold"
                  value={report.thread.paused === true ? "PAUSED" : report.thread.paused === false ? "no" : "unreadable"}
                />
                <Row
                  ok={report.thread.recentInbound.length > 0 ? true : null}
                  label="Recent inbound stored"
                  value={`${report.thread.recentInbound.length} rows`}
                />
                {report.thread.lastDropTrace && (
                  <Row ok={false} label="Last drop trace" value={report.thread.lastDropTrace.detail.slice(0, 60)} />
                )}
              </>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
