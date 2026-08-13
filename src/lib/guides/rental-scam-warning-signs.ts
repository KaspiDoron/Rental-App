import type { Guide } from "./types";

const guide: Guide = {
  slug: "rental-scam-warning-signs",
  title: "Rental scams: the handful of patterns worth knowing",
  summary:
    "Most rental shops are honest. The dishonest ones use a small number of repeatable patterns, and every one of them is defeated by photographs taken before you ride away.",
  updated: "2026-08-13",
  category: "risk-safety",
  related: ["scooter-handover-checklist", "rental-deposit-passport"],
  sections: [
    {
      heading: "The pre-existing damage claim",
      blocks: [
        {
          kind: "p",
          text: "The most common pattern by a distance: you return the bike and are shown a scratch, a dent or a cracked panel that was already there, and asked for a repair fee far above what the repair costs.",
        },
        {
          kind: "p",
          text: "It is defeated completely by two minutes of photography. Before you ride away, take a slow video walking around the whole bike, plus close photos of every scratch you can find, the odometer, and the fuel gauge. Do it in front of the shop staff, not secretly - it is a normal thing to do and it changes the conversation before it happens.",
        },
        {
          kind: "p",
          text: "Keep the media until the deposit is back in your hand.",
        },
      ],
    },
    {
      heading: "The bike that is not the bike you agreed",
      blocks: [
        {
          kind: "p",
          text: "You negotiate a price for a 125cc automatic and are handed a 110, or an older model, at the same price. Sometimes this is genuinely the last bike on the lot; either way the price was agreed for something else.",
        },
        {
          kind: "p",
          text: "Confirm the model in writing before handover - a message saying which bike, at which price, for which dates, is enough. If a different bike appears, the price is re-openable and asking is completely reasonable.",
        },
      ],
    },
    {
      heading: "The deposit that develops conditions",
      blocks: [
        {
          kind: "p",
          text: "A deposit that was described as fully refundable acquires a cleaning fee, a late fee measured in minutes, or a fuel charge at several times pump price.",
        },
        {
          kind: "p",
          text: "Ask for the return conditions before paying, and ask specifically about fuel: \"same level as I got it\" is normal and fair, \"full tank\" when you received it half-empty is not.",
        },
      ],
    },
    {
      heading: "What is NOT a scam",
      blocks: [
        {
          kind: "p",
          text: "A high first quote is not a scam - it is an opening position, and negotiating is expected.",
        },
        {
          kind: "p",
          text: "A deposit request is not a scam. Nor is asking for a licence, or a photo of your passport page.",
        },
        {
          kind: "p",
          text: "A shop that only has one bike left, or is genuinely out of stock, is not running a bait-and-switch. Treating ordinary commerce as fraud is a good way to have a worse trip than the facts justify.",
        },
      ],
    },
    {
      heading: "The two minutes that defeat all of it",
      blocks: [
        {
          kind: "p",
          text: "Every pattern above shares one weakness: it depends on there being no record. A price agreed only in speech can drift; a scratch with no photograph has no age; a deposit condition never stated can grow conditions later. The counter-measure is the same in every case - make the record, openly, before money or keys move.",
        },
        {
          kind: "list",
          items: [
            "Confirm the model, the daily price, the dates and the deposit in the chat - one message, sent before handover.",
            "Walk around the bike on video, slowly, in front of the staff. Close photos of every existing mark, the odometer and the fuel gauge.",
            "Ask the return conditions out loud: fuel level, return time, and what \"same condition\" means to them.",
            "Keep everything until the deposit is back in your hand - not until you return the bike, until the money returns.",
          ],
        },
        {
          kind: "callout",
          text: "None of this requires suspicion or ceremony. Shops see travellers do it every day, and the honest majority actively prefer customers who document - it protects them from false claims exactly as it protects you from inflated ones.",
        },
      ],
    },
  ],
  faq: [
    {
      q: "A shop is asking me to pay everything up front. Is that a scam?",
      a: "Paying the rental up front is normal for short rentals; many shops work that way. What should stay separate and refundable is the deposit. If the shop blurs the two - a large single payment with vague promises about what comes back - slow down and get the split stated in writing.",
    },
    {
      q: "What do I do if a damage claim happens anyway?",
      a: "Stay calm, produce your handover video, and ask for the repair to be priced specifically. Most inflated claims deflate when met with time-stamped photographs and a request for an itemised cost. If it does not, involve your hotel or the tourist police rather than escalating alone - both exist for exactly this.",
    },
  ],
};

export default guide;
