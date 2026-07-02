"use client";

import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { Icon } from "./icons";

export interface PlanView {
  id: string;
  name: string;
  blurb: string;
  listAmount: number;
  amount: number;
  discountPct: number;
  features: string[];
  highlight?: boolean;
}

export function PlanCard({
  plan,
  onSubscribe,
  busy,
}: {
  plan: PlanView;
  onSubscribe?: (id: string) => void;
  busy?: boolean;
}) {
  const list = (plan.listAmount / 100).toFixed(0);
  const now = (plan.amount / 100).toFixed(2).replace(/\.00$/, "");
  return (
    <div
      className={`surface rounded-blob p-4 ${
        plan.highlight ? "border-2 !border-brandblue" : ""
      }`}
    >
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-extrabold text-strong">{plan.name}</span>
            {plan.highlight && (
              <span className="rounded-full bg-brandblue px-2 py-0.5 text-[10px] font-extrabold text-white">
                Popular
              </span>
            )}
          </div>
          <div className="text-[12px] text-soft">{plan.blurb}</div>
        </div>
        <div className="text-right">
          {plan.amount === 0 ? (
            <div className="text-xl font-extrabold text-strong">Free</div>
          ) : (
            <>
              <div className="text-[12px] font-bold text-faint line-through">${list}</div>
              <div className="text-xl font-extrabold text-strong">${now}</div>
              <div className="text-[10px] font-bold text-faint">every 3 months</div>
            </>
          )}
        </div>
      </div>
      {plan.amount > 0 && (
        <div className="mt-2 inline-flex items-center gap-1 rounded-full bg-brandred px-2.5 py-1 text-[11px] font-extrabold text-white">
          🔥 {plan.discountPct}% OFF - limited-time opening offer
        </div>
      )}
      <ul className="mt-2 space-y-1">
        {plan.features.map((f) => (
          <li key={f} className="flex items-center gap-1.5 text-[12px] font-semibold text-soft">
            <Icon name="check" className="h-3.5 w-3.5 shrink-0 text-savings" />
            {f}
          </li>
        ))}
      </ul>
      {plan.amount > 0 && onSubscribe && (
        <button
          onClick={() => onSubscribe(plan.id)}
          disabled={busy}
          className="btn btn-primary mt-3 w-full rounded-2xl py-2.5 text-[13px] disabled:opacity-60"
        >
          Claim 80% off - Subscribe
        </button>
      )}
    </div>
  );
}

// The membership sheet, opened from the upgrade chip above the tab bar.
export function UpgradeSheet({ onClose }: { onClose: () => void }) {
  const [plans, setPlans] = useState<PlanView[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/billing/checkout")
      .then((r) => r.json())
      .then((d) => setPlans(d.plans ?? []))
      .catch(() => {});
  }, []);

  async function subscribe(planId: string) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId }),
      });
      const data = await res.json();
      if (data.url) window.location.href = data.url;
      else setMsg(data.error ?? "Payments are almost ready - check back soon!");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-extrabold text-strong">Go Pro 🎉</h2>
          <p className="text-[12px] font-bold text-brandred">
            Opening offer: 80% off, for a limited time only
          </p>
        </div>
        <button onClick={onClose} className="btn btn-sm btn-ghost rounded-xl px-3" aria-label="Close">
          ✕
        </button>
      </div>
      {msg && (
        <div className="mb-2 rounded-xl bg-brandyellow-soft p-2.5 text-[12px] font-bold text-[#8a6100] dark:text-brandyellow">
          {msg}
        </div>
      )}
      <div className="space-y-3">
        {plans
          .filter((p) => p.amount > 0)
          .map((p) => (
            <PlanCard key={p.id} plan={p} onSubscribe={subscribe} busy={busy} />
          ))}
      </div>
    </Modal>
  );
}
