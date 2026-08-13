import type { Guide } from "./types";

const guide: Guide = {
  slug: "motorcycle-licence-categories-explained",
  title: "Motorcycle licence categories, explained for renters",
  summary:
    "Moped, light motorcycle, full licence - why the category on your home licence matters more than the IDP itself, and what shops check versus what insurers check.",
  updated: "2026-08-13",
  category: "licence-insurance",
  related: [
    "international-driving-permit-scooter",
    "travel-insurance-scooter-accidents",
    "car-vs-scooter-rental-abroad",
  ],
  sections: [
    {
      heading: "The category is the whole question",
      blocks: [
        {
          kind: "p",
          text: "Travellers researching scooter rental usually fixate on the International Driving Permit - do I need one, which convention, where to get it. Those questions have answers, but they are the second question. An IDP is a translation of the licence you already hold; it adds no entitlements. If your home licence does not include a category covering the bike, no permit, sticker or laminated card changes that. The first question, and the one that decides whether your insurance can respond after an accident, is: what exactly does my home licence let me ride?",
        },
        {
          kind: "p",
          text: "That sounds like it should be obvious from looking at the card, and often it is not. Licence categories are printed as codes, the codes differ between countries, and the code you have carried for years may cover more or less on two wheels than you assume. Most people have never had a reason to find out. Renting a scooter abroad is the reason.",
        },
      ],
    },
    {
      heading: "The generic ladder",
      blocks: [
        {
          kind: "p",
          text: "Naming and thresholds vary by country, so treat what follows as the shape of the system rather than the letter of anyone's law. Most licensing systems stack two-wheel entitlements in tiers, from the smallest machines to unlimited ones, and each tier includes the ones below it.",
        },
        {
          kind: "table",
          headers: ["Tier", "Roughly covers", "Rental relevance"],
          rows: [
            [
              "Moped",
              "The smallest, lowest-powered two-wheelers",
              "May not stretch to a typical 110-125cc rental scooter - this is the tier people overestimate",
            ],
            [
              "Light motorcycle (A1-style)",
              "Small motorcycles up to a modest engine size",
              "Generally the tier that covers the standard automatic rental scooter",
            ],
            [
              "Mid-tier (A2-style)",
              "Larger machines with power limits",
              "Covers most rental fleets, including the 150cc-plus bikes",
            ],
            [
              "Full motorcycle",
              "No practical limit",
              "Everything a rental shop will hand you",
            ],
          ],
        },
        {
          kind: "p",
          text: "The renter's trap lives at the bottom rung. A moped entitlement feels like \"I can ride scooters\", but the definition of a moped is usually narrow - very small engine, limited speed - and the ordinary rental scooter in Southeast Asia sits above it. Whether YOUR moped entitlement covers a given bike is a question only your issuing authority can answer, and it is worth asking them directly rather than a forum, a rental shop, or this page.",
        },
      ],
    },
    {
      heading: "Does a car licence cover a scooter?",
      blocks: [
        {
          kind: "p",
          text: "This is the single most consequential detail in the whole topic, and it genuinely goes both ways: some countries include small mopeds on a standard car licence, and some do not. Travellers from the first kind of country often assume their entitlement travels with them and covers whatever a shop rents them; travellers from the second kind sometimes have a motorcycle category they have forgotten about. Neither assumption survives contact with an insurance assessor.",
        },
        {
          kind: "p",
          text: "Even where a car licence does include mopeds, the two failure points from the ladder above still apply: the rental bike may be bigger than what your country defines as a moped, and the destination country may not recognise the entitlement the same way. The reliable way to resolve it is boring - check the official description of your licence categories with your licensing authority, then ask your insurer, in writing, whether you are covered on the specific kind of bike you intend to rent.",
        },
      ],
    },
    {
      heading: "Automatic-only restrictions",
      blocks: [
        {
          kind: "p",
          text: "Some motorcycle entitlements are restricted to automatic transmissions, usually because the test was taken on one. For most renters this is the rare piece of good news: the standard rental scooter is a twist-and-go automatic, so an automatic-only restriction and the cheapest bike on the lot are a natural match.",
        },
        {
          kind: "p",
          text: "It becomes relevant when the bike changes. Semi-automatic and manual bikes are common rental stock in parts of the region - Vietnam especially - and a manual bike sits outside an automatic-only entitlement no matter how confident you feel about the clutch. Manual and larger bikes also typically cost 30-60% above the automatic band, so the covered choice and the cheap choice are usually the same choice, which makes this an easy restriction to live with.",
        },
      ],
    },
    {
      heading: "What shops check vs what insurers check",
      blocks: [
        {
          kind: "p",
          text: "These are two different inspections, performed by two different parties, at two different times, for two different reasons - and confusing them is how most travellers end up misjudging their position.",
        },
        {
          kind: "list",
          items: [
            "Shops check before the rental, casually, if at all. Many ask for nothing; some glance at any plastic card; a few photograph it without reading the categories. Their incentive is renting bikes, and their check tells you only whether you can rent.",
            "Insurers check after a claim, forensically, on paper. They will read the category codes, the restrictions, the dates, and the local legality of your riding. Their check decides whether anyone pays for what just happened.",
            "The shop's leniency is not evidence about the insurer's answer. Passing the first check while failing the second is precisely the situation most unlicensed riders in the region are in.",
          ],
        },
        {
          kind: "callout",
          text: "If your licence has no usable two-wheel category, the honest options are the same ones the IDP guide reaches: add the category at home before you travel, rent a car - which your licence does cover - or use the region's ride-hailing apps. Renting the scooter anyway is a choice many travellers make; make it knowing which check you would fail.",
        },
      ],
    },
  ],
  faq: [
    {
      q: "My country lets me ride a small moped on my car licence - does that cover a rental scooter abroad?",
      a: "Not necessarily. Moped definitions are usually narrow, and the typical 110-125cc rental scooter may sit above yours. The IDP only translates what you already hold, so the answer depends on your home category and how the destination recognises it - check with your licensing authority and insurer.",
    },
    {
      q: "Will the rental shop check my licence category?",
      a: "Often they will not check anything at all, and almost never the category codes. That tells you about their commercial incentives, not about your legal position or your insurance - the party that reads the codes carefully is an insurer assessing a claim.",
    },
    {
      q: "Is an automatic-only restriction a problem for renting a scooter?",
      a: "Usually not - the standard rental scooter is a twist-and-go automatic. It matters if you are offered a semi-automatic or manual bike, which are common in parts of the region and sit outside the restriction, as well as typically costing 30-60% more than the automatic band.",
    },
  ],
};

export default guide;
