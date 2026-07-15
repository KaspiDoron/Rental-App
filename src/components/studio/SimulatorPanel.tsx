"use client";

import { useEffect, useState } from "react";
import { PlaceAutocomplete } from "../PlaceAutocomplete";
import { LoadingDots } from "../LoadingDots";

interface Stage {
  stage: string;
  nodeId?: string;
  edgeId?: string;
  input: string;
  reasoning: string;
  output: string;
  verdict?: string;
}
interface SimResult {
  direction: string;
  finalMessage: string | null;
  currency: string;
  path?: string[];
  stages: Stage[];
}
interface Scenario {
  id: string;
  label: string;
  input: Record<string, unknown>;
}

// Dry-run the REAL engine against a shop reply / preset scenario and see the
// exact traversed node path + every stage's in/why/out - no WhatsApp traffic.
export function SimulatorPanel() {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [shopReply, setShopReply] = useState("");
  const [region, setRegion] = useState("Bali, Indonesia");
  const [rival, setRival] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SimResult | null>(null);

  useEffect(() => {
    fetch("/api/admin/graph/simulate")
      .then((r) => r.json())
      .then((d) => setScenarios(d.scenarios ?? []))
      .catch(() => {});
  }, []);

  async function run(body: Record<string, unknown>) {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/admin/graph/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      setResult(d.result ?? { direction: "error", finalMessage: d.error ?? "Failed", currency: "", stages: [] });
    } catch {
      setResult({ direction: "error", finalMessage: "Request failed", currency: "", stages: [] });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {scenarios.map((s) => (
          <button
            key={s.id}
            onClick={() => run({ scenarioId: s.id })}
            className="btn btn-sm rounded-full border border-line px-2.5 py-1 text-[11px] font-bold text-soft hover:border-brandblue"
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="rounded-2xl border-2 border-line bg-card2 p-3">
        <label className="block text-[12px] font-bold text-soft">
          Shop&apos;s reply
          <textarea
            value={shopReply}
            onChange={(e) => setShopReply(e.target.value)}
            rows={2}
            placeholder="e.g. 500 baht per day, passport as deposit"
            className="mt-1 w-full rounded-xl border-2 border-line bg-card p-2 text-[14px] text-strong"
          />
        </label>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <PlaceAutocomplete label="Shop region" value={region} onText={setRegion} minChars={2} />
          <label className="text-[12px] font-bold text-soft">
            Rival offer (optional leverage)
            <input
              value={rival}
              onChange={(e) => setRival(e.target.value)}
              type="number"
              placeholder="e.g. 170"
              className="mt-1 w-full rounded-xl border-2 border-line bg-card p-2 text-[14px] text-strong"
            />
          </label>
        </div>
        <button
          onClick={() => run({ shopReply, region, rivalPricePerDay: rival ? Number(rival) : undefined })}
          disabled={busy || !shopReply.trim()}
          className="btn btn-primary mt-3 w-full rounded-2xl py-2.5 text-sm disabled:opacity-50"
        >
          {busy ? <LoadingDots light label="Running the engine" /> : "Run through the graph"}
        </button>
      </div>

      {result && <StageTrace result={result} />}
    </div>
  );
}

export function StageTrace({ result }: { result: SimResult }) {
  return (
    <div className="mt-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px]">
        <span className="rounded-full bg-brandblue-soft px-2 py-0.5 font-bold text-brandblue">
          outcome: {result.direction}
        </span>
        {result.path && result.path.length > 0 && (
          <span className="text-faint">path: {result.path.join(" → ")}</span>
        )}
      </div>
      {result.finalMessage && (
        <div className="mb-2 rounded-xl bg-savings-soft p-2.5 text-[13px] font-bold text-savings">
          📤 {result.finalMessage}
        </div>
      )}
      <div className="space-y-1.5">
        {result.stages.map((s, i) => (
          <div key={i} className="rounded-xl border border-line bg-card p-2 text-[11px]">
            <div className="flex items-center justify-between">
              <span className="font-extrabold text-strong">
                {i + 1}. {s.nodeId ?? s.stage}
              </span>
              {s.verdict && <span className="rounded bg-card2 px-1.5 text-faint">{s.verdict}</span>}
            </div>
            {s.input && <div className="mt-0.5 text-soft"><span className="text-faint">in:</span> {s.input}</div>}
            <div className="text-soft"><span className="text-faint">why:</span> {s.reasoning}</div>
            <div className="text-strong"><span className="text-faint">out:</span> {s.output}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
