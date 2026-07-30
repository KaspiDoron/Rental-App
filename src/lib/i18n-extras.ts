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
];
