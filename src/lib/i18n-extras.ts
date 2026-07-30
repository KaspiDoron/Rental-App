// COPY THE SCANNER CANNOT SEE.
//
// `scripts/gen-i18n-catalog.js` collects every literal `t("...")` in src/, and
// that covers almost everything - but some user-facing sentences are CHOSEN in
// a helper and only then handed to `t()`:
//
//     {t(transportMessage(r))}      {t(readingEmptyLine(reading))}
//
// The scanner sees `t(<expression>)` and has nothing to collect, so those lines
// fell out of the pre-translation batch and rendered in English on a Thai or
// Hebrew device. They were never wrong, just untranslated - which is the
// quietest kind of gap and the easiest to keep re-opening.
//
// Declaring them here keeps the helper as the single source of the WORDING
// while giving the catalogue something to find. Add a string whenever you add a
// computed line of copy, and re-run `node scripts/gen-i18n-catalog.js`.
export const I18N_EXTRAS: string[] = [
  // lib/client/fetch-json.ts - the copy it picks for a failed request, which
  // the shop card renders straight into its banner via `t(r.error)`.
  "This is taking longer than usual - please try again.",
  "Network error - please try again.",
  "Too many attempts - please wait a moment.",
  "The server had a problem - please try again.",
  "Something went wrong.",
  // lib/http/json-route.ts - the two bodies a wrapped route can answer with.
  "Something broke on our side, not yours - nothing was lost. Try again in a moment.",
  // lib/media/reading.ts - readingEmptyLine() and readingHeadline()
  "Nothing to show for this one.",
  "We could not read anything usable from this one.",
  "Could not read this one yet",
  "Nothing readable in this one",
  // lib/queue-reason.ts - queueReasonLabel() picks these; the panel renders
  // them via t(q.reason).
  "Protecting your WhatsApp number - new-shop messages resume automatically in a few hours",
  // app/page.tsx etaRangeLabel() - the far-out-hold wording.
  "sends in about",
  "h",
  // app/page.tsx mass-result loop - refusal accounting.
  "not sent",
  "still marked removed - tap the shop to try again",
  // lib/wa/safety-signals.ts - health verdict + drop-feed copy, rendered via
  // t(safety.publicReason) and t(it.title)/t(it.detail) in the feed.
  "WhatsApp is disconnected, so shop replies cannot reach the app - reconnect in Profile to keep your conversations moving.",
  "Some messages needed attention in the last day - check the activity feed to see what happened to each one.",
  "A shop reply needs attention",
  "A message was not sent",
  "A message arrived from a number your agent never contacted, so it was not linked to any shop.",
  "A reply arrived from a hidden WhatsApp identity and couldn't be matched to a shop yet.",
  "The shop sent a photo or voice note that couldn't be downloaded.",
  "A reply was saved but couldn't be linked to a shop card.",
  "A reply couldn't be checked on the first try - it is retried automatically.",
  "A reply couldn't be saved on the first try - it is retried automatically.",
  "A recovered reply couldn't be answered on the first try - it is retried automatically.",
  "Checking this shop's thread failed once - it is retried automatically.",
  "A reply couldn't be processed automatically.",
  "A duplicate of a message this shop already received was skipped.",
  "This shop already got your request in the last day, so a repeat was skipped.",
  "This shop hasn't answered earlier messages, so a repeat wasn't sent - this protects your WhatsApp number.",
  "A message was skipped by the safety guard.",
];
