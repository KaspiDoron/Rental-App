// Public landing page - the first thing a signed-out visitor meets. Server
// component for SEO; the animated bits are small client islands. The whole
// app remains gated behind /login; this page only sells the story.
//
// Structure follows the Eddy Travels playbook (companion speaks first, story
// before the ask, generous whitespace, friendliness over feature lists) while
// keeping WheelDeal's own premium dark identity.

import type { Metadata } from "next";
import { BrandMark } from "@/components/BrandMark";
import { Icon } from "@/components/icons";
import { WillAvatar } from "@/components/will/WillAvatar";
import { HeroDemo } from "@/components/landing/HeroDemo";
import { FeatureGrid } from "@/components/landing/FeatureGrid";
import { TrustPanel } from "@/components/landing/TrustPanel";
import { LandingFaq } from "@/components/landing/LandingFaq";
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
  { icon: "clock", title: "Will is waiting 25 minutes on purpose", detail: "A short, deliberate pause makes the shop take your offer seriously", tone: "wait" },
  { icon: "money", title: "Deal improved: 180/day, cash deposit, free helmet", detail: "40% below the opening quote", tone: "offer" },
];

// The three-step journey - numbered, human, no jargon.
const JOURNEY = [
  {
    n: "1",
    title: "Tell Will what you need",
    body: "\"A Honda Click near Kata Beach, 5 days, under 200 a day.\" One sentence is enough - Will asks if anything is missing.",
  },
  {
    n: "2",
    title: "Will works every shop nearby",
    body: "He finds the rental shops around your hotel and negotiates with all of them at once - in their language, at a polite human pace, from your own WhatsApp.",
  },
  {
    n: "3",
    title: "You pick from real offers",
    body: "Negotiated prices line up side by side. Compare, ask Will why, lock the one you like. Nothing is booked without you.",
  },
];

