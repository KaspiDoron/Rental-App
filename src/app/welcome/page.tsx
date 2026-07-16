// Public landing page - the first thing a signed-out visitor meets. Server
// component for SEO; the animated bits are small client islands. The whole
// app remains gated behind /login; this page only sells the story.

import type { Metadata } from "next";
import { BrandMark } from "@/components/BrandMark";
import { Icon } from "@/components/icons";
import { HeroDemo } from "@/components/landing/HeroDemo";
import { FeatureGrid } from "@/components/landing/FeatureGrid";
import { TrustPanel } from "@/components/landing/TrustPanel";
import { SiteFooter } from "@/components/SiteFooter";
import { PlanCard } from "@/components/UpgradeSheet";
import { PLANS } from "@/lib/stripe";
import { FOUNDER } from "@/lib/founder";

export const metadata: Metadata = {
  title: "WheelDeal - your personal AI rental negotiator",
  description:
    "Meet Will: an AI specialist that finds every scooter, motorbike and car rental near your hotel and negotiates the real local price for you - live, transparent, on your own WhatsApp.",
  alternates: { canonical: "/welcome" },
};

// A static preview of the live activity feed - the transparency promise IS
// the marketing.
const FEED_PREVIEW: { icon: string; title: string; detail: string; tone?: "wait" | "offer" }[] = [
  { icon: "send", title: "Asked Moto Rent Canggu for their best 5-day price", detail: "Worded uniquely, sent from your WhatsApp" },
  { icon: "sparkles", title: "Read the reply: 300/day quoted", detail: "Real local floor for a 125cc here is ~160/day" },
  { icon: "chat", title: "Countered warmly using your 5 days as leverage", detail: "\"Could you do 160 a day my friend? 🫶\"" },
  { icon: "clock", title: "Will is waiting 25 minutes on purpose", detail: "Answering instantly reads as desperate - patience is leverage", tone: "wait" },
  { icon: "money", title: "Deal improved: 180/day, cash deposit, free helmet", detail: "40% below the opening quote", tone: "offer" },
];

