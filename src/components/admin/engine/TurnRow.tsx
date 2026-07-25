"use client";

// Tier-3 turn row: a compact collapsed summary (move + shop + time) that expands
// via native <details> to reveal the full decision detail the flat panel used to
// drop on the floor - the model route, the private scratchpad, every legal move
// the engine considered, the response latency and the vehicle bucket.

export interface Turn {
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
  latencyMs?: number | null;
  text?: string | null;
  vehicleKey?: string;
}

const MOVE_TONE: Record<string, string> = {
  bargain: "bg-brandblue text-white",
  present: "badge-ultra text-white",
  close: "bg-savings text-white",
  "closing-message": "bg-savings text-white",
  "redirect-close": "bg-brandred-soft text-brandred",
  silent: "bg-card2 text-faint",
};

function ago(iso?: string): string {
  if (!iso) return "-";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function Chip({ children, tone }: { children: React.ReactNode; tone?: string }) {
  return <span className={`rounded px-1.5 py-0.5 ${tone ?? "bg-card2 text-faint"}`}>{children}</span>;
}

export function TurnRow({ t }: { t: Turn }) {
  return (
    <details className="surface group rounded-2xl">
      <summary className="flex cursor-pointer list-none items-center gap-2 p-3">
        <span className={`rounded px-1.5 py-0.5 text-[10px] font-extrabold ${MOVE_TONE[t.move ?? ""] ?? "bg-card2 text-soft"}`}>
          {t.move ?? "?"}
        </span>
        <span className="text-[12px] font-extrabold text-strong">{t.shop}</span>
        {t.materialDrop && (
          <span className="rounded bg-savings-soft px-1.5 py-0.5 text-[10px] font-bold text-savings">↓ drop</span>
        )}
        <span className="ml-auto text-[10px] font-bold text-faint">{ago(t.at)}</span>
        <span className="text-[10px] text-faint transition-transform group-open:rotate-90">▸</span>
      </summary>

      <div className="border-t border-line px-3 pb-3 pt-2">
        <div className="flex flex-wrap gap-1 text-[10px] font-bold">
          <Chip>tier {t.tier ?? "?"}</Chip>
          {t.provider ? <Chip>{t.provider}</Chip> : <Chip>mock/local</Chip>}
          {t.reason && <Chip>{t.reason}</Chip>}
          {typeof t.latencyMs === "number" && (
            <Chip tone={t.latencyMs > 8000 ? "bg-brandred-soft text-brandred" : "bg-card2 text-faint"}>
              {t.latencyMs} ms
            </Chip>
          )}
          {typeof t.quote === "number" && <Chip>quote {t.quote}</Chip>}
          {typeof t.floor === "number" && <Chip>floor {t.floor}</Chip>}
          {typeof t.lowest === "number" && <Chip>session-low {t.lowest}</Chip>}
          {typeof t.rivals === "number" && <Chip>{t.rivals} rivals</Chip>}
          {t.vehicleKey && <Chip>{t.vehicleKey}</Chip>}
          {t.delivered && <Chip>{t.delivered}</Chip>}
        </div>

        {t.legalMoves && t.legalMoves.length > 0 && (
          <div className="mt-2">
            <div className="text-[10px] font-extrabold uppercase tracking-wide text-faint">Legal moves considered</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {t.legalMoves.map((m) => (
                <span
                  key={m}
                  className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${m === t.move ? "bg-brandblue text-white" : "bg-card2 text-soft"}`}
                >
                  {m}
                </span>
              ))}
            </div>
          </div>
        )}

        {t.think && <div className="mt-2 text-[11px] italic leading-relaxed text-soft">🧩 {t.think}</div>}
        {t.text && (
          <div className="mt-1.5 rounded-xl bg-card2 px-2.5 py-1.5 text-[12px] text-strong">💬 {t.text}</div>
        )}
      </div>
    </details>
  );
}
