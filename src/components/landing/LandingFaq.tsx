// Static, server-rendered FAQ for the public landing page (SEO-friendly,
// zero JS - native <details>/<summary>). The in-app FaqSection stays
// admin-managed; this one answers the questions a brand-new visitor actually
// has before trusting an AI with their WhatsApp.

const FAQS: { q: string; a: string }[] = [
  {
    q: "What exactly is WheelDeal?",
    a: "A personal AI negotiator for vehicle rentals. Tell Will what you want to ride and where you're staying - he finds every rental shop nearby, messages them from your WhatsApp, and haggles the price down like a local. You watch everything live and only ever book what you approve.",
  },
  {
    q: "How is this different from Google Maps?",
    a: "Google Maps shows you pins. It doesn't know today's price, whether the scooter is available Friday, or that the shop two streets over charges 40% less. Will actually talks to every shop, gets real quotes, negotiates them down, and lines the offers up side by side.",
  },
  {
    q: "Why not just message the shops myself?",
    a: "You can - it takes hours, most shops reply in their own language, and the first price a tourist gets is rarely the real one. Will messages every shop at once, negotiates in the shop's own language with real market prices as ammunition, and never gets tired or awkward about asking for less.",
  },
  {
    q: "Is my WhatsApp safe?",
    a: "Your number is guarded by a safe-pacing engine: human rhythm, hard hourly and daily budgets, business-hours-only sending, a per-number trust score and an automatic safety pause at the first sign of anything unusual. We only ever see the rental-shop threads opened through WheelDeal - never your personal chats. You can disconnect with one tap.",
  },
  {
    q: "Do I have to accept what Will negotiates?",
    a: "Never. Will brings you offers - you compare them, ask him why he picked one, and decide. Nothing is booked and nothing is paid until you choose. You can pause the hunt or take over any conversation yourself at any moment.",
  },
  {
    q: "What does it cost?",
    a: "Starting is free - no card needed. Paid plans add more shops per hunt, mass bargaining and priority processing; one good negotiation usually covers months of the subscription.",
  },
  {
    q: "What happens after I book?",
    a: "You get a clean booking card with the agreed price, deposit and pickup details, and the shop has it confirmed in the same WhatsApp thread. Show up, show the chat, ride away.",
  },
];

export function LandingFaq() {
  return (
    <div className="space-y-2">
      {FAQS.map((f) => (
        <details key={f.q} className="surface group overflow-hidden rounded-2xl">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 p-3.5 text-[13px] font-extrabold text-strong [&::-webkit-details-marker]:hidden">
            {f.q}
            <span className="shrink-0 text-faint transition-transform group-open:rotate-90">›</span>
          </summary>
          <p className="border-t border-line px-3.5 py-3 text-[12px] leading-relaxed text-soft">
            {f.a}
          </p>
        </details>
      ))}
    </div>
  );
}
