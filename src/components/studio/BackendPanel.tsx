"use client";

import { useEffect, useState } from "react";
import { LoadingDots } from "../LoadingDots";

interface AgentPrompt {
  id: string;
  label: string;
  emoji: string;
  method: string;
  endpoint: string;
  system: string;
  userSample: string;
  note?: string;
}
interface RegistryPrompt {
  id: string;
  label: string;
  text: string;
}

// Postman-style backend view: the EXACT request each agent sends to the LLM -
// method, endpoint (provider failover), and the full system prompt + a sample
// user payload, viewable as plain text or the raw JSON body. 100% visibility.
export function BackendPanel() {
  const [agents, setAgents] = useState<AgentPrompt[] | null>(null);
  const [registry, setRegistry] = useState<RegistryPrompt[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [asJson, setAsJson] = useState(false);

  useEffect(() => {
    fetch("/api/admin/graph/prompts")
      .then((r) => r.json())
      .then((d) => {
        setAgents(d.agents ?? []);
        setRegistry(d.registry ?? []);
      })
      .catch(() => setAgents([]));
  }, []);

  if (!agents) return <LoadingDots label="Loading the live prompts" />;

  const requestBody = (a: AgentPrompt) =>
    JSON.stringify(
      {
        model: "(first configured provider's model)",
        temperature: 0.6,
        messages: [
          { role: "system", content: a.system },
          { role: "user", content: a.userSample },
        ],
      },
      null,
      2
    );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-faint">
          The exact requests your agents send - like Postman, but live from the
          running config (owner node instructions already merged in).
        </p>
        <button
          onClick={() => setAsJson((v) => !v)}
          className="btn btn-sm shrink-0 rounded-lg border border-line px-2.5 py-1 text-[11px] font-bold text-brandblue"
        >
          {asJson ? "Plain text" : "JSON body"}
        </button>
      </div>

      {agents.map((a) => {
        const isOpen = open === a.id;
        return (
          <div key={a.id} className="rounded-2xl border border-line bg-card">
            <button
              onClick={() => setOpen(isOpen ? null : a.id)}
              className="btn flex w-full items-center gap-2 p-3 text-left"
            >
              <span className="text-lg">{a.emoji}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-extrabold text-strong">{a.label}</span>
                <span className="block truncate text-[10px] text-faint">
                  <span className="rounded bg-savings-soft px-1 font-bold text-savings">{a.method}</span>{" "}
                  {a.endpoint}
                </span>
              </span>
              <span className="text-faint">{isOpen ? "▲" : "▼"}</span>
            </button>
            {isOpen && (
              <div className="border-t border-line p-2.5">
                {a.note && (
                  <div className="mb-2 rounded-lg bg-brandblue-soft p-2 text-[10px] font-bold text-brandblue">
                    {a.note}
                  </div>
                )}
                {asJson ? (
                  <pre className="max-h-96 overflow-auto rounded-xl bg-card2 p-2.5 text-[10px] leading-relaxed text-soft">
                    {requestBody(a)}
                  </pre>
                ) : (
                  <>
                    <div className="mb-1 text-[10px] font-extrabold uppercase tracking-wide text-faint">
                      system
                    </div>
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-card2 p-2.5 text-[11px] leading-relaxed text-soft">
                      {a.system}
                    </pre>
                    <div className="mb-1 mt-2 text-[10px] font-extrabold uppercase tracking-wide text-faint">
                      user (sample)
                    </div>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-xl bg-card2 p-2.5 text-[11px] leading-relaxed text-soft">
                      {a.userSample}
                    </pre>
                  </>
                )}
                <button
                  onClick={() => navigator.clipboard?.writeText(asJson ? requestBody(a) : a.system).catch(() => {})}
                  className="btn btn-sm mt-2 rounded-lg border border-line px-2.5 py-1 text-[11px] font-bold text-brandblue"
                >
                  Copy {asJson ? "request JSON" : "system prompt"}
                </button>
              </div>
            )}
          </div>
        );
      })}

      {registry.length > 0 && (
        <div>
          <div className="mb-1.5 mt-2 text-[12px] font-extrabold text-strong">
            📚 Core prompt registry (owner-editable)
          </div>
          <div className="space-y-2">
            {registry.map((p) => {
              const isOpen = open === `reg-${p.id}`;
              return (
                <div key={p.id} className="rounded-2xl border border-line bg-card">
                  <button
                    onClick={() => setOpen(isOpen ? null : `reg-${p.id}`)}
                    className="btn flex w-full items-center justify-between p-3 text-left"
                  >
                    <span className="text-[13px] font-extrabold text-strong">{p.label}</span>
                    <span className="text-faint">{isOpen ? "▲" : "▼"}</span>
                  </button>
                  {isOpen && (
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-line p-2.5 text-[11px] leading-relaxed text-soft">
                      {p.text}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
