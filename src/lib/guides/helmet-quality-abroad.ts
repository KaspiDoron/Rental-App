import type { Guide } from "./types";

const guide: Guide = {
  slug: "helmet-quality-abroad",
  title: "Rental helmets are often decorative - here is what a real one needs",
  summary:
    "The helmet handed over with a rental scooter frequently exists to satisfy a police checkpoint, not to protect a head - how to tell, and what to do about it.",
  updated: "2026-08-13",
  category: "risk-safety",
  related: ["first-week-riding-safety", "rainy-season-scooter-riding"],
  sections: [
    {
      heading: "What the free helmet is actually for",
      blocks: [
        {
          kind: "p",
          text: "The helmet that comes with a rental scooter has one job in the shop's eyes: it stops you being fined at a checkpoint. It has usually been through years of sun, rain, and dozens of previous renters, and it was often a cheap open-face shell to begin with. It sits on your head the way a bowl sits on a shelf, which is roughly how well it will stay there in a crash.",
        },
        {
          kind: "p",
          text: "This is not a scandal and the shop is not lying to you - nobody claimed it was good, and the daily rate you negotiated does not fund helmet replacement. But it does mean the decision about what protects your head is yours, not theirs, and it is worth thirty seconds of actual inspection rather than an assumption.",
        },
        {
          kind: "p",
          text: "Head injuries are the injuries that end trips, and scooter speeds in town traffic are more than enough to cause them. Everything below is cheap insurance against the single worst outcome a scooter holiday offers.",
        },
      ],
    },
    {
      heading: "Thirty seconds of inspection",
      blocks: [
        {
          kind: "p",
          text: "You do not need expertise to sort a real helmet from a decorative one. Most of the failures are visible or obvious the moment you put it on.",
        },
        {
          kind: "list",
          items: [
            "Fit: it should grip your head snugly enough that shaking your head moves the helmet with it, not around it. A helmet that rotates freely will rotate off in a crash.",
            "Strap: a working buckle and a strap you can tighten so only a finger or two fits under your chin. A frayed strap or a buckle that pops open under a firm tug is disqualifying on its own.",
            "Shell: no cracks, no deep gouges, no sections that flex when you press them. A helmet that has already been dropped hard has done its one job.",
            "Sun damage: a shell faded to chalky pastel has been baking on a rack for years, and the materials underneath age with it.",
            "Interior: padding that has collapsed to nothing means the helmet is effectively a size too big, whatever the label says.",
            "Visor: if it has one, it should be clear enough to see through at night, not a fog of scratches. A scratched visor at night turns every oncoming headlight into a starburst.",
          ],
        },
        {
          kind: "callout",
          text: "Genuine safety standards exist - European ECE-type markings are the ones you will most often see moulded or stamped inside a real helmet - but a printed sticker proves nothing, because stickers are applied to anything. Judge the helmet in your hands, not the label on it.",
        },
      ],
    },
    {
      heading: "Ask for a better one - shops usually have one",
      blocks: [
        {
          kind: "p",
          text: "The rack by the door holds the helmets nobody asked about. Shops frequently keep a few decent ones - newer, full-face or at least three-quarter, with intact padding - for the customers who ask, because renters who care about helmets are also renters who bring bikes back in one piece.",
        },
        {
          kind: "p",
          text: "So ask, plainly: this one does not fit, do you have a newer one, do you have a full-face one. Try several. This is a completely normal request and it costs nothing; at most a shop will ask a small extra charge for a visibly better helmet, and that is a trade worth taking without negotiation.",
        },
        {
          kind: "p",
          text: "If you are two people, insist on two helmets that both pass the same inspection. The passenger's head is not more durable than the rider's, and the second helmet on offer is usually the worse one.",
        },
      ],
    },
    {
      heading: "For longer stays, just buy one",
      blocks: [
        {
          kind: "p",
          text: "If you are in the region for weeks rather than days, the arithmetic changes. Local shops and department stores across Southeast Asia sell genuine entry-level helmets from real manufacturers at prices that look absurd compared to home - locals ride every day and buy their own helmets, so a real market exists and you can shop in it.",
        },
        {
          kind: "p",
          text: "Buy where locals buy: a helmet shop or a large store, not a souvenir stall. Pick a recognisable brand, check the moulded standards markings inside rather than trusting stickers, and above all buy the size that grips your head. A cheap real helmet that fits beats an expensive one that does not.",
        },
        {
          kind: "p",
          text: "A new lid also solves the problem nobody mentions with rental helmets: the interior has absorbed the sweat of everyone before you, and no amount of sunshine on a rack fixes that.",
        },
      ],
    },
    {
      heading: "What to wear on your head, honestly ranked",
      blocks: [
        {
          kind: "table",
          headers: ["Option", "Protection", "Realistic verdict"],
          rows: [
            ["Full-face helmet, good condition", "Best - covers the chin, which takes a large share of impacts", "Buy one for long stays; ask the shop for one for short stays"],
            ["Three-quarter open-face, good condition", "Reasonable for town speeds, nothing for your face", "Acceptable if it fits and the strap works"],
            ["Typical rental half-shell", "Marginal - often stays on only until it matters", "Wear it only until you can swap it for better"],
            ["Nothing, or unbuckled", "None - an unbuckled helmet leaves your head at the first bounce", "Not an option, whatever the locals around you do"],
          ],
        },
        {
          kind: "p",
          text: "One more habit that costs nothing: actually buckle it, every time, including the two-minute ride to breakfast. An unbuckled helmet protects you from the checkpoint fine and from nothing else, and the two-minute rides are where the guard drops.",
        },
      ],
    },
  ],
  faq: [
    {
      q: "Can I just check the sticker to know a helmet is safe?",
      a: "No. Real standards markings are typically moulded or stamped into the helmet, but stickers get printed onto anything, including toy-grade shells. The fit, the strap, and the condition of the shell in your hands tell you more than any label.",
    },
    {
      q: "Is it rude to reject the helmet the shop offers?",
      a: "Not at all - asking for a newer or better-fitting helmet is routine, and shops usually have a better one behind the counter for exactly this question. The worst case is a small extra charge, which is worth paying.",
    },
    {
      q: "Locals ride without helmets - is it really that important for a short ride?",
      a: "Locals also crash, and short familiar rides are precisely where visitors let their guard down. Speeds in town traffic are more than enough to cause a serious head injury, and the helmet only works if it is on and buckled.",
    },
    {
      q: "Should the passenger get the same quality helmet?",
      a: "Yes. A pillion passenger falls from the same bike at the same speed, and the second helmet a shop offers is usually the worse one - inspect both by the same standard and ask for a replacement if either fails.",
    },
  ],
};

export default guide;
