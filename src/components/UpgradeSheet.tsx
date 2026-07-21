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

import { CURRENCIES, currency, fromIls, savedCurrency, setSavedCurrency } from "@/lib/currency";

// Pricing is anchored in ILS (matches the PayPal billing plans exactly).
const ILS_PRICES: Record<string, number> = { pro: 16.5, ultra: 88 };

function planPrice(planId: string, code: string): { now: string; list: string } | null {
  const ils = ILS_PRICES[planId];
  if (!ils) return null;
  return { now: fromIls(ils, code), list: fromIls(ils * 5, code) }; // 80% launch off
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
  const [currencyCode, setCurrencyCode] = useState("USD");
  const [pickerOpen, setPickerOpen] = useState(false);
  useEffect(() => setCurrencyCode(savedCurrency()), []);

  const px = planPrice(plan.id, currencyCode);
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
                {currency(currencyCode).flag} {currencyCode} ▾
              </button>
              {pickerOpen && (
                <div className="no-scrollbar absolute right-0 z-30 mt-1 max-h-56 w-32 overflow-y-auto rounded-xl surface-strong">
                  {CURRENCIES.map((c) => (
                    <button
                      key={c.code}
                      type="button"
                      onClick={() => {
                        setCurrencyCode(c.code);
                        setPickerOpen(false);
                        setSavedCurrency(c.code);
                      }}
                      className={`flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[12px] font-bold ${
                        c.code === currencyCode ? "bg-brandblue-soft text-brandblue" : "text-soft hover:bg-card2"
                      }`}
                    >
                      <span>{c.flag}</span> {c.code}
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
            plan.id === "ultra" ? "badge-ultra" : "bg-brandblue"
          }`}
        >
          <Icon name="sparkles" className="h-3 w-3" /> Launch pricing · {plan.discountPct}% off
        </div>
      )}
      <ul className="mt-2 space-y-1">
        {plan.features.map((f) => {
          // Make the marquee Ultra feature - agents talking in the shop's own
          // language - glow so it stands out as the headline perk.
          const glow = /local language|native language|local dialect/i.test(f);
          return glow ? (
            <li
              key={f}
              className="sponsored-glow flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-brandblue/10 via-[#7c5cff]/10 to-brandred/10 px-2 py-1.5 text-[12px] font-extrabold text-strong"
            >
              <span className="shrink-0">🌐</span>
              <span className="bg-gradient-to-r from-brandblue via-[#7c5cff] to-brandred bg-clip-text text-transparent">
                {f}
              </span>
            </li>
          ) : (
            <li key={f} className="flex items-center gap-1.5 text-[12px] font-semibold text-soft">
              <Icon name="check" className="h-3.5 w-3.5 shrink-0 text-savings" />
              {f}
            </li>
          );
        })}
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
          {busy ? <LoadingDots light label="Opening checkout" /> : `Upgrade to ${plan.name}`}
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
      else if (data.sandbox) {
        setMsg(`Test mode - ${String(data.applied ?? planId)} plan applied instantly, no charge.`);
        setMyPlan(String(data.applied ?? planId));
      } else setMsg(data.error ?? "Payments are almost ready - check back soon!");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-extrabold text-strong">{t("Go Pro or Ultra")}</h2>
          <p className="text-[12px] font-bold text-soft">
            {t("Launch pricing: 80% off while WheelDeal is in its opening season")}
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
