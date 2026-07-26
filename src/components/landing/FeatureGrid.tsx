// How WheelDeal works + what makes it different. Server-safe (no hooks) so
// the landing page stays statically rendered and fast.

import { Icon } from "../icons";

const STEPS = [
  {
    icon: "chat",
    title: "Tell Will what you need",
    body: "“125cc scooter near my hotel for 5 days” - that's it. Will structures the request and finds every rental shop around you.",
  },
  {
    icon: "whatsapp",
    title: "Will negotiates on your own WhatsApp",
    body: "Real conversations with real shops - warm, human, never botty. Will knows the true local price floor and bargains toward it.",
  },
  {
    icon: "check",
    title: "You lock the best deal",
    body: "Compare confirmed offers - price, deposit, delivery - and book. The chat is yours to continue in WhatsApp.",
  },
];

const PERKS = [
  { icon: "sparkles", title: "Knows the real price", body: "Live market research anchors every negotiation to the true local floor - not the tourist price." },
  { icon: "clock", title: "Patient on purpose", body: "Will waits, times replies to opening hours and lets shops make the last move - patience is leverage." },
  { icon: "shieldCheck", title: "Careful with your number", body: "Every message goes out at a natural, human pace - never a robotic blast." },
  { icon: "compare", title: "100% transparent", body: "Every message, every decision, every wait - visible live, with the reasoning behind it." },
];

export function FeatureGrid() {
  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-3">
        {STEPS.map((s, i) => (
          <div key={s.title} className="surface rounded-blob p-4">
            <div className="flex items-center gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brandblue text-white">
                <Icon name={s.icon} className="h-5 w-5" />
              </span>
              <span className="text-[11px] font-extrabold uppercase tracking-wide text-faint">
                Step {i + 1}
              </span>
            </div>
            <div className="mt-2 text-[14px] font-extrabold text-strong">{s.title}</div>
            <p className="mt-1 text-[12px] leading-relaxed text-soft">{s.body}</p>
          </div>
        ))}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {PERKS.map((p) => (
          <div key={p.title} className="surface flex items-start gap-2.5 rounded-blob p-4">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brandblue-soft text-brandblue">
              <Icon name={p.icon} className="h-4 w-4" />
            </span>
            <div>
              <div className="text-[13px] font-extrabold text-strong">{p.title}</div>
              <p className="text-[12px] leading-relaxed text-soft">{p.body}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
