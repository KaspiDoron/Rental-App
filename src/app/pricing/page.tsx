// Public pricing page: full plan comparison built from the SAME entitlements
// map that gates the app (src/lib/entitlements.ts), so this table can never
// promise something the product doesn't enforce.

import type { Metadata } from "next";
import { BrandMark } from "@/components/BrandMark";
import { Icon } from "@/components/icons";
import { PlanCard } from "@/components/UpgradeSheet";
import { SiteFooter } from "@/components/SiteFooter";
import { PLANS } from "@/lib/stripe";
import { ENTITLEMENTS, FEATURE_META, type Feature } from "@/lib/entitlements";
import { PLAN_CAPACITY } from "@/lib/wa/capacity";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Start free. Upgrade to Pro or Ultra for mass bargaining, local-language haggling and Will's price radar - launch pricing, billed quarterly.",
  alternates: { canonical: "/pricing" },
};

const FEATURES = Object.keys(FEATURE_META) as Feature[];

export default function PricingPage() {
  return (
    <main className="mx-auto min-h-[100dvh] max-w-md px-4 pb-10 sm:max-w-lg md:max-w-3xl">
      <nav className="flex items-center justify-between pt-safe">
        <a href="/welcome" className="flex items-center gap-2 py-3">
          <BrandMark size={34} />
          <span className="font-display text-lg font-extrabold text-strong">
            Wheel<span className="text-brandblue">Deal</span>
          </span>
        </a>
        <a href="/login" className="btn btn-sm btn-primary my-3 rounded-xl px-4 py-1.5 text-[12px]">
          Sign in
        </a>
      </nav>

      <section className="pt-6 text-center">
        <h1 className="font-display text-[28px] font-extrabold text-strong">
          Simple plans, real savings
        </h1>
        <p className="mx-auto mt-2 max-w-[360px] text-[13px] text-soft">
          Every plan gets Will's honest negotiation. Paid plans give him more reach, more
          leverage and more of your time back. Billed every 3 months - cancel any time.
        </p>
      </section>

      <section className="mt-6 space-y-3 md:grid md:grid-cols-3 md:items-start md:gap-3 md:space-y-0">
        {PLANS.map((p) => (
          <PlanCard key={p.id} plan={p} />
        ))}
      </section>

      {/* New-shop reach - the real, enforced rolling-window capacity. */}
      <section className="mt-6">
        <div className="surface rounded-blob p-4">
          <h2 className="text-center font-display text-[16px] font-extrabold text-strong">
            How many shops your agent contacts
          </h2>
          <p className="mx-auto mt-1 max-w-[380px] text-center text-[11px] text-soft">
            The first shop is messaged right away; the rest follow at a safe, human pace.
            Capacity refreshes on a rolling window - it never waits until the next day.
          </p>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {(["free", "pro", "ultra"] as const).map((plan) => {
              const c = PLAN_CAPACITY[plan];
              return (
                <div
                  key={plan}
                  className={`rounded-2xl border p-3 text-center ${
                    plan === "ultra" ? "border-brandblue bg-brandblue-soft" : "border-line bg-card"
                  }`}
                >
                  <div className="text-[10px] font-extrabold uppercase tracking-wide text-faint">
                    {plan}
                  </div>
                  <div className="mt-1 text-[22px] font-extrabold leading-none text-strong">
                    {c.newContacts}
                  </div>
                  <div className="text-[11px] font-bold text-soft">
                    new shops / {c.windowHours}h
                  </div>
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-center text-[10px] text-faint">
            Every send is protected by the same anti-ban pacing on all plans - your WhatsApp
            number is never put at risk.
          </p>
        </div>
      </section>

      {/* Feature comparison - generated from the live entitlements map */}
      <section className="mt-8">
        <h2 className="mb-3 text-center font-display text-[20px] font-extrabold text-strong">
          What each plan unlocks
        </h2>
        <div className="surface overflow-x-auto rounded-blob">
          <table className="w-full min-w-[420px] text-left">
            <thead>
              <tr className="border-b border-line text-[11px] font-extrabold uppercase tracking-wide text-faint">
                <th className="px-3 py-2.5">Feature</th>
                <th className="px-2 py-2.5 text-center">Free</th>
                <th className="px-2 py-2.5 text-center">Pro</th>
                <th className="px-2 py-2.5 text-center">Ultra</th>
              </tr>
            </thead>
            <tbody>
              {FEATURES.map((f) => {
                const meta = FEATURE_META[f];
                return (
                  <tr key={f} className="border-b border-line last:border-0">
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5 text-[12px] font-extrabold text-strong">
                        <Icon name={meta.icon} className="h-3.5 w-3.5 shrink-0 text-brandblue" />
                        {meta.label}
                      </div>
                      <div className="text-[11px] text-faint">{meta.blurb}</div>
                    </td>
                    {(["free", "pro", "ultra"] as const).map((plan) => (
                      <td key={plan} className="px-2 py-2.5 text-center">
                        {ENTITLEMENTS[plan].has(f) ? (
                          <Icon name="check" className="mx-auto h-4 w-4 text-savings" />
                        ) : (
                          <span className="text-[12px] font-bold text-faint/50">-</span>
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-center text-[10px] text-faint">
          This table is generated from the same rules that run inside the product.
        </p>
      </section>

      <section className="mt-8 text-center">
        <a href="/login" className="btn btn-primary cta-sheen rounded-2xl px-6 py-3 text-[14px]">
          Start free
        </a>
      </section>

      <SiteFooter />
    </main>
  );
}