// Honest head-to-head: the alternatives a traveller actually weighs.
const COMPARE: { label: string; them: string; us: string }[] = [
  {
    label: "Finding shops",
    them: "Google Maps shows pins - no prices, no availability",
    us: "Will messages every shop near your hotel and gets live quotes",
  },
  {
    label: "The price you get",
    them: "The tourist price - the first number they say",
    us: "The local price - negotiated with market data as ammunition",
  },
  {
    label: "Your time",
    them: "Hours of walking, waiting and awkward haggling",
    us: "Minutes - you watch offers arrive while you're at the beach",
  },
  {
    label: "Language",
    them: "Google Translate and hand gestures",
    us: "Will bargains fluently in the shop's own language",
  },
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

      {/* Hero - Will speaks FIRST, like a companion, before anything is asked */}
      <section className="pt-8 text-center md:pt-12">
        <div className="mx-auto flex w-fit items-end gap-1.5">
          <div className="float-soft">
            <WillAvatar size={92} className="drop-shadow-xl" />
          </div>
          <div className="relative mb-6 max-w-[240px] rounded-2xl rounded-bl-md bg-card2 px-3.5 py-2.5 text-left shadow-lg rise-in">
            <p className="text-[13px] font-extrabold leading-snug text-strong">
              Hi! I&apos;m Will, your rental negotiator.
            </p>
            <p className="mt-0.5 text-[12px] leading-snug text-soft">
              Tell me what you want to ride - I&apos;ll haggle like a local.
            </p>
            <span aria-hidden className="absolute -left-1 bottom-3 h-2.5 w-2.5 rotate-45 bg-card2" />
          </div>
        </div>
        <h1 className="mt-4 font-display text-[32px] font-extrabold leading-tight text-strong md:text-[42px]">
          The local price,<br />
          without the haggling
        </h1>
        <p className="mx-auto mt-3 max-w-[340px] text-[14px] leading-relaxed text-soft md:max-w-md">
          Will finds every scooter, motorbike and car rental near your hotel - then negotiates the
          <b> real local price</b> for you, live, on your own WhatsApp. You watch every move.
        </p>
        <div className="mt-6 flex items-center justify-center gap-2">
          <a href="/login" className="btn btn-primary cta-sheen rounded-2xl px-7 py-3.5 text-[15px]">
            <span className="flex items-center gap-2">
              <Icon name="bolt" className="h-5 w-5" /> Start free
            </span>
          </a>
          <a href="/pricing" className="btn btn-ghost rounded-2xl px-5 py-3.5 text-[14px]">
            See plans
          </a>
        </div>
        <p className="mt-3 text-[11px] font-bold text-faint">
          No card needed · Works in 100+ countries · You approve every booking
        </p>
      </section>

      {/* Live demo */}
      <section className="mt-10">
        <HeroDemo />
      </section>

      {/* The journey - story before features */}
      <section className="mt-14">
        <h2 className="mb-5 text-center font-display text-[22px] font-extrabold text-strong">
          How a hunt works
        </h2>
        <div className="space-y-4 md:grid md:grid-cols-3 md:gap-4 md:space-y-0">
          {JOURNEY.map((s) => (
            <div key={s.n} className="surface relative rounded-blob p-4 pl-5">
              <span className="absolute -left-2 -top-2 flex h-9 w-9 items-center justify-center rounded-full bg-brandblue font-display text-[15px] font-extrabold text-white shadow-lg">
                {s.n}
              </span>
              <div className="text-[14px] font-extrabold text-strong">{s.title}</div>
              <p className="mt-1 text-[12px] leading-relaxed text-soft">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Why not just...? - the honest comparison */}
      <section className="mt-14">
        <h2 className="text-center font-display text-[22px] font-extrabold text-strong">
          &quot;Why not just use Google Maps?&quot;
        </h2>
        <p className="mx-auto mt-1 max-w-[340px] text-center text-[13px] text-soft">
          Because pins don&apos;t haggle. Here&apos;s the honest difference:
        </p>
        <div className="surface mt-4 overflow-hidden rounded-blob">
          {COMPARE.map((row, i) => (
            <div key={row.label} className={`p-3.5 ${i > 0 ? "border-t border-line" : ""}`}>
              <div className="text-[10px] font-extrabold uppercase tracking-wide text-faint">
                {row.label}
              </div>
              <div className="mt-1.5 grid gap-1.5 md:grid-cols-2 md:gap-3">
                <div className="flex items-start gap-1.5 text-[12px] leading-snug text-faint">
                  <span className="mt-0.5 shrink-0">·</span> {row.them}
                </div>
                <div className="flex items-start gap-1.5 text-[12px] font-bold leading-snug text-strong">
                  <Icon name="check" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-savings" />
                  {row.us}
                </div>
              </div>
            </div>
          ))}
        </div>
        <p className="mx-auto mt-3 max-w-[360px] text-center text-[12px] font-bold text-soft">
          Shops quote tourists high. The real local floor is often 20-40% lower - Will&apos;s whole
          job is to reach it.
        </p>
      </section>

      {/* Feature grid */}
      <section className="mt-14">
        <h2 className="mb-3 text-center font-display text-[22px] font-extrabold text-strong">
          Hours of haggling, done for you
        </h2>
        <FeatureGrid />
      </section>

      {/* Transparency showcase */}
      <section className="mt-14">
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
      <section className="mt-14">
        <h2 className="mb-3 text-center font-display text-[22px] font-extrabold text-strong">
          Your WhatsApp, protected like a vault
        </h2>
        <TrustPanel />
      </section>

      {/* Pricing teaser */}
      <section className="mt-14">
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
      </section>

      {/* FAQ */}
      <section className="mt-14">
        <h2 className="mb-3 text-center font-display text-[22px] font-extrabold text-strong">
          Questions travellers ask
        </h2>
        <LandingFaq />
      </section>

      {/* Final ask - Will again, closing the loop */}
      <section className="mt-14 text-center">
        <div className="mx-auto flex w-fit items-end gap-1.5">
          <WillAvatar size={56} />
          <div className="relative mb-3 rounded-2xl rounded-bl-md bg-card2 px-3 py-2 text-left shadow-md">
            <p className="text-[12px] font-extrabold text-strong">
              Ready when you are - your first hunt is free.
            </p>
            <span aria-hidden className="absolute -left-1 bottom-2.5 h-2 w-2 rotate-45 bg-card2" />
          </div>
        </div>
        <div className="mt-3">
          <a href="/login" className="btn btn-primary cta-sheen rounded-2xl px-8 py-3.5 text-[15px]">
            Get started free
          </a>
        </div>
      </section>

      {/* Founder note */}
      <section className="surface mt-14 rounded-blob p-4 text-center">
        <div className="text-[13px] font-extrabold text-strong">
          Built by a solo founder who answers personally
        </div>
        <p className="mx-auto mt-1 max-w-[340px] text-[12px] leading-relaxed text-soft">
          I&apos;m {FOUNDER.name}. I built WheelDeal because I got tired of paying the tourist price.
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
