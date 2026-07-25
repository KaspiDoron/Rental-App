"use client";

// SESSION BLACKBOARD INSPECTOR - the live ENGINE_V3 (SPTE) transparency view
// that replaces the retired graph "Agents"/"Ops" debug tabs. Polls a single
// owner-only snapshot endpoint every few seconds and shows, in real time: each
// single-pass turn (move + model route + private scratchpad + wire text), the
// global session blackboard (lowest offer per vehicle), queue health, WA socket
// liveness, and the last inbound webhook. No graph mental model - just the
// engine actually executing.

import { useEffect, useState } from "react";
import { LoadingDots } from "../LoadingDots";

interface Turn {
  shop?: string;
  at?: string;
  move?: string;
  tier?: string;
  provider?: string | null;
  reason?: string;
  think?: string;
  legalMoves?: string[];
  floor?: number | null;
  lowest?: number | null;
  rivals?: number;
  quote?: number | null;
  materialDrop?: boolean;
  delivered?: string;
  text?: string | null;
  vehicleKey?: string;
}

interface Snapshot {
  engine: string;
  generatedAt: string;
  turns: Turn[];
  stats: { turnsLast6h: number; turnsCapped?: boolean; failoversLast6h: number; unconfirmedSendsLast6h: number };
  session: { lowestByVehicle: { key: string; shop: string; pricePerDay: number; currency: string }[]; activeOffers: number };
  queue: { depth: number; dueNow: number; nextAt: string | null };
  sockets: { live: number; total: number; stampedAt?: string | null };
  webhook: { lastInboundAt: string | null; lastAcceptedAt?: string | null; last403At?: string | null };
}

function ago(iso?: string | null): string {
  if (!iso) return "-";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

const MOVE_TONE: Record<string, string> = {
  bargain: "bg-brandblue text-white",
  present: "badge-ultra text-white",
  close: "bg-savings text-white",
  "closing-message": "bg-savings text-white",
  "redirect-close": "bg-brandred-soft text-brandred",
  silent: "bg-card2 text-faint",
};

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="surface rounded-2xl p-3 text-center">
      <div className="text-[10px] font-extrabold uppercase tracking-wide text-faint">{label}</div>
      <div className={`text-lg font-extrabold ${tone ?? "text-strong"}`}>{value}</div>
    </div>
  );
}

