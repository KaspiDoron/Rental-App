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

// OWNER REPORT 3, ITEM 10: "a lot of places around the app stayed in
// English". The drift scan below is the generalised answer - a JSX-text
// literal scan over the high-traffic user components, so a new bare English
// sentence in any of them fails CI instead of shipping to a Hebrew phone.
describe("no scanned user surface ships bare English JSX text", () => {
  const SCAN = [
    "src/components/Onboarding.tsx",
    "src/components/AlertsToggle.tsx",
    "src/components/FeedbackModal.tsx",
    "src/components/WaitGame.tsx",
    "src/components/QuotesRail.tsx",
    "src/components/ReviewsSheet.tsx",
    "src/components/BatchProgressBar.tsx",
    "src/components/TermsModal.tsx",
    "src/components/Tracker.tsx",
    "src/components/PhotoGallery.tsx",
    "src/components/MassBargainPreview.tsx",
    "src/components/HorizontalVendorRail.tsx",
    // Owner report 4, item 2: "the whole app". The four highest-traffic
    // surfaces that were never in the scan - which is exactly where the
    // untranslated FAQ chips and "Full conversation" hid.
    "src/components/PlaceAutocomplete.tsx",
    "src/components/FaqSection.tsx",
    "src/components/OfflineBanner.tsx",
    "src/components/AdBanner.tsx",
  ];
  // Strings that are legitimately language-neutral: brand names, punctuation
  // around expressions, game branding rendered as a logo.
  const ALLOW = new Set(["🛵 Scooter Dash", "(step", "OK"]);

  it.each(SCAN)("%s has no unwrapped English text nodes", (p) => {
    const src = read(p)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const bare: string[] = [];
    for (const m of src.matchAll(/>([^<>{}\n]*[A-Za-z]{3}[^<>{}\n]*)</g)) {
      const text = m[1].trim();
      if (text && !ALLOW.has(text)) bare.push(text);
    }
    expect(bare, `bare literals in ${p}: ${bare.join(" | ")}`).toEqual([]);
  });

  // The text-node regex above is blind to ATTRIBUTE copy - placeholder=,
  // title=, aria-label= carried whole English sentences (the search box's
  // own placeholder among them) through every language.
  it.each(SCAN)("%s has no bare English string ATTRIBUTES", (p) => {
    const src = read(p)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const bare: string[] = [];
    for (const m of src.matchAll(/(placeholder|title|aria-label)="([^"]*[A-Za-z]{3}[^"]*)"/g)) {
      const text = m[2].trim();
      if (text && !ALLOW.has(text)) bare.push(`${m[1]}="${text}"`);
    }
    expect(bare, `bare attribute literals in ${p}: ${bare.join(" | ")}`).toEqual([]);
  });
});

describe("the stage vocabulary reaches every surface translated (3.2)", () => {
  it("StageBadge renders through t() and its texts are catalogued", () => {
    const tracker = read("src/components/Tracker.tsx");
    expect(tracker).toMatch(/\{t\(s\.text\)\}/);
    for (const s of ["Awaiting reply", "Out of stock", "Counter sent", "Offer in"]) {
      expect(I18N_CATALOG, s).toContain(s);
    }
  });

  it("every stageCaption render site wraps with t()", () => {
    for (const p of [
      "src/components/VendorCard.tsx",
      "src/components/MapView.tsx",
      "src/components/ThreadDashboard.tsx",
    ]) {
      const src = read(p);
      // Every .text render goes through t(...) - a bare interpolation of the
      // caption is the exact regression this pins against.
      expect(src, p).not.toMatch(/\{stageCaption\([^)]*\)\.text\}/);
    }
    expect(I18N_CATALOG).toContain("Your agent is haggling with the shop for a lower price.");
  });
});

