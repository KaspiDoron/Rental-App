import type { Guide } from "./types";

const guide: Guide = {
  slug: "rental-deposit-passport",
  title: "Should you leave your passport as a rental deposit?",
  summary:
    "The short answer is no, and there is almost always a cash alternative. What the deposit is for, what is normal, and how to ask for the alternative without causing offence.",
  updated: "2026-08-13",
  category: "deposits-paperwork",
  related: [
    "scooter-rental-cash-deposit",
    "rental-contract-checklist",
    "rental-scam-warning-signs",
  ],
  sections: [
    {
      heading: "What the deposit is actually for",
      blocks: [
        {
          kind: "p",
          text: "A rental deposit exists so the shop is not left holding the loss if the bike is damaged or not returned. That is a legitimate need, and a shop asking for one is not trying to scam you. The question is only what form it takes.",
        },
        {
          kind: "p",
          text: "Three forms are common: a cash deposit (typically 2,000-5,000 THB or equivalent, returned at handover), a photocopy or photo of your passport, or the physical passport itself.",
        },
      ],
    },
    {
      heading: "Why the physical passport is the one to avoid",
      blocks: [
        {
          kind: "p",
          text: "Your passport is not yours to pledge. In most countries it remains the property of the issuing government, and you are required to be able to produce it. Leaving it in a drawer in a rental shop means you cannot check into a hotel, cannot fly, and have no recourse if the shop closes, changes hands, or the drawer is not where they said it was.",
        },
        {
          kind: "p",
          text: "It also changes the balance of any dispute completely. A disagreement about a scratch is a normal commercial disagreement when the shop holds 3,000 THB of your money. It is not a normal disagreement when they hold the document you need to leave the country.",
        },
        {
          kind: "p",
          text: "This is not a claim that shops asking for passports are dishonest - the overwhelming majority are not, and it is a genuinely common local practice. It is a claim that the downside is asymmetric enough that the alternative is worth one polite question.",
        },
      ],
    },
    {
      heading: "How to ask for the alternative",
      blocks: [
        {
          kind: "p",
          text: "Ask once, warmly, and offer something concrete in its place: a cash deposit, or a photo of the passport page. Something like \"I would rather not leave the passport itself - could I leave a cash deposit instead, or a photo of it?\" is understood everywhere and refused rarely.",
        },
        {
          kind: "p",
          text: "If a shop insists on the physical passport and will not take cash, that is a reason to use a different shop, not a reason to argue. There are usually a dozen within walking distance.",
        },
        {
          kind: "p",
          text: "Get the deposit amount and the return condition stated before you pay anything. \"Returned when the bike comes back in the same condition\" is the answer you want, and it is a fair one.",
        },
      ],
    },
    {
      heading: "What a normal cash deposit looks like",
      blocks: [
        {
          kind: "p",
          text: "For a standard 110-125cc scooter, a cash deposit of roughly 2,000-5,000 THB - or the local equivalent in Vietnam, Indonesia or the Philippines - is the ordinary range. It is meaningful enough to make walking away from a damaged bike expensive, and small enough that you can actually leave it without rearranging your trip's cash.",
        },
        {
          kind: "p",
          text: "A deposit far above that range deserves a question, not automatic refusal - a shop renting a new 160cc model may reasonably want more security than one renting a five-year-old Scoopy. But the question should still be asked, and \"why is the deposit this size?\" is a completely normal thing to say out loud.",
        },
        {
          kind: "list",
          items: [
            "Hand over the deposit at the shop, in front of the person you negotiated with - not to a runner who delivers the bike.",
            "Get the amount written somewhere: a line in the WhatsApp chat is enough and is time-stamped for free.",
            "Photograph the bike before the deposit changes hands, so its condition and your money are anchored to the same moment.",
            "Count the returned deposit before you hand the keys back, while both parties are still standing there.",
          ],
        },
      ],
    },
  ],
  faq: [
    {
      q: "Is a photo of my passport safe to give?",
      a: "It is the middle ground most shops accept happily. A photo lets the shop identify you to police if the bike vanishes, without taking the document you need to fly. Cover nothing, but know that the photo plus a cash deposit together satisfy almost every legitimate shop.",
    },
    {
      q: "What if I damage the bike - do I lose the whole deposit?",
      a: "You should lose the cost of the repair, not the deposit as a round number. Ask to see the damage priced - a scratch on a plastic panel has a knowable local repair cost, and honest shops will name it. This is exactly why a cash deposit beats a passport: the dispute stays proportionate.",
    },
  ],
};

export default guide;
