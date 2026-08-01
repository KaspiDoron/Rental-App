"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/icons";

// "IS WHAT I SHIPPED ACTUALLY RUNNING?"
//
// A whole round of fixes was verified green, deployed, and then behaved exactly
// as before - and there was no way, from a phone, to tell whether the code was
// wrong or the code was never live. This card answers that in one look: the
// revision serving traffic, whether the database has the columns the fixes
// need, whether anything is still calling the drain, and whether the agents
// have a model to think with.

interface Probe {
  ok: boolean;
  detail: string;
}
interface DeployInfo {
  ok: boolean;
  problems: string[];
  build: { sha: string | null; at: string | null; revision: string | null; node: string };
  schema: Record<string, Probe>;
  heartbeat: { lastAt: string | null; ageSec: number | null; ok: boolean; detail: string };
  ai: { configured: boolean; providers: string[]; detail: string };
  at: string;
}

const ageLabel = (sec: number | null): string => {
  if (sec === null) return "never";
  if (sec < 90) return `${sec}s ago`;
  if (sec < 5400) return `${Math.round(sec / 60)} min ago`;
  return `${Math.round(sec / 3600)}h ago`;
};

export default function DeployInfoCard() {
  const [info, setInfo] = useState<DeployInfo | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/deploy-info", { cache: "no-store" });
      setInfo(res.ok ? await res.json() : null);
    } catch {
      setInfo(null);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const tone = !info
    ? "border-line bg-card2 text-soft"
    : info.ok
      ? "border-savings bg-savings-soft text-savings"
      : "border-brandred bg-brandred-soft text-brandred";

  return (
    <div className={`rounded-2xl border-2 p-3 ${tone}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[12px] font-black">
          <Icon name="shield" className="h-4 w-4" />
          What is live right now
        </div>
        <button
          onClick={() => void load()}
          disabled={busy}
          className="rounded-full border-2 border-line bg-card px-2.5 py-1 text-[11px] font-bold text-ink disabled:opacity-50"
        >
          {busy ? "Checking…" : "Re-check"}
        </button>
      </div>

      {!info ? (
        <p className="mt-2 text-[11px] font-semibold">
          {busy ? "Reading the running service…" : "Could not read the deployment state."}
        </p>
      ) : (
        <div className="mt-2 space-y-2 text-[11px] font-semibold text-ink">
          <div className="rounded-xl border-2 border-line bg-card p-2">
            <div className="font-black">Build</div>
            <div className="mt-0.5 break-all">
              {info.build.sha ? `commit ${info.build.sha.slice(0, 8)}` : "commit unknown"}
              {info.build.at ? ` - deployed ${info.build.at}` : ""}
            </div>
            {info.build.revision && <div className="text-soft">revision {info.build.revision}</div>}
          </div>

          <div className="rounded-xl border-2 border-line bg-card p-2">
            <div className="font-black">Heartbeat</div>
            <div className={info.heartbeat.ok ? "text-savings" : "text-brandred"}>
              last drain {ageLabel(info.heartbeat.ageSec)} - {info.heartbeat.detail}
            </div>
          </div>

          <div className="rounded-xl border-2 border-line bg-card p-2">
            <div className="font-black">Database</div>
            <ul className="mt-0.5 space-y-0.5">
              {Object.entries(info.schema).map(([name, p]) => (
                <li key={name} className={p.ok ? "text-savings" : "text-brandred"}>
                  {p.ok ? "OK" : "MISSING"} - {name}
                  {p.ok ? "" : ` (${p.detail})`}
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-xl border-2 border-line bg-card p-2">
            <div className="font-black">Agent brains</div>
            <div className={info.ai.configured ? "text-savings" : "text-brandred"}>
              {info.ai.detail}
              {info.ai.providers.length ? ` (${info.ai.providers.join(", ")})` : ""}
            </div>
          </div>

          {info.problems.length > 0 && (
            <div className="rounded-xl border-2 border-brandred bg-brandred-soft p-2 text-brandred">
              <div className="font-black">Fix these before trusting a field test</div>
              <ul className="mt-0.5 list-disc pl-4">
                {info.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
