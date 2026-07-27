"use client";

// Block approvals - the only screen in the app that can restrict a traveller,
// and the reason the integrity ladder is allowed to have a top rung at all.
//
// Everything below the top rung happens without anyone here: a nudge explains
// the plan rule, a pause runs out on its own, the evidence decays. What reaches
// this panel is a pattern the system will not act on by itself, with the exact
// words that produced it, and a decision that is recorded with the owner's name
// on it. Rejecting is one tap, costs the traveller nothing, and re-opens by
// itself if new evidence arrives.

import { useCallback, useEffect, useState } from "react";
import { LoadingDots } from "../LoadingDots";
import type { ProposalCase } from "@/lib/integrity/adjudication";

interface Preset {
  label: string;
  minutes: number;
}
interface QueueData {
  proposals: ProposalCase[];
  decided: ProposalCase[];
  watch: ProposalCase[];
  presets: Preset[];
}

const STEP_LABEL: Record<string, string> = {
  clear: "clear",
  nudge: "nudged",
  cooldown: "short pause",
  limit: "custom messages paused",
  "propose-block": "review proposed",
};

function ago(ms: number): string {
  if (!ms) return "";
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export function IntegrityPanel() {
  const [data, setData] = useState<QueueData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [minutes, setMinutes] = useState<Record<string, number>>({});
  const [alsoAccount, setAlsoAccount] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    const d = await fetch("/api/admin/ops/integrity")
      .then((r) => r.json())
      .catch(() => null);
    setData({
      proposals: Array.isArray(d?.proposals) ? d.proposals : [],
      decided: Array.isArray(d?.decided) ? d.decided : [],
      watch: Array.isArray(d?.watch) ? d.watch : [],
      presets: Array.isArray(d?.presets) ? d.presets : [],
    });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (data === null) return <LoadingDots label="Loading the review queue" />;

  const decide = async (
    email: string,
    action: "approve" | "reject" | "lift",
    extra?: { minutes?: number; restrictAccount?: boolean }
  ) => {
    setBusy(`${email}:${action}`);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/ops/integrity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          action,
          note: notes[email] ?? "",
          minutes: extra?.minutes ?? minutes[email] ?? 0,
          restrictAccount: extra?.restrictAccount ?? alsoAccount[email] ?? false,
        }),
      });
      const d = await res.json();
      if (res.ok) {
        setMsg({
          tone: "ok",
          text:
            action === "approve"
              ? "Restriction applied - it expires on its own and you can lift it any time."
              : action === "lift"
                ? "Lifted, and the evidence cleared."
                : "Marked as no problem. Nothing was restricted.",
        });
        await load();
      } else {
        setMsg({ tone: "bad", text: d?.error ?? "Failed." });
      }
    } catch {
      setMsg({ tone: "bad", text: "Could not reach the server." });
    } finally {
      setBusy(null);
    }
  };

  const { proposals, decided, watch, presets } = data;

  return (
    <div className="space-y-3">
      {msg && (
        <p
          className={`rounded-blob px-3 py-2 text-[11px] font-extrabold ${
            msg.tone === "ok"
              ? "bg-savings-soft text-savings"
              : "bg-brandred-soft text-brandred"
          }`}
        >
          {msg.text}
        </p>
      )}

      <div className="surface rounded-blob p-3.5">
        <h3 className="text-[13px] font-extrabold text-strong">🛡️ Block approvals</h3>
        <p className="mt-0.5 text-[11px] text-soft">
          Nothing here happened automatically. These are travellers whose signals reached the top
          rung - the system paused sending for two hours and stopped, waiting for you. Signals
          expire after 48 hours on their own.
        </p>
      </div>

      {proposals.length === 0 ? (
        <div className="surface rounded-blob p-5 text-center">
          <p className="text-[20px]">🎉</p>
          <p className="text-[13px] font-extrabold text-strong">Nothing to decide</p>
          <p className="mx-auto mt-1 max-w-[300px] text-[11px] text-soft">
            No traveller has reached the review rung. The ladder is handling everything below it by
            itself.
          </p>
        </div>
      ) : (
        proposals.map((c) => (
          <div key={c.email} className="surface rounded-blob p-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[13px] font-extrabold text-strong">
                {c.email}
              </span>
              <span className="shrink-0 rounded-full bg-card2 px-2 py-0.5 text-[9px] font-extrabold uppercase text-soft">
                {c.plan}
              </span>
              <span className="shrink-0 rounded-full bg-brandred-soft px-2 py-0.5 text-[9px] font-extrabold text-brandred">
                score {c.score}
              </span>
            </div>
            <p className="mt-0.5 text-[10px] text-soft">
              {c.signalCount} signal{c.signalCount === 1 ? "" : "s"} - newest {ago(c.latestSignalAt)}
            </p>

            <p className="mt-2 text-[10px] font-extrabold uppercase tracking-wide text-soft">
              What they wrote
            </p>
            <ul className="mt-1 space-y-1">
              {c.evidence.map((e, i) => (
                <li
                  key={i}
                  className="surface-strong rounded-2xl px-2.5 py-1.5 text-[11px] leading-snug text-strong"
                >
                  {e}
                </li>
              ))}
            </ul>

            <input
              value={notes[c.email] ?? ""}
              onChange={(ev) => setNotes((n) => ({ ...n, [c.email]: ev.target.value }))}
              placeholder="Why - this goes in the audit"
              className="mt-2.5 w-full rounded-2xl bg-card2 px-3 py-2 text-[16px] text-strong outline-none"
            />

            <p className="mt-2 text-[10px] font-extrabold uppercase tracking-wide text-soft">
              Pause sending for
            </p>
            <div className="no-scrollbar mt-1 flex gap-1 overflow-x-auto">
              {presets.map((p) => (
                <button
                  key={p.minutes}
                  onClick={() => setMinutes((m) => ({ ...m, [c.email]: p.minutes }))}
                  className={`btn btn-sm shrink-0 rounded-xl px-3 py-2 text-[11px] font-extrabold ${
                    (minutes[c.email] ?? 0) === p.minutes
                      ? "bg-brandblue text-white"
                      : "text-soft hover:bg-card2"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>

            <label className="mt-2 flex items-center gap-2 text-[11px] text-soft">
              <input
                type="checkbox"
                checked={alsoAccount[c.email] ?? false}
                onChange={(ev) =>
                  setAlsoAccount((a) => ({ ...a, [c.email]: ev.target.checked }))
                }
                className="h-4 w-4"
              />
              Also block sign-in (not just sending)
            </label>

            <div className="mt-2.5 flex gap-2">
              <button
                disabled={busy !== null}
                onClick={() => void decide(c.email, "reject")}
                className="btn btn-sm flex-1 rounded-xl bg-card2 px-3 py-2.5 text-[12px] font-extrabold text-strong disabled:opacity-50"
              >
                {busy === `${c.email}:reject` ? "..." : "Not a problem"}
              </button>
              <button
                disabled={busy !== null || !(minutes[c.email] ?? 0)}
                onClick={() => void decide(c.email, "approve")}
                className="btn btn-sm flex-1 rounded-xl bg-brandred px-3 py-2.5 text-[12px] font-extrabold text-white disabled:opacity-40"
              >
                {busy === `${c.email}:approve` ? "..." : "Restrict"}
              </button>
            </div>
          </div>
        ))
      )}

      {decided.length > 0 && (
        <>
          <p className="px-1 pt-1 text-[10px] font-extrabold uppercase tracking-wide text-soft">
            Decided
          </p>
          {decided.map((c) => (
            <div key={c.email} className="surface rounded-blob p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[12px] font-extrabold text-strong">
                  {c.email}
                </span>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-extrabold ${
                    c.state === "approved"
                      ? "bg-brandred-soft text-brandred"
                      : "bg-card2 text-soft"
                  }`}
                >
                  {c.state}
                </span>
              </div>
              <p className="mt-0.5 text-[10px] text-soft">
                {c.decision?.by ? `${c.decision.by} - ` : ""}
                {ago(c.decision?.at ?? 0)}
                {c.restrictedMinutes > 0 ? ` - ${c.restrictedMinutes} min left` : ""}
                {c.accountBlocked ? " - sign-in blocked" : ""}
              </p>
              {c.decision?.note && (
                <p className="mt-1 text-[11px] leading-snug text-strong">{c.decision.note}</p>
              )}
              {(c.restrictedMinutes > 0 || c.accountBlocked) && (
                <button
                  disabled={busy !== null}
                  onClick={() => void decide(c.email, "lift")}
                  className="btn btn-sm mt-2 w-full rounded-xl bg-card2 px-3 py-2 text-[11px] font-extrabold text-strong disabled:opacity-50"
                >
                  {busy === `${c.email}:lift` ? "..." : "Lift now"}
                </button>
              )}
            </div>
          ))}
        </>
      )}

      {watch.length > 0 && (
        <>
          <p className="px-1 pt-1 text-[10px] font-extrabold uppercase tracking-wide text-soft">
            On the ladder - no decision needed
          </p>
          {watch.map((c) => (
            <div key={c.email} className="surface rounded-blob px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[12px] font-extrabold text-strong">
                  {c.email}
                </span>
                <span className="shrink-0 text-[10px] text-soft">
                  {STEP_LABEL[c.step] ?? c.step}
                </span>
              </div>
              <p className="mt-0.5 text-[10px] text-soft">
                score {c.score} - newest {ago(c.latestSignalAt)}
              </p>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
