import type { Guide } from "./types";

const guide: Guide = {
  slug: "rental-contract-checklist",
  title: "The scooter rental checklist - with or without a contract",
  summary:
    "Most rentals in the region run on a handshake and a chat thread - here are the six terms that need to exist in writing anyway, and the one message that gets them there.",
  updated: "2026-08-13",
  category: "deposits-paperwork",
  related: [
    "scooter-rental-cash-deposit",
    "scooter-handover-checklist",
    "rental-deposit-passport",
  ],
  sections: [
    {
      heading: "There is often no contract - and that is normal",
      blocks: [
        {
          kind: "p",
          text: "If you are expecting a rental agreement with clauses and signatures, adjust the expectation now. A large share of scooter rentals in Southeast Asia involve no paperwork at all: a chat conversation, cash across a counter, a key. This is not a red flag. It is how small family businesses in the region operate, and plenty of shops that have rented happily to thousands of travellers have never printed a contract in their lives.",
        },
        {
          kind: "p",
          text: "What matters is not the format but whether the key terms exist in writing anywhere - and for this purpose, a chat message counts completely. The point is not legal enforceability, which you were never realistically going to litigate over a scooter. The point is that memories genuinely differ by the end of a week, on both sides, and a timestamped message settles the difference before it becomes an argument.",
        },
      ],
    },
    {
      heading: "The six terms that need to be in writing",
      blocks: [
        {
          kind: "list",
          items: [
            "The exact bike: model and, ideally, plate number - so the bike you photographed is provably the bike you agreed on.",
            "The price: per day or total, and whether it includes helmets and delivery, so nothing gets added at handover.",
            "The dates: pickup and return, including roughly what time on the last day counts as returned.",
            "The fuel policy: normally, return it at the same level you received it.",
            "The deposit: the amount, and that it is returned at handover if the bike is in the same condition.",
            "The awkward stuff: what a late return costs, and who pays for punctures and breakdowns.",
          ],
        },
        {
          kind: "p",
          text: "Notice that none of these require the shop to do anything. If they never offer any of it, you can put every item in writing yourself in one message, and the shop only has to not object. Silence plus a thumbs-up emoji is a perfectly good record.",
        },
        {
          kind: "callout",
          text: "One message covers all of it: \"Just confirming - Honda Click, 200 THB a day for 5 days, pickup today, return Friday around midday. 3,000 THB deposit back at return, same fuel level as I get it, and I pay for punctures. All good?\" Thirty seconds to type, and it converts six future arguments into one present-tense agreement.",
        },
      ],
    },
    {
      heading: "Fuel, late returns and flat tyres - the terms nobody states",
      blocks: [
        {
          kind: "p",
          text: "Fuel is the small one that sours the most returns. Scooters are commonly handed over with very little in the tank, and \"bring it back at the same level\" is the fair and usual arrangement. What you want to avoid agreeing to by silence is returning a full tank on a bike you received near-empty - that turns the last day of your trip into an unplanned gift to the next customer.",
        },
        {
          kind: "p",
          text: "Late returns are mostly a problem of nobody having defined \"late\". A shop that charges a part-day rate, or shrugs at an hour, is behaving normally. Being billed a full extra day over minutes is the version worth pre-empting, and one line in the confirmation message - \"return Friday around midday\" - usually pre-empts it.",
        },
        {
          kind: "p",
          text: "Punctures are on you almost everywhere, and reasonably so: they are a road hazard, not a defect, and a roadside repair in the region is small and routine. Mechanical breakdowns are different. A clutch, an electrical fault or an engine problem on a bike you have ridden gently is the shop's machine failing, and the fair outcomes are a swap or the unused days refunded. It is worth asking one question before you ride off: \"if it breaks down somewhere, what happens?\" The answer tells you a lot about the shop even if you never need it.",
        },
      ],
    },
    {
      heading: "If there IS a contract, read it for three things",
      blocks: [
        {
          kind: "p",
          text: "Some shops, especially larger ones, will hand you a photocopied page, sometimes only in the local language. Signing it is normally fine - but scan it, or photograph it and machine-translate it, for three things: a fixed schedule of damage fees, your liability if the bike is stolen, and any deposit terms that contradict what was said out loud. Where the paper and the conversation disagree, ask about it before signing rather than after. Your confirmation message is your version of the deal; make sure the paper is not quietly a different one.",
        },
        {
          kind: "table",
          headers: ["Term", "Fair and common", "Push back if"],
          rows: [
            [
              "Fuel",
              "Return at the same level you received",
              "Full tank demanded on a bike handed over near-empty",
            ],
            [
              "Late return",
              "Part-day charge or an informal grace period",
              "A full extra day charged over minutes",
            ],
            [
              "Punctures",
              "Renter pays - small and routine",
              "Engine or mechanical faults blamed on your riding",
            ],
            [
              "Deposit",
              "Returned at handover, same condition",
              "\"We will check the bike later and transfer it\"",
            ],
            [
              "Damage fees",
              "Priced like the actual repair",
              "A fixed fee list wildly above what parts cost",
            ],
          ],
        },
      ],
    },
    {
      heading: "The paperwork that beats all other paperwork",
      blocks: [
        {
          kind: "p",
          text: "Whatever is or is not written down, the strongest document you will hold is the set of photos and the slow walk-around video you take at pickup, in front of the staff, before you ride away. Terms describe what should happen; photos prove what the bike was. The scam patterns worth knowing are almost all defeated by that footage, and no contract clause substitutes for it.",
        },
        {
          kind: "p",
          text: "Taken together, this is perhaps five minutes of admin on a rental that will carry you around for a week. None of it signals distrust - shops deal with confirmation messages and photographing customers every day, and the good ones like it, because clear terms protect the party that was always going to be honest. That is both of you, most of the time.",
        },
      ],
    },
  ],
  faq: [
    {
      q: "Is a WhatsApp message really enough instead of a contract?",
      a: "For a scooter rental, yes, practically speaking. You were never going to sue over a scooter in a foreign small-claims court - the value of writing is that it fixes both sides' memory of the deal, and a timestamped chat message does that as well as paper.",
    },
    {
      q: "What if the shop will not put anything in writing?",
      a: "Send the summary message yourself and let them not object - silence or a thumbs-up is a working record. A shop that actively refuses to even acknowledge the bike, price and dates in a chat is rare, and rare in an informative way.",
    },
    {
      q: "Who pays if I get a flat tyre?",
      a: "Normally you do. A puncture is a road hazard rather than a defect, and fixing one locally is small and routine. Genuine mechanical failures are the shop's problem, and the fair remedy is a replacement bike or a refund of the unused days.",
    },
  ],
};

export default guide;
