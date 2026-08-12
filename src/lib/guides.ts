// THE CRAWLABLE SITE WAS FOUR URLS, TWO OF THEM LEGAL BOILERPLATE (W-4).
//
// The AdSense rejection was read as "it looks like a SaaS app UI". It is not:
// `robots.ts` already welcomes Mediapartners-Google, and /welcome, /pricing,
// /terms and /privacy all sit OUTSIDE the middleware matcher, so the crawler
// can reach them fine. There is simply almost nothing there. Four pages, two of
// which are 32-line legal templates, is textbook "Low value content" - a
// four-post blog would be rejected identically.
//
// So the fix is content, and the only content worth writing is content that
// would exist even if AdSense did not: the questions this app's own users ask
// before they rent anything. Every number below is a range the agents actually
// negotiate against and the risk screen actually flags, so the pages stay true
// as the product learns rather than rotting into marketing copy.
//
// Deliberately DATA, not MDX: it is typed, it is one import for both the hub
// and the detail route, and the sitemap derives from the same array - so a
// guide cannot exist without being listed, or be listed without existing.

export interface GuideSection {
  heading: string;
  body: string[];
}

export interface Guide {
  slug: string;
  title: string;
  /** One line for the hub card and the meta description. */
  summary: string;
  updated: string;
  sections: GuideSection[];
}

