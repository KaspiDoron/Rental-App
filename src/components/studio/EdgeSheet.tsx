"use client";

import { useState } from "react";
import { Modal } from "../Modal";
import type { EdgeSpec, GraphCondition, NodeSpec } from "@/lib/graph/types";

type Vocab = {
  kind: string;
  label: string;
  params?: { name: string; type: "boolean" | "number" | "string" | "enum"; options?: string[] }[];
}[];

// Edit one edge: source, target, priority, enabled, and a TYPED condition
// builder. The condition is a tree of typed predicates (no free text, no eval),
// so a bad owner edit can never run code - the exact safety story as branching.ts.
export function EdgeSheet({
  edge,
  nodes,
  vocabulary,
  onSave,
  onDelete,
  onClose,
}: {
  edge: EdgeSpec;
  nodes: NodeSpec[];
  vocabulary: Vocab;
  onSave: (e: EdgeSpec) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<EdgeSpec>({ ...edge });
  const set = (patch: Partial<EdgeSpec>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <Modal onClose={onClose}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-base font-extrabold text-strong">Edge rule</h3>
        <button onClick={onClose} className="btn btn-sm btn-ghost rounded-xl px-3" aria-label="Close">
          ✕
        </button>
      </div>

      <label className="block text-[12px] font-bold text-soft">
        Label (shown on the canvas + in traces)
        <input
          value={draft.label ?? ""}
          onChange={(e) => set({ label: e.target.value })}
          className="mt-1 w-full rounded-xl border-2 border-line bg-card p-2 text-[14px] text-strong"
        />
      </label>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="text-[12px] font-bold text-soft">
          From
          <select
            value={draft.from}
            onChange={(e) => set({ from: e.target.value })}
            className="mt-1 w-full rounded-xl border-2 border-line bg-card p-2 text-[13px] text-strong"
          >
            <option value="inbound">inbound (entry)</option>
            {nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label.split(" - ")[0]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[12px] font-bold text-soft">
          To
          <select
            value={draft.to}
            onChange={(e) => set({ to: e.target.value })}
            className="mt-1 w-full rounded-xl border-2 border-line bg-card p-2 text-[13px] text-strong"
          >
            {nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label.split(" - ")[0]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="text-[12px] font-bold text-soft">
          Priority (lower runs first)
          <input
            type="number"
            value={draft.priority}
            onChange={(e) => set({ priority: Number(e.target.value) })}
            className="mt-1 w-full rounded-xl border-2 border-line bg-card p-2 text-[14px] text-strong"
          />
        </label>
        <label className="flex items-center gap-2 self-end rounded-xl bg-card2 p-2.5 text-[13px] font-bold text-soft">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
            className="h-5 w-5 accent-[var(--blue)]"
          />
          Enabled
        </label>
      </div>

      <div className="mt-4">
        <div className="mb-1 text-[12px] font-bold text-soft">When (all conditions must match)</div>
        <ConditionEditor
          cond={draft.when}
          vocabulary={vocabulary}
          onChange={(when) => set({ when })}
        />
      </div>

      <div className="mt-4 flex gap-2">
        <button onClick={() => onSave(draft)} className="btn btn-primary flex-1 rounded-2xl py-2.5 text-sm">
          Save edge
        </button>
        <button
          onClick={() => onDelete(draft.id)}
          className="btn rounded-2xl border-2 border-brandred px-4 py-2.5 text-sm font-bold text-brandred"
        >
          Delete
        </button>
      </div>
    </Modal>
  );
}

// The typed condition tree, edited as an AND-list of leaf predicates (the 95%
// case). An existing complex tree (allG/anyG/notG) is shown read-only as JSON
// so it is never silently flattened; owners build new AND-lists visually.
function ConditionEditor({
  cond,
  vocabulary,
  onChange,
}: {
  cond: GraphCondition;
  vocabulary: Vocab;
  onChange: (c: GraphCondition) => void;
}) {
  const isAndList =
    (cond as { kind?: string }).kind === "allG" &&
    Array.isArray((cond as { of?: unknown[] }).of);
  const leaves: GraphCondition[] = isAndList
    ? ((cond as { of: GraphCondition[] }).of)
    : (cond as { kind?: string }).kind === "always"
    ? []
    : [cond];

  const commit = (list: GraphCondition[]) => {
    if (list.length === 0) onChange({ kind: "always" });
    else if (list.length === 1) onChange(list[0]);
    else onChange({ kind: "allG", of: list });
  };

  const complex = leaves.some(
    (l) => ["allG", "anyG", "notG", "any", "not"].includes((l as { kind?: string }).kind ?? "")
  );

  if (complex) {
    return (
      <div className="rounded-xl border-2 border-line bg-card2 p-2">
        <div className="mb-1 text-[11px] font-bold text-faint">
          Advanced condition tree (edit as JSON - typed predicates only):
        </div>
        <textarea
          defaultValue={JSON.stringify(cond, null, 2)}
          onBlur={(e) => {
            try {
              onChange(JSON.parse(e.target.value));
            } catch {
              /* keep the previous value on a parse error */
            }
          }}
          rows={8}
          className="w-full rounded-lg border border-line bg-card p-2 font-mono text-[11px] text-strong"
        />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {leaves.map((leaf, i) => (
        <ConditionLeaf
          key={i}
          leaf={leaf}
          vocabulary={vocabulary}
          onChange={(next) => {
            const copy = [...leaves];
            copy[i] = next;
            commit(copy);
          }}
          onRemove={() => commit(leaves.filter((_, j) => j !== i))}
        />
      ))}
      <button
        onClick={() => commit([...leaves, { kind: "always" } as GraphCondition])}
        className="btn btn-sm w-full rounded-xl border-2 border-dashed border-line py-2 text-[12px] font-bold text-brandblue"
      >
        + Add condition
      </button>
    </div>
  );
}

function ConditionLeaf({
  leaf,
  vocabulary,
  onChange,
  onRemove,
}: {
  leaf: GraphCondition;
  vocabulary: Vocab;
  onChange: (c: GraphCondition) => void;
  onRemove: () => void;
}) {
  const anyLeaf = leaf as Record<string, unknown> & { kind: string };
  const meta = vocabulary.find((v) => v.kind === anyLeaf.kind) ?? vocabulary[0];

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-line bg-card p-2">
      <select
        value={anyLeaf.kind}
        onChange={(e) => {
          const m = vocabulary.find((v) => v.kind === e.target.value);
          const next: Record<string, unknown> = { kind: e.target.value };
          for (const p of m?.params ?? []) {
            next[p.name] = p.type === "boolean" ? true : p.type === "number" ? 1 : p.options?.[0] ?? "";
          }
          onChange(next as unknown as GraphCondition);
        }}
        className="flex-1 rounded-lg border border-line bg-card2 p-1.5 text-[12px] font-bold text-strong"
      >
        {vocabulary.map((v) => (
          <option key={v.kind} value={v.kind}>
            {v.label}
          </option>
        ))}
      </select>
      {(meta.params ?? []).map((p) => (
        <span key={p.name}>
          {p.type === "boolean" ? (
            <select
              value={String(anyLeaf[p.name] ?? true)}
              onChange={(e) => onChange({ ...anyLeaf, [p.name]: e.target.value === "true" } as unknown as GraphCondition)}
              className="rounded-lg border border-line bg-card2 p-1.5 text-[11px] text-strong"
            >
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          ) : p.type === "enum" ? (
            <select
              value={String(anyLeaf[p.name] ?? p.options?.[0] ?? "")}
              onChange={(e) => onChange({ ...anyLeaf, [p.name]: e.target.value } as unknown as GraphCondition)}
              className="rounded-lg border border-line bg-card2 p-1.5 text-[11px] text-strong"
            >
              {(p.options ?? []).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <input
              type={p.type === "number" ? "number" : "text"}
              value={String(anyLeaf[p.name] ?? "")}
              onChange={(e) =>
                onChange({
                  ...anyLeaf,
                  [p.name]: p.type === "number" ? Number(e.target.value) : e.target.value,
                } as unknown as GraphCondition)
              }
              className="w-16 rounded-lg border border-line bg-card2 p-1.5 text-[11px] text-strong"
            />
          )}
        </span>
      ))}
      <button onClick={onRemove} className="btn btn-sm px-1.5 text-brandred" aria-label="Remove condition">
        ✕
      </button>
    </div>
  );
}
