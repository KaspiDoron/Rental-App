import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { I18N_CATALOG } from "./i18n-catalog";

vi.mock("server-only", () => ({}));

// THE TRUST PANEL SHIPPED IN ENGLISH TO NINETEEN LANGUAGES, AND WE PAID TO
// TRANSLATE SIX SENTENCES NOBODY RENDERS.
//
// TrustPanel's mechanics were RETRACTED and rewritten - its own header explains
// why at length: an affirmative misstatement of present fact, on the screen that
// induces someone to link their personal WhatsApp number, is not cured by a
// disclaimer elsewhere. The list was narrowed to what the code actually does.
//
// `i18n-extras.ts` was never updated. It is not decoration: `t()` refuses to
// queue anything outside the catalogue, so a string missing from it is not
// translated AT ALL. The result was the worst of both:
//
//   - the six retracted claims stayed in the catalogue, costing translation
//     budget on every language switch for copy nothing renders;
//   - the five live mechanics AND the "what we cannot promise" line were absent,
//     so a traveller reading in Thai or Hebrew got a wall of untranslated
//     English at exactly the moment they were deciding whether to trust us with
//     their number.
//
// These tests read the component's own arrays and require the catalogue to
// match. Editing the copy without editing the extras now fails here.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** Pull the string literals out of a `const NAME = [ ... ]` array. */
function arrayLiterals(src: string, name: string): string[] {
  const start = src.indexOf(`const ${name} = [`);
  if (start === -1) return [];
  const end = src.indexOf("];", start);
  return (src.slice(start, end).match(/"(?:[^"\\]|\\.)*"/g) ?? []).map(
    (s) => JSON.parse(s) as string
  );
}

const trust = read("src/components/landing/TrustPanel.tsx");

describe("every word on the trust panel is translatable", () => {
  const mechanics = arrayLiterals(trust, "MECHANICS");

  it("the component still has a mechanics list to check", () => {
    // Guards the extractor itself: a silently-empty list would make every
    // assertion below vacuously true, which is the failure mode this whole
    // file exists to prevent.
    expect(mechanics.length).toBeGreaterThanOrEqual(4);
  });

  it.each(arrayLiterals(trust, "MECHANICS"))("catalogued: %s", (m) => {
    expect(I18N_CATALOG).toContain(m);
  });

  it("and the line we do NOT control is catalogued too", () => {
    // The one thing on this panel that is not a reassurance. If it renders in
    // English while the reassurances render translated, the panel reads as an
    // unqualified promise - the precise outcome its header forbids.
    const m = /const CANNOT_PROMISE =\s*\n?\s*("(?:[^"\\]|\\.)*")/.exec(trust);
    expect(m, "CANNOT_PROMISE not found - did it move?").toBeTruthy();
    expect(I18N_CATALOG).toContain(JSON.parse(m![1]) as string);
  });

  it("REGRESSION: the retracted claims are gone from the catalogue", () => {
    // Paying to translate copy nothing renders is the cheap half of the bug.
    // Leaving them also means the next reader cannot tell which list is live.
    for (const retracted of [
      "A trust score per number: sending capacity grows slowly as your number proves healthy - brand-new numbers are warmed up gently.",
      "Business-hours queueing: shops are messaged when they are open, never at 3am.",
      "Automatic safety pause: at the first sign of risk (failed sends, low reply rates) all sending stops on its own.",
      "One conversation per shop per day - your agents never spam a thread.",
    ]) {
      expect(I18N_CATALOG, retracted.slice(0, 40)).not.toContain(retracted);
    }
  });
});

describe("the sort/filter rail is translated", () => {
  const filters = read("src/components/Filters.tsx");

  it("REGRESSION: the component imports the hook it never had", () => {
    expect(filters).toMatch(/import \{ useI18n \} from "@\/lib\/i18n"/);
    expect(filters).toMatch(/const \{ t \} = useI18n\(\);/);
  });

  it("every chip label goes through t()", () => {
    for (const label of [
      "Closest",
      "Top rated",
      "Most reviews",
      "Biggest savings",
      "Active first",
      "All vehicles",
      "Active rentals",
      "Open now",
      "Negotiating now",
      "Dropped price",
      "Has offer",
      "Fast responders",
    ]) {
      expect(filters, label).toMatch(new RegExp(`t\\("${label}"\\)`));
      expect(I18N_CATALOG, `${label} must be catalogued`).toContain(label);
    }
  });

  it("the computed labels are declared, since no grep can find them", () => {
    // t(vehicleLabelPlural(v)) and t(label) reach t() through a variable, so
    // the generator sees nothing. i18n-extras is the only way they translate.
    for (const s of [
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
    ]) {
      expect(I18N_CATALOG, s).toContain(s);
    }
  });

  it("the count sentence is translated WHOLE, not concatenated", () => {
    // Concatenating a number onto a translated fragment puts it on the wrong
    // side in RTL - the same rule the warm-up templates already follow.
    expect(filters).toMatch(/t\("shop confirmed this"\)/);
    expect(filters).toMatch(/t\("shops confirmed this"\)/);
  });
});

describe("the extras file stays the mechanism it claims to be", () => {
  it("it still exists - the generator degrades silently without it", () => {
    // It was deleted once by a dead-code sweep (nothing imports it; the
    // generator only READS it), and the catalogue could not be regenerated
    // until someone noticed.
    const extras = read("src/lib/i18n-extras.ts");
    expect(extras).toMatch(/export const I18N_EXTRAS: string\[\] = \[/);
  });

  it("and the generator still reads it", () => {
    expect(read("scripts/gen-i18n-catalog.js")).toMatch(/i18n-extras\.ts/);
  });
});
