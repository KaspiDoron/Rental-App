"use client";

import { useEffect, useState } from "react";
// The sample floor is IMPORTED, not re-chosen here. Rule E4 exists once, in the
// fail-dark contract, and a panel that picked its own threshold would be free
// to render a reply rate from two introductions - which is the theatre this
// whole screen was built to stop.
import { hasEnoughSample } from "@/lib/wa/risk-verdict";

// THE BAN RISK PANEL.
//
// Three rules govern this file, and all three come from defects this repo has
// already shipped.
//
// 1. METER INTEGRITY RENDERS FIRST. If the meters cannot be verified, every
//    figure below is unverified too, and the panel says so before it shows a
//    single number. That ordering is the non-negotiable part - a green risk
//    score over a dead sensor is the most expensive lie available here.
// 2. THE TWO AXES ARE NEVER COMBINED. Velocity (a scoped new-chat restriction)
//    and client detection (a full ban, which fires on reply-only accounts with
//    zero sends) have different causes and different penalties. A single 0-100
//    number cannot represent either, and the blend would hide the worse one.
// 3. CONFIDENCE IS DISPLAYED BESIDE THE FIGURES, NEVER FOLDED INTO THEM. Fold
//    it in and the score goes DOWN when the sensors die, which is precisely
//    backwards.
//
// Mobile first: two columns at 320px, stacked cards rather than a table, no
// horizontal overflow.

interface Report {
  buckets: { bucket: string; accounts: number }[];
  staleHours: number | null;
  stale: boolean;
  velocity: { intros: number; answered: number; suspected: number };
  client: { logouts: number; forbidden: number; replaced: number; deaf: number };
  meter: { delivered: number; read: number; failed: number; invalid: number; blocked: number };
  dark: string[];
  truncated: boolean;
  verdict: "ok" | "warn" | "critical" | "dark" | "empty";
}

interface Fleet {
  instances: { name: string; state: string | null; disconnectCode: number | null; host: string }[];
  hostsOk: string[];
  hostsDark: { host: string; reason: string }[];
  dualSockets: string[];
}

/** Unknown renders as a dash. Never as zero - that is the whole contract. */
function Num({ v }: { v: number | null }) {
  if (v === null) return <span className="text-faint" title="Could not be read">&mdash;</span>;
  return <span className="tabular-nums">{v.toLocaleString()}</span>;
}

function Tile({ label, value, hint }: { label: string; value: number | null; hint?: string }) {
  return (
    <div className="rounded-xl bg-card2 px-2.5 py-2">
      <div className="text-[10px] font-extrabold uppercase text-faint">{label}</div>
      <div className="text-[15px] font-extrabold text-strong">
        <Num v={value} />
      </div>
      {hint && <div className="mt-0.5 text-[10px] text-faint">{hint}</div>}
    </div>
  );
}

/**
 * Its own component so `dark` can never be styled by accident as a muted `ok`.
 * That has happened before in this codebase, and a dark tile that looks calm is
 * indistinguishable from a healthy one at a glance.
 */
function DarkBadge({ reason }: { reason: string }) {
  return (
    <span className="rounded-full bg-brandyellow-soft px-2 py-0.5 text-[10px] font-extrabold text-[#8a6100] dark:text-brandyellow">
      unreadable: {reason}
    </span>
  );
}

