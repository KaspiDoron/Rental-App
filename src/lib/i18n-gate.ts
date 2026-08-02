// WHAT IS ALLOWED TO LEAVE THE DEVICE.
//
// This module owns the decision that closes the second cross-user leak, and it
// is deliberately separate from i18n.tsx: that file is a "use client" React
// module, so nothing in a plain test can execute it. The rule that matters here
// is not UI, it is a data-egress rule, and it has to be testable on its own.
//
// THE LEAK. A string handed to t() was added to `pending`, POSTed to
// /api/translate, and cached into `app_config` key `I18N_<lang>` - ONE ROW,
// served to every user of that language. t() is called with runtime values in
// 22 places (`t(offer.vehicleNote)`, `t(chip.text)`, `t(queueItem.reason)`), so
// shop names, WhatsApp transcript fragments and per-user reasons carrying the
// traveller's own trust score were uploaded into a shared dictionary.
//
// THE RULE. The catalogue is the closed set of app copy: every literal
// `t("...")` in src, plus the computed copy declared in i18n-extras.ts. If a
// string is not in it, it is not ours to upload. It still renders - unchanged,
// in English - it simply never travels.
//
// This also bounds the dictionary. Unbounded input is what made `app_config`
// grow without limit, which is the same defect that made every cold start
// download the entire translation corpus before it could read one vault key.

import { I18N_CATALOG } from "./i18n-catalog";

const CATALOG = new Set<string>(I18N_CATALOG);

/** Strings seen by t() that still need a translation (swept in batches). */
export const pending = new Set<string>();

/**
 * Strings the server has already declined to translate. WITHOUT THIS SET the
 * sweep is a loop: t() re-adds every untranslated string on the next render,
 * the sweep asks again 1.5s later, and nothing ever changes the answer.
 */
export const failed = new Set<string>();

/** Is this string app copy - i.e. may it be sent to the translator at all? */
export function translatable(s: string): boolean {
  return CATALOG.has(s);
}

/** The full catalogue, for the up-front sweep on a language switch. */
export function catalogue(): string[] {
  return [...CATALOG];
}

/**
 * Queue a string for the next translation sweep. Returns whether it was
 * queued - false means it is not app copy and must never be uploaded.
 *
 * This is the ONLY way a string enters `pending`, so the payload of every
 * /api/translate request is exactly what this function admitted.
 */
export function queueForTranslation(s: string): boolean {
  if (!translatable(s)) return false;
  if (failed.has(s)) return false;
  pending.add(s);
  return true;
}

/**
 * Queue owner-authored GLOBAL text that is not in the catalogue - today only
 * the FAQ from /api/faq, which is written by the operator and identical for
 * every traveller, so caching it in the shared row is correct by construction.
 *
 * NEVER call this with a shop name, a message, a price, a search query or
 * anything else derived from one user's session.
 */
export function queueSharedText(s: string): boolean {
  if (!s || failed.has(s)) return false;
  pending.add(s);
  return true;
}
