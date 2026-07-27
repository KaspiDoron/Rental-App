"use client";

import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { Icon } from "./icons";
import { LoadingDots } from "./LoadingDots";
import { useI18n } from "@/lib/i18n";
import {
  PayPalProvider,
  PayPalSubscriptionButton,
  usePaypalConfig,
} from "@/components/billing/PayPalSubscriptionButton";
import { isPaidPlan } from "@/lib/paypal-plans";

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

// The messaging capacity of each plan, in plain language. Mirrors PLAN_CAPACITY
// in src/lib/wa/capacity.ts (free 10/6h, pro 30/4h, ultra 40/3h). ULTRA is the
// visual max the meter fills against.
const CAPACITY: Record<string, { newContacts: number; windowHours: number; extra: string }> = {
  free: { newContacts: 10, windowHours: 6, extra: "English messaging" },
  pro: { newContacts: 30, windowHours: 4, extra: "3x the shops, refreshes faster" },
  ultra: { newContacts: 40, windowHours: 3, extra: "Most shops, fastest refresh, local language" },
};
const MAX_CONTACTS = 40;

function PlanCapacityMeter({ planId, highlight }: { planId: string; highlight?: boolean }) {
  const c = CAPACITY[planId] ?? CAPACITY.free;
  const pct = Math.round((c.newContacts / MAX_CONTACTS) * 100);
  return (
    <div className={`mt-3 rounded-2xl p-3 ${highlight ? "bg-brandblue-soft" : "bg-card2"}`}>
      <div className="flex items-baseline justify-between">
        <span className="text-[13px] font-extrabold text-strong">
          {c.newContacts} <span className="text-[11px] font-bold text-soft">new shops</span>
        </span>
        <span className="text-[11px] font-bold text-faint">every {c.windowHours}h, rolling</span>
      </div>
      <div className="mt-1.5 h-2.5 w-full overflow-hidden rounded-full bg-line/60">
        <div
          className={`h-full rounded-full ${planId === "ultra" ? "badge-ultra" : "bg-brandblue"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-1.5 text-[11px] font-semibold leading-snug text-soft">
        You can start conversations with up to <b>{c.newContacts}</b> brand-new shops in any{" "}
        <b>{c.windowHours}-hour</b> window - and the whole batch goes out in the first ~10 minutes.
        Replies never count against it. {c.extra}.
      </p>
    </div>
  );
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
      {/* R5: crystal-clear capacity meter - the 10/30/40 limits explained in
          plain "X new shops every Y hours", with a visual bar so buyers see
          exactly what more they get. */}
      <PlanCapacityMeter planId={plan.id} highlight={plan.highlight} />
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
  const { config: paypal } = usePaypalConfig();

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
      <PayPalProvider config={paypal ?? { clientId: null, planIds: { pro: null, ultra: null }, env: "live" }}>
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
            <div key={p.id} className="space-y-2">
              <PlanCard
                plan={p}
                onSubscribe={subscribe}
                busy={busy}
                current={myPlan === p.id}
              />
              {/* THE SUBSCRIBE BUTTON ITSELF. PayPal's own control, in its own
                  iframe - the traveller stays in the app, and we never touch a
                  card number. Nothing here grants a plan: the approval is
                  posted to the server, which asks PayPal what it really was.
                  Rendered only for a tier they are not already on. */}
              {isPaidPlan(p.id) && myPlan !== p.id && (
                <PayPalSubscriptionButton
                  plan={p.id}
                  onActivated={(applied) => {
                    setMyPlan(applied);
                    setMsg(
                      `${t("You're on")} ${applied === "ultra" ? "Ultra" : "Pro Traveller"} ${t("- everything is unlocked.")}`
                    );
                    // Session state, refreshed in place. No hard reload.
                    fetch("/api/auth/me", { cache: "no-store" })
                      .then((r) => r.json())
                      .then((d) => setMyPlan(d.session?.plan ?? applied))
                      .catch(() => {});
                  }}
                  onError={(m) => setMsg(m)}
                />
              )}
            </div>
          ))}
      </div>
      <p className="mt-3 text-center text-[10px] text-faint">
        {t("Switch plans any time - a new subscription replaces the old one. To cancel or downgrade, use the manage link in your payment receipt email.")}
      </p>
      </PayPalProvider>
    </Modal>
  );
}
