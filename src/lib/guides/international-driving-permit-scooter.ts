import type { Guide } from "./types";

const guide: Guide = {
  slug: "international-driving-permit-scooter",
  title: "Do you need an International Driving Permit to rent a scooter?",
  summary:
    "In most of Southeast Asia, yes - and the consequence of not having one is usually about insurance, not about police. What an IDP is, what it costs, and what it actually changes.",
  updated: "2026-08-13",
  category: "licence-insurance",
  related: [
    "motorcycle-licence-categories-explained",
    "travel-insurance-scooter-accidents",
  ],
  sections: [
    {
      heading: "What an IDP is",
      blocks: [
        {
          kind: "p",
          text: "An International Driving Permit is a standardised translation of your existing home licence. It is not a licence in itself and it does not test you on anything - it is issued by an authority in your own country, usually over the counter or by post, typically for a small fee, and typically valid for a year.",
        },
        {
          kind: "p",
          text: "Crucially, it only covers the categories your home licence already covers. If your home licence does not include motorcycles, an IDP does not add them. A car licence plus an IDP does not make you legal on a 125cc scooter in most of the region, which is the single most common misunderstanding.",
        },
      ],
    },
    {
      heading: "What actually goes wrong without one",
      blocks: [
        {
          kind: "p",
          text: "The visible consequence is a roadside fine, which in most places is small and routine. That is not the real risk.",
        },
        {
          kind: "p",
          text: "The real risk is insurance. Travel and medical policies commonly exclude injuries sustained while operating a vehicle you were not licensed to operate. A scooter accident that would have been a covered claim becomes an uncovered one, and motorbike injuries in the region are not cheap to treat.",
        },
        {
          kind: "p",
          text: "Rental shops will very often rent to you without asking. That is a statement about their commercial incentives, not about your legal position or your insurer's.",
        },
      ],
    },
    {
      heading: "Get it before you fly",
      blocks: [
        {
          kind: "p",
          text: "An IDP has to be issued in the country that issued your licence. You cannot get one once you have arrived, which is why this is worth handling before the trip rather than at the rental counter.",
        },
        {
          kind: "p",
          text: "If you already know you will only be riding a scooter, check specifically that your home licence carries a motorcycle or moped category. Some countries include small-displacement mopeds on a standard car licence and some do not, and that detail is what your insurer will look at.",
        },
      ],
    },
    {
      heading: "Country by country, roughly",
      blocks: [
        {
          kind: "p",
          text: "Thailand recognises the 1949 Geneva convention permit and asks for it at roadside checks in tourist areas fairly routinely. Vietnam recognises the 1968 Vienna convention permit, which some countries - including the United States - do not issue, so American riders in Vietnam are frequently unlicensed whatever paperwork they carry.",
        },
        {
          kind: "p",
          text: "Indonesia recognises the 1949 permit and enforcement in Bali is common near the main tourist corridors. The Philippines lets many visitors drive on a valid home licence alone for a limited period, which makes it the most forgiving of the four - but the insurance question above does not change.",
        },
        {
          kind: "p",
          text: "None of this is legal advice and rules move. The reason to carry an IDP is not that you have memorised which convention applies where; it is that it is cheap, it is valid for a year, and it removes the question entirely.",
        },
      ],
    },
    {
      heading: "If you are refused one",
      blocks: [
        {
          kind: "p",
          text: "If your home licence has no motorcycle category and you cannot add one before the trip, the honest options are a car (which your licence does cover), a bicycle or e-bike where the local rules allow it, or the region's genuinely excellent ride-hailing apps.",
        },
        {
          kind: "p",
          text: "Renting a scooter you are not licensed for is a choice a great many travellers make. It is worth making it knowingly, with the insurance consequence understood, rather than discovering it in a hospital admissions office.",
        },
      ],
    },
  ],
  faq: [
    {
      q: "Will the rental shop check my IDP?",
      a: "Often not - many shops rent on a passport photo and a deposit alone. That is a statement about their commercial incentives, not about your legal position. The two parties who do care are roadside police in tourist areas and, far more importantly, your insurer after an accident.",
    },
    {
      q: "Can I get an IDP after I have already arrived?",
      a: "No. An IDP must be issued in the country that issued your licence, usually over the counter or by post before you travel. Websites selling \"international licences\" to travellers already abroad are selling paper that neither police nor insurers recognise.",
    },
    {
      q: "My licence covers cars only - is a scooter really different?",
      a: "For insurers, yes. A 125cc scooter is a motorcycle in most licensing systems, and a car licence plus an IDP does not add the category. If you cannot add a motorcycle category before the trip, a rental car - which your licence does cover - keeps your insurance intact.",
    },
  ],
};

export default guide;