export default function WelcomePage() {
  return (
    <main className="mx-auto min-h-[100dvh] max-w-md px-4 pb-10 sm:max-w-lg md:max-w-3xl">
      {/* Nav */}
      <nav className="flex items-center justify-between pt-safe">
        <div className="flex items-center gap-2 py-3">
          <BrandMark size={34} />
          <span className="font-display text-lg font-extrabold text-strong">
            Wheel<span className="text-brandblue">Deal</span>
          </span>
        </div>
        <div className="flex items-center gap-2 py-3">
          <a href="/pricing" className="btn btn-sm btn-ghost rounded-xl px-3 py-1.5 text-[12px]">
            Pricing
          </a>
          <a href="/login" className="btn btn-sm btn-primary rounded-xl px-4 py-1.5 text-[12px]">
            Sign in
          </a>
        </div>
      </nav>

      {/* Hero */}
      <section className="pt-6 text-center md:pt-10">
        <div className="mx-auto mb-3 w-fit float-soft">
          <BrandMark size={72} />
        </div>
        <h1 className="font-display text-[32px] font-extrabold leading-tight text-strong md:text-[42px]">
          Meet <span className="text-brandblue">Will</span>,<br />
          your rental negotiator
        </h1>
        <p className="mx-auto mt-3 max-w-[340px] text-[14px] leading-relaxed text-soft md:max-w-md">
          Will finds every scooter, motorbike and car rental near your hotel - then haggles the
          <b> real local price</b> for you, live, on your own WhatsApp. You watch every move.
        </p>
        <div className="mt-5 flex items-center justify-center gap-2">
          <a href="/login" className="btn btn-primary cta-sheen rounded-2xl px-6 py-3 text-[15px]">
            <span className="flex items-center gap-2">
              <Icon name="bolt" className="h-5 w-5" /> Start free
            </span>
          </a>
          <a href="/pricing" className="btn btn-ghost rounded-2xl px-5 py-3 text-[14px]">
            See plans
          </a>
        </div>
        <p className="mt-3 text-[11px] font-bold text-faint">
          No card needed · Works in 100+ countries · You approve every booking
        </p>
      </section>

      {/* Live demo */}
      <section className="mt-8">
        <HeroDemo />
      </section>

      {/* How it works */}
      <section className="mt-10">
        <h2 className="mb-3 text-center font-display text-[22px] font-extrabold text-strong">
          Hours of haggling, done for you
        </h2>
        <FeatureGrid />
      </section>

      {/* Transparency showcase */}
      <section className="mt-10">
        <h2 className="text-center font-display text-[22px] font-extrabold text-strong">
          Watch every move, live
        </h2>
        <p className="mx-auto mt-1 max-w-[340px] text-center text-[13px] text-soft">
          Never wonder “is anything happening?” - every message, decision and strategic wait is
          visible, with the reasoning behind it.
        </p>
        <div className="surface mt-4 rounded-blob p-3">
          {FEED_PREVIEW.map((f, i) => (
            <div
              key={f.title}
              className={`flex items-start gap-2.5 px-1.5 py-2.5 ${
                i > 0 ? "border-t border-line" : ""
              }`}
            >
              <span
                className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                  f.tone === "offer"
                    ? "bg-savings-soft text-savings"
                    : f.tone === "wait"
                    ? "bg-brandyellow-soft text-[#8a6100]"
                    : "bg-brandblue-soft text-brandblue"
                }`}
              >
                <Icon name={f.icon} className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0">
                <div className="text-[12px] font-extrabold text-strong">{f.title}</div>
                <div className="text-[11px] text-faint">{f.detail}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* WhatsApp trust */}
      <section className="mt-10">
        <h2 className="mb-3 text-center font-display text-[22px] font-extrabold text-strong">
          Your WhatsApp, protected like a vault
        </h2>
        <TrustPanel />
      </section>

      {/* Pricing teaser */}
      <section className="mt-10">
        <h2 className="mb-1 text-center font-display text-[22px] font-extrabold text-strong">
          Start free, upgrade when it pays for itself
        </h2>
        <p className="mb-3 text-center text-[12px] font-bold text-faint">
          One good negotiation usually covers a whole quarter of Pro.
        </p>
        <div className="space-y-3 md:grid md:grid-cols-3 md:items-start md:gap-3 md:space-y-0">
          {PLANS.map((p) => (
            <PlanCard key={p.id} plan={p} />
          ))}
        </div>
        <div className="mt-4 text-center">
          <a href="/login" className="btn btn-primary cta-sheen rounded-2xl px-6 py-3 text-[14px]">
            Get started free
          </a>
        </div>
      </section>

      {/* Founder note */}
      <section className="surface mt-10 rounded-blob p-4 text-center">
        <div className="text-[13px] font-extrabold text-strong">
          Built by a solo founder who answers personally
        </div>
        <p className="mx-auto mt-1 max-w-[340px] text-[12px] leading-relaxed text-soft">
          I'm {FOUNDER.name}. I built WheelDeal because I got tired of paying the tourist price.
          Write to me any time - a real human reads every message.
        </p>
        <div className="mt-2.5 flex justify-center gap-2">
          <a href={`mailto:${FOUNDER.email}`} className="chip rounded-full border border-line px-3 py-1.5 text-[11px] font-extrabold text-brandblue">
            Email
          </a>
          <a href={FOUNDER.xUrl} target="_blank" rel="noopener noreferrer" className="chip rounded-full border border-line px-3 py-1.5 text-[11px] font-extrabold text-brandblue">
            @{FOUNDER.x}
          </a>
          <a href={FOUNDER.linkedinUrl} target="_blank" rel="noopener noreferrer" className="chip rounded-full border border-line px-3 py-1.5 text-[11px] font-extrabold text-brandblue">
            LinkedIn
          </a>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