export const GUIDES: Guide[] = [
  {
    slug: "scooter-rental-prices-southeast-asia",
    title: "What a scooter should actually cost in Southeast Asia",
    summary:
      "Honest daily-rate ranges for Thailand, Vietnam, Indonesia and the Philippines - and why the first price you are quoted is almost never the last one.",
    updated: "2026-08",
    sections: [
      {
        heading: "The ranges shops actually settle at",
        body: [
          "A 110-125cc automatic scooter - the Honda Click, Yamaha NMAX, Vario or Scoopy that makes up most of any rental fleet - settles in a fairly narrow band once you are past the first quote. In Thailand that is roughly 150-250 THB a day in a beach town and 200-300 in Bangkok or Phuket. In Vietnam, 100,000-180,000 VND. In Bali, 60,000-100,000 IDR. In the Philippines, 400-600 PHP.",
          "Those are DAILY rates for a rental of several days. A one-day rental almost always costs more per day, and a monthly rate is usually 40-60% cheaper per day than the daily one. If a shop quotes you a single number with no reference to how long you are staying, they have not yet given you their real price.",
          "A 150cc or larger bike, or anything with a manual gearbox, is typically 30-60% above the automatic band. If you are quoted a 125cc price and handed a 150, that is not a free upgrade - it usually means the smaller bike is out and you should re-open the price.",
        ],
      },
      {
        heading: "Why the first quote is high",
        body: [
          "In most of the region, the first number is an opening position, not a price list. It is normal, expected, and not personal. Shops quote high to tourists for the same reason market stalls do: enough people accept it that quoting low costs them money.",
          "The single most effective thing you can do is say how many days you want up front. A four-day rental is worth materially more to a shop than a one-day rental, and the discount for it is usually already in their head - they just do not volunteer it.",
          "The second most effective thing is to be talking to more than one shop. Not as a bluff, but because you genuinely do not know the local floor until two or three independent shops have quoted you.",
        ],
      },
      {
        heading: "What is NOT included in the daily rate",
        body: [
          "Delivery to your hotel is frequently a separate charge, and it is frequently not mentioned until handover. Ask what delivery costs and whether collecting at the shop is cheaper - the answer is often 100-200 THB or equivalent, which can be a meaningful fraction of a short rental.",
          "Helmets are usually included, but often only one. If two of you are riding, ask for two explicitly.",
          "Fuel is almost never included. Scooters are commonly handed over near-empty; assume you are paying for the first tank.",
        ],
      },
    ],
  },
  {
    slug: "rental-deposit-passport",
    title: "Should you leave your passport as a rental deposit?",
    summary:
      "The short answer is no, and there is almost always a cash alternative. What the deposit is for, what is normal, and how to ask for the alternative without causing offence.",
    updated: "2026-08",
    sections: [
      {
        heading: "What the deposit is actually for",
        body: [
          "A rental deposit exists so the shop is not left holding the loss if the bike is damaged or not returned. That is a legitimate need, and a shop asking for one is not trying to scam you. The question is only what form it takes.",
          "Three forms are common: a cash deposit (typically 2,000-5,000 THB or equivalent, returned at handover), a photocopy or photo of your passport, or the physical passport itself.",
        ],
      },
      {
        heading: "Why the physical passport is the one to avoid",
        body: [
          "Your passport is not yours to pledge. In most countries it remains the property of the issuing government, and you are required to be able to produce it. Leaving it in a drawer in a rental shop means you cannot check into a hotel, cannot fly, and have no recourse if the shop closes, changes hands, or the drawer is not where they said it was.",
          "It also changes the balance of any dispute completely. A disagreement about a scratch is a normal commercial disagreement when the shop holds 3,000 THB of your money. It is not a normal disagreement when they hold the document you need to leave the country.",
          "This is not a claim that shops asking for passports are dishonest - the overwhelming majority are not, and it is a genuinely common local practice. It is a claim that the downside is asymmetric enough that the alternative is worth one polite question.",
        ],
      },
      {
        heading: "How to ask for the alternative",
        body: [
          "Ask once, warmly, and offer something concrete in its place: a cash deposit, or a photo of the passport page. Something like \"I would rather not leave the passport itself - could I leave a cash deposit instead, or a photo of it?\" is understood everywhere and refused rarely.",
          "If a shop insists on the physical passport and will not take cash, that is a reason to use a different shop, not a reason to argue. There are usually a dozen within walking distance.",
          "Get the deposit amount and the return condition stated before you pay anything. \"Returned when the bike comes back in the same condition\" is the answer you want, and it is a fair one.",
        ],
      },
    ],
  },
  {
    slug: "international-driving-permit-scooter",
    title: "Do you need an International Driving Permit to rent a scooter?",
    summary:
      "In most of Southeast Asia, yes - and the consequence of not having one is usually about insurance, not about police. What an IDP is, what it costs, and what it actually changes.",
    updated: "2026-08",
    sections: [
      {
        heading: "What an IDP is",
        body: [
          "An International Driving Permit is a standardised translation of your existing home licence. It is not a licence in itself and it does not test you on anything - it is issued by an authority in your own country, usually over the counter or by post, typically for a small fee, and typically valid for a year.",
          "Crucially, it only covers the categories your home licence already covers. If your home licence does not include motorcycles, an IDP does not add them. A car licence plus an IDP does not make you legal on a 125cc scooter in most of the region, which is the single most common misunderstanding.",
        ],
      },
      {
        heading: "What actually goes wrong without one",
        body: [
          "The visible consequence is a roadside fine, which in most places is small and routine. That is not the real risk.",
          "The real risk is insurance. Travel and medical policies commonly exclude injuries sustained while operating a vehicle you were not licensed to operate. A scooter accident that would have been a covered claim becomes an uncovered one, and motorbike injuries in the region are not cheap to treat.",
          "Rental shops will very often rent to you without asking. That is a statement about their commercial incentives, not about your legal position or your insurer's.",
        ],
      },
      {
        heading: "Get it before you fly",
        body: [
          "An IDP has to be issued in the country that issued your licence. You cannot get one once you have arrived, which is why this is worth handling before the trip rather than at the rental counter.",
          "If you already know you will only be riding a scooter, check specifically that your home licence carries a motorcycle or moped category. Some countries include small-displacement mopeds on a standard car licence and some do not, and that detail is what your insurer will look at.",
        ],
      },
      {
        heading: "Country by country, roughly",
        body: [
          "Thailand recognises the 1949 Geneva convention permit and asks for it at roadside checks in tourist areas fairly routinely. Vietnam recognises the 1968 Vienna convention permit, which some countries - including the United States - do not issue, so American riders in Vietnam are frequently unlicensed whatever paperwork they carry.",
          "Indonesia recognises the 1949 permit and enforcement in Bali is common near the main tourist corridors. The Philippines lets many visitors drive on a valid home licence alone for a limited period, which makes it the most forgiving of the four - but the insurance question above does not change.",
          "None of this is legal advice and rules move. The reason to carry an IDP is not that you have memorised which convention applies where; it is that it is cheap, it is valid for a year, and it removes the question entirely.",
        ],
      },
      {
        heading: "If you are refused one",
        body: [
          "If your home licence has no motorcycle category and you cannot add one before the trip, the honest options are a car (which your licence does cover), a bicycle or e-bike where the local rules allow it, or the region's genuinely excellent ride-hailing apps.",
          "Renting a scooter you are not licensed for is a choice a great many travellers make. It is worth making it knowingly, with the insurance consequence understood, rather than discovering it in a hospital admissions office.",
        ],
      },
    ],
  },
  {
    slug: "rental-scam-warning-signs",
    title: "Rental scams: the handful of patterns worth knowing",
    summary:
      "Most rental shops are honest. The dishonest ones use a small number of repeatable patterns, and every one of them is defeated by photographs taken before you ride away.",
    updated: "2026-08",
    sections: [
      {
        heading: "The pre-existing damage claim",
        body: [
          "The most common pattern by a distance: you return the bike and are shown a scratch, a dent or a cracked panel that was already there, and asked for a repair fee far above what the repair costs.",
          "It is defeated completely by two minutes of photography. Before you ride away, take a slow video walking around the whole bike, plus close photos of every scratch you can find, the odometer, and the fuel gauge. Do it in front of the shop staff, not secretly - it is a normal thing to do and it changes the conversation before it happens.",
          "Keep the media until the deposit is back in your hand.",
        ],
      },
      {
        heading: "The bike that is not the bike you agreed",
        body: [
          "You negotiate a price for a 125cc automatic and are handed a 110, or an older model, at the same price. Sometimes this is genuinely the last bike on the lot; either way the price was agreed for something else.",
          "Confirm the model in writing before handover - a message saying which bike, at which price, for which dates, is enough. If a different bike appears, the price is re-openable and asking is completely reasonable.",
        ],
      },
      {
        heading: "The deposit that develops conditions",
        body: [
          "A deposit that was described as fully refundable acquires a cleaning fee, a late fee measured in minutes, or a fuel charge at several times pump price.",
          "Ask for the return conditions before paying, and ask specifically about fuel: \"same level as I got it\" is normal and fair, \"full tank\" when you received it half-empty is not.",
        ],
      },
      {
        heading: "What is NOT a scam",
        body: [
          "A high first quote is not a scam - it is an opening position, and negotiating is expected.",
          "A deposit request is not a scam. Nor is asking for a licence, or a photo of your passport page.",
          "A shop that only has one bike left, or is genuinely out of stock, is not running a bait-and-switch. Treating ordinary commerce as fraud is a good way to have a worse trip than the facts justify.",
        ],
      },
    ],
  },
];

export function guideBySlug(slug: string): Guide | undefined {
  return GUIDES.find((g) => g.slug === slug);
}