export function EngineInspector() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [err, setErr] = useState(false);
  const [live, setLive] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/admin/engine-inspector", { cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        const d = (await r.json()) as Snapshot;
        if (!cancelled) {
          setSnap(d);
          setErr(false);
        }
      } catch {
        if (!cancelled) setErr(true);
      }
    };
    tick();
    if (!live) return () => { cancelled = true; };
    const id = setInterval(tick, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [live]);

  if (!snap && !err) return <LoadingDots label="Reading the live blackboard" />;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-[15px] font-extrabold text-strong">🧠 Session Blackboard Inspector</h3>
          <p className="text-[11px] font-bold text-soft">{snap?.engine ?? "ENGINE_V3"}</p>
        </div>
        <button
          onClick={() => setLive((v) => !v)}
          className={`btn btn-sm rounded-xl px-3 py-1.5 text-[11px] font-extrabold ${
            live ? "bg-savings-soft text-savings" : "bg-card2 text-soft"
          }`}
        >
          {live ? "● Live" : "Paused"}
        </button>
      </div>

      {err && (
        <div className="rounded-2xl bg-brandred-soft p-2.5 text-[12px] font-bold text-brandred">
          Could not reach the inspector endpoint - retrying.
        </div>
      )}

      {snap && (
        <>
          <div className="grid grid-cols-3 gap-2">
            <Stat
              label="Turns (6h)"
              value={`${snap.stats.turnsLast6h}${snap.stats.turnsCapped ? "+" : ""}`}
            />
            <Stat
              label="Failovers"
              value={snap.stats.failoversLast6h}
              tone={snap.stats.failoversLast6h > 0 ? "text-brandred" : "text-savings"}
            />
            <Stat label="Unverified sends" value={snap.stats.unconfirmedSendsLast6h} />
          </div>

          <div className="grid grid-cols-3 gap-2">
            <Stat
              label="Queue due / total"
              value={`${snap.queue.dueNow} / ${snap.queue.depth}`}
            />
            <Stat
              label="WA sockets (mirror)"
              value={`${snap.sockets.live} / ${snap.sockets.total}`}
              tone={snap.sockets.live > 0 ? "text-soft" : "text-brandred"}
            />
            <Stat label="Last inbound" value={ago(snap.webhook.lastInboundAt)} />
          </div>

          {/* WEBHOOK LIVENESS - the row that actually proves inbound is alive.
              A recent accept = healthy; a recent 403 with no accept = Evolution
              is rejecting our webhook (re-arm). The socket mirror above never
              downgrades, so it is NOT proof of liveness - this row is. */}
          <div className="grid grid-cols-3 gap-2">
            <Stat
              label="Webhook accepted"
              value={ago(snap.webhook.lastAcceptedAt)}
              tone={snap.webhook.lastAcceptedAt ? "text-savings" : "text-brandred"}
            />
            <Stat
              label="Webhook 403"
              value={ago(snap.webhook.last403At)}
              tone={snap.webhook.last403At ? "text-brandred" : "text-faint"}
            />
            <Stat label="Sockets stamped" value={ago(snap.sockets.stampedAt)} />
          </div>

          {/* Global blackboard: lowest offer per vehicle bucket in the session. */}
          {snap.session.lowestByVehicle.length > 0 && (
            <div className="surface rounded-2xl p-3">
              <div className="mb-1.5 text-[11px] font-extrabold uppercase tracking-wide text-faint">
                Blackboard - lowest offer / vehicle
              </div>
              <div className="flex flex-wrap gap-1.5">
                {snap.session.lowestByVehicle.map((l) => (
                  <span key={l.key} className="rounded-full bg-card2 px-2.5 py-1 text-[11px] font-bold text-soft">
                    {l.key.split(":")[0]}: <b className="text-strong">{l.pricePerDay} {l.currency}</b> ({l.shop})
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* The live turn stream: each single pass with its move + route + think. */}
          <div className="space-y-2">
            <div className="text-[11px] font-extrabold uppercase tracking-wide text-faint">
              Single-pass turns (newest first)
            </div>
            {snap.turns.length === 0 && (
              <div className="surface rounded-2xl p-3 text-[12px] text-soft">
                No turns yet in the last 6h - the engine logs one row per shop message it answers.
              </div>
            )}
            {snap.turns.map((t, i) => (
              <div key={i} className="surface rounded-2xl p-3">
                <div className="flex items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-extrabold ${MOVE_TONE[t.move ?? ""] ?? "bg-card2 text-soft"}`}>
                    {t.move ?? "?"}
                  </span>
                  <span className="text-[12px] font-extrabold text-strong">{t.shop}</span>
                  <span className="ml-auto text-[10px] font-bold text-faint">{ago(t.at)}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1 text-[10px] font-bold text-faint">
                  <span className="rounded bg-card2 px-1.5 py-0.5">tier {t.tier ?? "?"}</span>
                  {t.provider && <span className="rounded bg-card2 px-1.5 py-0.5">{t.provider}</span>}
                  {t.reason && <span className="rounded bg-card2 px-1.5 py-0.5">{t.reason}</span>}
                  {typeof t.quote === "number" && <span className="rounded bg-card2 px-1.5 py-0.5">quote {t.quote}</span>}
                  {typeof t.floor === "number" && <span className="rounded bg-card2 px-1.5 py-0.5">floor {t.floor}</span>}
                  {typeof t.lowest === "number" && <span className="rounded bg-card2 px-1.5 py-0.5">session-low {t.lowest}</span>}
                  {typeof t.rivals === "number" && <span className="rounded bg-card2 px-1.5 py-0.5">{t.rivals} rivals</span>}
                  {t.materialDrop && <span className="rounded bg-savings-soft px-1.5 py-0.5 text-savings">↓ material drop</span>}
                  {t.delivered && <span className="rounded bg-card2 px-1.5 py-0.5">{t.delivered}</span>}
                </div>
                {t.think && (
                  <div className="mt-1.5 text-[11px] italic text-soft">🧩 {t.think}</div>
                )}
                {t.text && (
                  <div className="mt-1 rounded-xl bg-card2 px-2.5 py-1.5 text-[12px] text-strong">💬 {t.text}</div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
