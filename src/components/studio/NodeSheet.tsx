"use client";

import { useState } from "react";
import { Modal } from "../Modal";
import type { NodeSpec } from "@/lib/graph/types";

// Edit one node: rename, instructions, enable, per-thread cap, and (custom
// nodes only) the prompt template + delete. No free-form code - a custom node
// is an LLM prompt template with {history}/{shopMessage}/{state}/{rfq}/{numbers}.
export function NodeSheet({
  node,
  onSave,
  onDelete,
  onClose,
}: {
  node: NodeSpec;
  onSave: (n: NodeSpec) => void;
  onDelete?: (id: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<NodeSpec>({ ...node });
  const set = (patch: Partial<NodeSpec>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <Modal onClose={onClose}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-base font-extrabold text-strong">
          {draft.emoji} {draft.kind}
        </h3>
        <button onClick={onClose} className="btn btn-sm btn-ghost rounded-xl px-3" aria-label="Close">
          ✕
        </button>
      </div>

      <label className="block text-[12px] font-bold text-soft">
        Name
        <input
          value={draft.label}
          onChange={(e) => set({ label: e.target.value })}
          className="mt-1 w-full rounded-xl border-2 border-line bg-card p-2 text-[14px] text-strong"
        />
      </label>

      <label className="mt-3 block text-[12px] font-bold text-soft">
        Instructions (appended to this agent&apos;s built-in prompt)
        <textarea
          value={draft.instructions}
          onChange={(e) => set({ instructions: e.target.value })}
          rows={4}
          placeholder="e.g. Always ask for the deposit before showing the traveller a deal."
          className="mt-1 w-full rounded-xl border-2 border-line bg-card p-2 text-[13px] text-strong"
        />
      </label>

      {draft.custom && (
        <label className="mt-3 block text-[12px] font-bold text-soft">
          Prompt template · variables {"{history} {shopMessage} {state} {rfq} {numbers}"}
          <textarea
            value={draft.promptTemplate ?? ""}
            onChange={(e) => set({ promptTemplate: e.target.value })}
            rows={5}
            className="mt-1 w-full rounded-xl border-2 border-line bg-card p-2 font-mono text-[12px] text-strong"
          />
        </label>
      )}

      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="flex items-center gap-2 rounded-xl bg-card2 p-2.5 text-[13px] font-bold text-soft">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
            className="h-5 w-5 accent-[var(--blue)]"
          />
          Enabled
        </label>
        <label className="text-[12px] font-bold text-soft">
          Max runs / shop
          <input
            type="number"
            min={0}
            value={draft.maxRunsPerThread ?? ""}
            placeholder="∞"
            onChange={(e) =>
              set({ maxRunsPerThread: e.target.value === "" ? undefined : Number(e.target.value) })
            }
            className="mt-1 w-full rounded-xl border-2 border-line bg-card p-2 text-[14px] text-strong"
          />
        </label>
      </div>

      <div className="mt-4 flex gap-2">
        <button
          onClick={() => onSave(draft)}
          className="btn btn-primary flex-1 rounded-2xl py-2.5 text-sm"
        >
          Save node
        </button>
        {draft.custom && onDelete && (
          <button
            onClick={() => onDelete(draft.id)}
            className="btn rounded-2xl border-2 border-brandred px-4 py-2.5 text-sm font-bold text-brandred"
          >
            Delete
          </button>
        )}
      </div>
    </Modal>
  );
}
