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

  // src/components/landing/TrustPanel.tsx - MECHANICS, rendered as t(m)
  "A trust score per number: sending capacity grows slowly as your number proves healthy - brand-new numbers are warmed up gently.",
  "Human pacing: randomised gaps between messages, typing indicators, and a hard hourly + daily send budget.",
  "Business-hours queueing: shops are messaged when they are open, never at 3am.",
  "Every message is uniquely worded - no two shops ever receive the same text.",
  "Automatic safety pause: at the first sign of risk (failed sends, low reply rates) all sending stops on its own.",
  "One conversation per shop per day - your agents never spam a thread.",

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