export default function BanRiskPanel() {
  const [data, setData] = useState<{ report: Report; fleet: Fleet | null; disclaimer: string } | null>(
    null
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setError("");
    try {
      const res = await fetch("/api/admin/ban-risk", { cache: "no-store" });
      if (!res.ok) {
        setError(`Could not load (HTTP ${res.status}).`);
        return;
      }
      setData(await res.json());
    } catch {
      setError("Could not load - the request failed.");
    }
  };

  useEffect(() => {
    void load();
  }, []);

  if (error) {
    return (
      <div className="surface rounded-blob p-3 text-[12px] text-soft">
        {/* An error here is itself a dark state, and it is worth saying that
            plainly rather than showing an empty panel that reads as calm. */}
        ⚠ {error} Nothing below could be verified.
      </div>
    );
  }
  if (!data) return <div className="surface rounded-blob p-3 text-[12px] text-faint">Loading…</div>;

  const { report, fleet } = data;
  // Meter integrity is Axis 0. Everything below it is conditional on it.
  const metersDark = report.stale || report.dark.length > 0;
  const receiptsFlowing = report.meter.delivered + report.meter.read;

  return (
    <div className="space-y-3">
      {/* ---- AXIS 0: can we believe anything on this page? ---------------- */}
      <div
        className={`surface rounded-blob p-3 ${
          metersDark ? "ring-2 ring-brandyellow" : ""
        }`}
      >
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-extrabold text-strong">🩺 Meter integrity</span>
          {report.dark.map((d) => (
            <DarkBadge key={d} reason={d} />
          ))}
          {report.stale && (
            <DarkBadge
              reason={
                report.staleHours === null
                  ? "no rollup has ever run"
                  : `rollup is ${report.staleHours}h old`
              }
            />
          )}
          {report.truncated && (
            <span className="rounded-full bg-card2 px-2 py-0.5 text-[10px] font-extrabold text-soft">
              some hours were capped - counts are a floor
            </span>
          )}
        </div>
        {metersDark ? (
          <p className="text-[11px] font-bold text-[#8a6100] dark:text-brandyellow">
            Meters unverified - every figure below may be wrong.
          </p>
        ) : (
          <p className="text-[11px] text-soft">
            Receipts and events are arriving. Figures below are as good as the last{" "}
            {report.buckets.length} hourly buckets.
          </p>
        )}
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Tile label="Delivery receipts" value={report.meter.delivered} />
          <Tile label="Read receipts" value={report.meter.read} />
          <Tile
            label="Dead numbers"
            value={report.meter.invalid}
            hint="not on WhatsApp - a listing fact, not a sender fault"
          />
          <Tile label="Recipient blocks" value={report.meter.blocked} />
        </div>
        {receiptsFlowing === 0 && !metersDark && (
          <p className="mt-1.5 text-[10px] text-faint">
            No receipts in this window. That is normal for an idle fleet and is also what a
            broken receipt pipeline looks like - the two are only separable once sending resumes.
          </p>
        )}
      </div>

      {/* ---- AXIS 1: velocity. Scoped restriction. ------------------------ */}
      <div className={`surface rounded-blob p-3 ${metersDark ? "opacity-60" : ""}`}>
        <div className="mb-1.5 text-[13px] font-extrabold text-strong">
          📈 Velocity - scoped new-chat restriction
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Tile label="Introductions" value={report.velocity.intros} />
          <Tile
            label="Answered"
            value={report.velocity.answered}
            hint="a reply is what clears the metered count"
          />
          <Tile
            label="Cold refusals"
            value={report.velocity.suspected}
            hint="suspected - a restriction is a lane asymmetry, not one error"
          />
        </div>
        {/* E4: never a ratio below the sample floor. A reply rate from two
            introductions is theatre, and this panel exists to stop theatre. */}
        {hasEnoughSample(report.velocity.intros) ? (
          <p className="mt-1.5 text-[11px] text-soft">
            Reply rate {Math.round((report.velocity.answered / report.velocity.intros) * 100)}% over{" "}
            {report.velocity.intros} introductions.
          </p>
        ) : (
          <p className="mt-1.5 text-[11px] text-faint">
            {report.velocity.answered} replies / {report.velocity.intros} introductions - the
            fraction, because that is too small a sample for a rate.
          </p>
        )}
      </div>

      {/* ---- AXIS 2: client detection. Full ban. -------------------------- */}
      <div className={`surface rounded-blob p-3 ${metersDark ? "opacity-60" : ""}`}>
        <div className="mb-1.5 text-[13px] font-extrabold text-strong">
          🔌 Client detection - full ban
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Tile label="Logged out (401)" value={report.client.logouts} />
          <Tile label="Forbidden (403)" value={report.client.forbidden} />
          <Tile label="Replaced (440)" value={report.client.replaced} />
          <Tile label="Deaf sessions" value={report.client.deaf} />
        </div>
        <p className="mt-1.5 text-[11px] text-faint">
          This axis fires on accounts doing reply-only work, with zero sends. Pacing, ordering and
          metering do not move it, and it is correlated across the whole fleet rather than
          per-account - so it is reported as events, never as a rate.
        </p>
      </div>

      {/* ---- Transport: what the hosts actually say ----------------------- */}
      <div className="surface rounded-blob p-3">
        <div className="mb-1.5 text-[13px] font-extrabold text-strong">🛰 Fleet</div>
        {fleet === null ? (
          <p className="text-[11px] font-bold text-[#8a6100] dark:text-brandyellow">
            ⚠ Could not read any Evolution host. This is not an empty fleet - it is an unknown one.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Tile label="Instances" value={fleet.instances.length} />
              <Tile
                label="Open"
                value={fleet.instances.filter((i) => i.state === "open").length}
              />
              <Tile label="Hosts answering" value={fleet.hostsOk.length} />
              <Tile
                label="Dual sockets"
                value={fleet.dualSockets.length}
                hint="same instance open on two hosts"
              />
            </div>
            {fleet.hostsDark.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {fleet.hostsDark.map((h) => (
                  <DarkBadge key={h.host} reason={`${h.host} - ${h.reason}`} />
                ))}
              </div>
            )}
            {fleet.dualSockets.length > 0 && (
              <p className="mt-1.5 text-[11px] font-bold text-[#8a6100] dark:text-brandyellow">
                {fleet.dualSockets.length} instance(s) open on more than one host. WhatsApp answers
                this with connectionReplaced - fix per-host ownership before adding hosts.
              </p>
            )}
          </>
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <button
          onClick={async () => {
            setBusy(true);
            await fetch("/api/admin/ban-risk", { method: "POST" }).catch(() => {});
            await load();
            setBusy(false);
          }}
          disabled={busy}
          className="btn fluid-press rounded-full bg-card2 px-3 py-1.5 text-[11px] font-extrabold text-soft disabled:opacity-50"
        >
          {busy ? "Rolling up…" : "Roll up the last closed hour"}
        </button>
      </div>

      {/* The footer is part of the contract, not decoration. */}
      <p className="px-1 text-[10px] text-faint">{data.disclaimer}</p>
    </div>
  );
}
