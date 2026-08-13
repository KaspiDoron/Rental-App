import type { Guide } from "./types";

const guide: Guide = {
  slug: "travel-insurance-scooter-accidents",
  title: "Travel insurance and scooter accidents: the exclusion that surprises people",
  summary:
    "Most travel policies quietly exclude riding you are not licensed for - what licensed actually means, the medical evacuation reality, and what to check before you fly.",
  updated: "2026-08-13",
  category: "licence-insurance",
  related: [
    "international-driving-permit-scooter",
    "motorcycle-licence-categories-explained",
    "first-week-riding-safety",
  ],
  sections: [
    {
      heading: "The exclusion, in plain terms",
      blocks: [
        {
          kind: "p",
          text: "Somewhere in the policy document you skimmed before your trip, there is very likely a clause about motorcycles. It takes one of a few forms: two-wheeled vehicles are excluded outright, or covered only below a certain engine size, or - the common and dangerous middle case - covered only if you were licensed to ride the vehicle. That last version is the trap, because everything around you in a Southeast Asian beach town suggests the licence question does not matter. Shops rent to anyone with cash. Half the travellers you meet are riding on a car licence or nothing.",
        },
        {
          kind: "p",
          text: "None of that visible normality moves your insurer an inch. The shop renting to you tells you about the shop's incentives, not about your coverage. When a claim is assessed, it is assessed against the policy wording and your documents, and \"everyone was doing it\" appears nowhere in either.",
        },
        {
          kind: "callout",
          text: "This guide is general information, not legal or financial advice. Policies differ, wordings change, and the only answer that counts for your trip is your insurer's answer about your policy - ideally obtained in writing before you travel.",
        },
      ],
    },
    {
      heading: "What \"licensed\" actually means",
      blocks: [
        {
          kind: "p",
          text: "Travellers tend to hear \"licensed\" as \"I have a driving licence and an International Driving Permit\". Insurers mean something narrower: that you held the correct category of licence for the specific vehicle, and often additionally that you were riding legally in the country you were in. Those are two separate requirements, and the IDP only addresses the second - it is a translation of the categories you already hold, and it adds none.",
        },
        {
          kind: "p",
          text: "The practical consequence: a car licence plus an IDP does not, for most travellers, make a 125cc scooter a covered vehicle. And details you might dismiss as technicalities can matter - a licence restricted to automatic transmissions and a manual bike, an engine above your category's limit, a helmet clause you did not read. The full chain has to hold, and it is worth walking each link before the trip rather than after the accident.",
        },
        {
          kind: "list",
          items: [
            "Your home licence includes a category that actually covers the bike you will ride - see the licence categories guide for what that means.",
            "You carry an IDP where the destination requires one, so you are riding legally in-country.",
            "The bike's engine size is within any cap your policy sets.",
            "Any restriction on your licence - automatic-only is the common one - matches the bike you actually rent.",
            "You are wearing a helmet, if the policy conditions cover on it - and it usually does.",
          ],
        },
      ],
    },
    {
      heading: "The medical evacuation reality",
      blocks: [
        {
          kind: "p",
          text: "The reason this exclusion deserves more attention than a roadside fine is what a serious scooter accident actually involves. On an island or in a rural province, the nearest clinic may stabilise you but not treat you; real treatment can mean transport to a major city, or in serious cases to another country with more advanced hospitals. Serious motorbike injuries in the region are not cheap to treat, and evacuation on top of treatment is the kind of cost families end up crowdfunding when no insurer is behind it.",
        },
        {
          kind: "p",
          text: "When a policy responds, the insurer's assistance line arranges and guarantees all of this - the transfer, the receiving hospital, the payment guarantees hospitals ask for before major procedures. When the claim is declined because the riding was excluded, every one of those steps still has to happen, arranged privately, at speed, by people who are not at their best. That gap - not the premium, not the fine - is what the licence question is really about.",
        },
      ],
    },
    {
      heading: "What to check in a policy before you fly",
      blocks: [
        {
          kind: "p",
          text: "You do not need to become a policy lawyer. You need answers to a handful of specific questions, and insurers answer specific questions much better than vague ones. Ask by email rather than phone, so the answer exists somewhere you can point to later.",
        },
        {
          kind: "list",
          items: [
            "Does this policy cover me riding a scooter or motorcycle at all, as rider and as passenger?",
            "Is there an engine size cap, and is the bike I plan to rent under it?",
            "What exactly is the licence requirement - licensed at home for this category, legally permitted locally, or both?",
            "Is medical evacuation included, and does it cover transfer to another country if needed?",
            "Does personal liability - injuring someone else or damaging their property - apply on a motor vehicle, or is that excluded? It very commonly is.",
            "Does anything change the answer: unpaved roads, riding at night, no helmet?",
          ],
        },
        {
          kind: "p",
          text: "If the honest outcome of that exercise is \"you are not covered on a scooter\", you have learned something valuable while it is still cheap to know. The options then are the ones from the IDP guide: fix the licence gap before the trip, buy a policy or add-on that genuinely covers riding, or choose a car, a bicycle or ride-hailing instead. All are better than a superstition that it will be fine.",
        },
      ],
    },
  ],
  faq: [
    {
      q: "The rental shop did not ask for a licence - does that affect my insurance?",
      a: "No. The shop's willingness to rent and your insurer's willingness to pay are unrelated. Claims are assessed against the policy wording and the documents you actually held, not against local rental practice.",
    },
    {
      q: "Does an International Driving Permit make me covered on a scooter?",
      a: "Not by itself. An IDP translates the categories your home licence already has - it adds none. If your home licence does not cover the bike, an IDP does not change that, and most policies with a licence condition will not respond.",
    },
    {
      q: "I will only ride a small automatic scooter - is that always fine?",
      a: "Not always. Whether a small scooter is covered depends on whether your home licence includes a category for it - some countries include small mopeds on a car licence and some do not - and on how your policy words its condition. Check both, before the trip.",
    },
    {
      q: "Is riding as a passenger on someone else's scooter covered?",
      a: "Sometimes, and sometimes under different conditions than riding yourself - helmet clauses in particular often still apply. It is one of the specific questions worth putting to your insurer in writing rather than assuming.",
    },
  ],
};

export default guide;
