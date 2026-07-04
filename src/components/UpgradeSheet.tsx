"use client";

import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { Icon } from "./icons";
import { LoadingDots } from "./LoadingDots";
import { useI18n } from "@/lib/i18n";

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

// Pricing is anchored in ILS (matches the Lemon Squeezy products exactly);
// other currencies are shown converted (USD is the default display).
const ILS_PRICES: Record<string, number> = { pro: 16.5, ultra: 88 };
const FX_PER_ILS: Record<string, { rate: number; symbol: string }> = {
  USD: { rate: 0.3, symbol: "$" },
  ILS: { rate: 1, symbol: "₪" },
  EUR: { rate: 0.26, symbol: "€" },
  GBP: { rate: 0.22, symbol: "£" },
  THB: { rate: 9.8, symbol: "฿" },
  IDR: { rate: 4600, symbol: "Rp" },
};

function planPrice(planId: string, currency: string): { now: string; list: string } | null {
  const ils = ILS_PRICES[planId];
  const fx = FX_PER_ILS[currency];
  if (!ils || !fx) return null;
  const adj = currency === "ILS" ? 1 : 1.002;
  const now = ils * fx.rate * adj;
  const list = now * 5; // 80% launch discount
  const fmt = (n: number) =>
    `${fx.symbol}${n >= 1000 ? Math.round(n).toLocaleString() : n.toFixed(2).replace(/\.00$/, "")}`;
  return { now: fmt(now), list: fmt(list) };
}

function savedCurrency(): string {
  try {
    return localStorage.getItem("wd_currency") || "USD";
  } catch {
    return "USD";
  }
}

export function PlanCard({
  plan,
  onSubscribe,
  busy,
  current,
}: {
  plan: PlanView;
  onSubscribe?: (id: string) => void;
  busy?: boolean;
  current?: boolean;
}) {
  const [currency, setCurrency] = useState("USD");
  const [pickerOpen, setPickerOpen] = useState(false);
  useEffect(() => setCurrency(savedCurrency()), []);

  const px = planPrice(plan.id, currency);
  const list = px ? px.list : `$${(plan.listAmount / 100).toFixed(0)}`;
  const now = px ? px.now : `$${(plan.amount / 100).toFixed(2).replace(/\.00$/, "")}`;
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
        <div className="relative text-right">
          {plan.amount === 0 ? (
            <div className="text-xl font-extrabold text-strong">Free</div>
          ) : (
            <>
              <div className="text-[12px] font-bold text-faint line-through">{list}</div>
              <div className="text-xl font-extrabold text-strong">{now}</div>
              <div className="text-[10px] font-bold text-faint">every 3 months</div>
              <button
                type="button"
                onClick={() => setPickerOpen((o) => !o)}
                className="chip mt-0.5 rounded-full border border-line px-2 py-0.5 text-[10px] font-extrabold text-brandblue"
              >
                {currency} ▾
              </button>
              {pickerOpen && (
                <div className="absolute right-0 z-30 mt-1 overflow-hidden rounded-xl surface-strong">
                  {Object.keys(FX_PER_ILS).map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => {
                        setCurrency(c);
                        setPickerOpen(false);
                        try {
                          localStorage.setItem("wd_currency", c);
                        } catch {}
                      }}
                      className={`block w-full px-4 py-1.5 text-left text-[12px] font-bold ${
                        c === currency ? "bg-brandblue-soft text-brandblue" : "text-soft hover:bg-card2"
                      }`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {plan.amount > 0 && (
        <div
          className={`mt-2 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-extrabold text-white ${
            plan.id === "ultra" ? "badge-ultra" : "bg-brandred"
          }`}
        >
          {plan.id === "ultra" ? "⚡" : "🔥"} {plan.discountPct}% OFF - limited-time opening offer
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
      {current && (
        <div className="mt-3 w-full rounded-2xl bg-savings-soft py-2.5 text-center text-[13px] font-extrabold text-savings">
          ✓ Your current plan
        </div>
      )}
      {plan.amount > 0 && onSubscribe && !current && (
        <button
          onClick={() => onSubscribe(plan.id)}
          disabled={busy}
          className="btn btn-primary mt-3 w-full rounded-2xl py-2.5 text-[13px] disabled:opacity-60"
        >
          {busy ? <LoadingDots light label="Opening checkout" /> : "Claim 80% off - Subscribe"}
        </button>
      )}
    </div>
  );
}

// The membership sheet, opened from the upgrade chip above the tab bar.
export function UpgradeSheet({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [plans, setPlans] = useState<PlanView[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [myPlan, setMyPlan] = useState<string>("free");

  useEffect(() => {
    fetch("/api/billing/checkout")
      .then((r) => r.json())
      .then((d) => setPlans(d.plans ?? []))
      .catch(() => {});
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setMyPlan(d.session?.plan ?? "free"))
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
          <h2 className="text-lg font-extrabold text-strong">{t("Go Pro or Ultra")} 🎉</h2>
          <p className="text-[12px] font-bold text-brandred">
            {t("Opening offer: 80% off, for a limited time only")}
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
            <PlanCard
              key={p.id}
              plan={p}
              onSubscribe={subscribe}
              busy={busy}
              current={myPlan === p.id}
            />
          ))}
      </div>
      <p className="mt-3 text-center text-[10px] text-faint">
        {t("Switch plans any time - a new subscription replaces the old one. To cancel or downgrade, use the manage link in your payment receipt email.")}
      </p>
    </Modal>
  );
}
