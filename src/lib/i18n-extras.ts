// DECLARED UI COPY THAT NO GREP CAN FIND.
//
// scripts/gen-i18n-catalog.js builds the catalogue from literal `t("...")`
// calls. Some user-facing sentences never appear as a literal argument: they
// live in a constant table and reach `t()` through a variable -
// `t(badge.what)`, `t(m)`, `t(q)`. The grep sees `t(m)` and finds nothing, so
// those lines shipped untranslated.
//
// This file is where they are declared. It is not decoration: since `t()` now
// refuses to queue anything outside the catalogue (a string handed to `t()` is
// POSTed to /api/translate and cached into a GLOBALLY SHARED row, so an
// unbounded input is a cross-user leak), a string that is not in the catalogue
// is not translated at all. Adding computed copy here is the ONLY way it gets
// translated.
//
// The generator picks up every two-space-indented quoted line below, so keep
// the plain array shape. Run `node scripts/gen-i18n-catalog.js` after editing.
export const I18N_EXTRAS: string[] = [
  // src/lib/queue-reason.ts - queueReasonWhy(). Rendered as
  // t(queueReasonWhy(...)), so there is no literal for the grep to find. These
  // explain WHY a first message waits, which matters more since cold intros
  // stopped going out overnight: without the reason, a shop sitting untouched
  // until morning reads as a broken app.
  "This shop is closed right now. A first message sent at 3am is still read at 9am - it only makes your number look automated, which is what gets WhatsApp numbers restricted. Shops already talking to you are answered immediately, day or night.",
  "You have used today's batch of NEW shops. Conversations already open keep running normally - only first messages wait.",
  "Your plan opens new shops in batches, so your number stays under WhatsApp's radar. Shops already replying are unaffected.",
  "WhatsApp pushed back on this number, so first messages pause while it settles. Replies to shops that wrote to you still go out.",
  // src/components/UpgradeSheet.tsx - the warm-up gate. The progress line is
  // rendered as t(warm.progress.template) and the checklist as t(x.label), so
  // neither is a literal the grep can see. The {n} templates are translated
  // WHOLE and substituted afterwards - concatenating a count onto a translated
  // fragment puts the number on the wrong side in RTL.
  "Connect WhatsApp to get started.",
  "One search away.",
  "{n} searches away.",
  "One more shop away.",
  "{n} more shops away.",
  "One shop reply away.",
  "{n} shop replies away.",
  "WhatsApp connected",
  "Searches run",
  "Shops reached",
  "Shops that replied",
  "We want you to get the most out of Premium, so unlock it by using the app a little more first.",

  // src/components/landing/TrustPanel.tsx - MECHANICS + CANNOT_PROMISE,
  // rendered as t(m) and t(CANNOT_PROMISE).
  //
  // THESE HAD DRIFTED, AND THE DRIFT WAS THE WORST POSSIBLE KIND. The six
  // strings that used to sit here were RETRACTED from the component - the
  // panel's own header explains why, at length: an affirmative misstatement of
  // present fact on the screen that induces someone to link their personal
  // number is not cured by a disclaimer elsewhere. They were rewritten to
  // describe only what the code actually does.
  //
  // But this file was never updated. So the app was paying, on every language
  // switch, to translate six sentences NOTHING renders - while the five that
  // ARE rendered, and the one line that says what we cannot promise, were
  // absent from the catalogue and therefore shipped in English to all nineteen
  // other languages. A traveller reading in Thai or Hebrew got an untranslated
  // wall of English at exactly the moment they were deciding whether to trust
  // us with their WhatsApp number.
  //
  // If MECHANICS or CANNOT_PROMISE changes again, change it here in the same
  // commit. There is a test asserting the two stay in step.
  "Human pacing: randomised gaps between messages, a per-shop send lock, and a hard hourly and daily budget.",
  "Business-hours awareness: we know each shop's local hours and message the open ones first. A closed shop still gets your message - it simply waits unread until they open.",
  "Every message is uniquely worded - no two shops receive the same text, and your dates are always included so a shop can actually answer.",
  "One introduction per shop. After that your agent only writes again once the shop has actually written back.",
  "If WhatsApp pushes back on a new conversation, your agent stops opening new ones and keeps answering the shops already talking to you.",
  "What we cannot promise: WhatsApp decides what happens to your number. Messaging many new shops who never reply is what gets personal numbers restricted, and no amount of pacing rules that out. Link a number you could manage without.",

  // src/components/Filters.tsx - the sort/filter rail. The vehicle-class chips
  // render t(vehicleLabelPlural(v)) and the verified-terms chips render
  // t(label) from a table, so neither is a literal the grep can see.
  "Automatic scooters",
  "Manual motorcycles",
  "Cars",
  "Rents cars",
  "Delivers",
  "No deposit",
  "Passport deposit",
  "Cash deposit",
  "Helmets",
  "Insurance",

  // src/components/will/WillSheet.tsx - QUICK chips, rendered as t(q)
  "What can you do?",
  "What's happening right now?",
  "Compare the top 3",
  "Why is this the best option?",
  "Try negotiating harder",
  "Open my trips",
  "Pause this search",

  // src/lib/offer-badges.ts - OFFER_BADGES, rendered as t(badge.label/what/next)
  "VERIFIED",
  "SHOP QUOTE",
  "UNVERIFIED",
  "DIFFERENT VEHICLE",
  "The shop confirmed IN WRITING that this price is for the exact vehicle you asked for. This is the strongest state an offer reaches, and it is safe to lock.",
  "A real price a real shop gave us for your request. It has not been double-confirmed against the exact model yet - which is normal, not a warning.",
  "Nothing to do. Lock it if you like it, or let the agent keep pushing.",
  "The price is real and lockable. Your agent is asking the shop to confirm exactly which model it covers, and this badge flips to VERIFIED on its own when it answers.",
  "Nothing to do - it resolves itself, usually within a few minutes.",
  "This price is for a DIFFERENT vehicle than the one you asked for - a smaller engine, an automatic instead of a manual, or another class entirely. It is not counted as your best deal.",
  "Your agent is asking the shop about the vehicle you wanted. If you would take this one instead, say so and it becomes the target.",

  // src/components/RequestBuilder.tsx - the review chips capitalise the chosen
  // vehicle and echo the gearbox/body words back, none of them as literals.
  "Scooter",
  "Motorbike",
  "Car",
  "automatic",
  "manual",

  // src/components/AgenticSummary.tsx - t(reading.confidence)
  "high",
  "medium",
  "low",
];