describe("RTL structural fixes hold (3.2)", () => {
  it("the Google wordmark is an LTR island - never elgooG again", () => {
    const wm = read("src/components/GoogleWordmark.tsx");
    expect(wm).toMatch(/dir="ltr"/);
    expect(wm).toMatch(/ltr-island/);
  });

  it("the search summary uses ONE truncation mechanism and isolates free text", () => {
    const bar = read("src/components/SearchSummaryBar.tsx");
    expect(bar).not.toMatch(/slice\(0, 48\)/);
    expect(bar).toMatch(/<bdi dir="auto">\{req\}<\/bdi>/);
    expect(bar).toMatch(/<bdi dir="auto">\{originLabel\}<\/bdi>/);
  });

  it("Places speaks the traveller's language, and the cache knows it", () => {
    const g = read("src/lib/google.ts");
    expect(g).toMatch(/languageCode: langCode/);
    // The lang is part of the discovery cache key - without it a Hebrew
    // search poisons the next English one for 10 minutes (and vice versa).
    expect(g).toMatch(/\$\{vehicleClass\},\$\{langCode \?\? "en"\}/);
    expect(read("src/app/api/vendors/route.ts")).toMatch(/findRealVendors\(body\.origin, radius, vClass, body\.lang\)/);
  });

  it("Hebrew glyphs get the premium faces, after the Latin ones", () => {
    const layout = read("src/app/layout.tsx");
    expect(layout).toMatch(/Rubik\(\{/);
    expect(layout).toMatch(/Secular_One\(\{/);
    expect(layout).toMatch(/subsets: \["hebrew", "latin"/);
    const css = read("src/app/globals.css");
    expect(css).toMatch(/var\(--wd-font-body\), "Nunito", var\(--wd-font-body-he\)/);
    expect(css).toMatch(/var\(--wd-font-display\), "Baloo 2", var\(--wd-font-display-he\)/);
    expect(css).toMatch(/font-synthesis-weight: none/);
  });

  it("every translated script has its 3-face trio, Latin-first (owner report 4)", () => {
    const layout = read("src/app/layout.tsx");
    const css = read("src/app/globals.css");
    // The accent role exists app-wide and is tabular by construction - an
    // animated price must not wobble as its digits change.
    expect(layout).toMatch(/Space_Grotesk\(\{/);
    expect(css).toMatch(/--font-accent: var\(--wd-font-accent\), "Space Grotesk"/);
    expect(css).toMatch(/\.font-accent \{\n  font-family: var\(--font-accent\);\n  font-variant-numeric: tabular-nums;/);
    // Per-script faces, each AFTER the Latin families in its ladder so Latin
    // stays pixel-identical (per-character fallback is the whole mechanism).
    for (const [face, ladder] of [
      ['"IBM Plex Sans Arabic"', "--font-body"],
      ['"Mukta"', "--font-body"],
      ['"Sarabun"', "--font-body"],
      ['"Baloo Bhaijaan 2"', "--font-display"],
      ['"Comfortaa"', "--font-display"],
      ['"Mitr"', "--font-display"],
      ['"Heebo"', "--font-accent"],
      ['"Cairo"', "--font-accent"],
      ['"Hind"', "--font-accent"],
      ['"IBM Plex Sans Thai"', "--font-accent"],
    ] as const) {
      const start = css.indexOf(`${ladder}:`);
      const slice = css.slice(start, css.indexOf(";", start));
      expect(slice, `${face} must ride the ${ladder} ladder`).toContain(face);
      expect(
        slice.indexOf(face),
        `${face} must come AFTER the Latin lead of ${ladder}`
      ).toBeGreaterThan(slice.indexOf(","));
    }
    // Subsets that were silently falling to system faces: Polish/Turkish
    // (latin-ext), Vietnamese, Cyrillic prose, Hindi display.
    expect(layout).toMatch(/"latin", "latin-ext", "cyrillic", "cyrillic-ext", "vietnamese"/);
    expect(layout).toMatch(/"latin", "latin-ext", "vietnamese", "devanagari"/);
    // CJK deliberately ships ZERO webfont bytes - native system stacks only.
    expect(css.match(/"PingFang SC", "Hiragino Sans", "Noto Sans CJK SC"/g)?.length).toBe(2);
    expect(layout).not.toMatch(/Noto_Sans_SC|Noto_Sans_JP|Noto_Sans_KR/);
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
