import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  validateTranslation,
  placeholders,
  DO_NOT_TRANSLATE,
  MAX_RATIO,
  roleOf,
  translationBrief,
  LABEL_MAX_CHARS,
  protectBrands,
  restoreBrands,
} from "./i18n-validate";

vi.mock("server-only", () => ({}));

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// A WRONG TRANSLATION IS WORSE THAN AN UNTRANSLATED ONE.
//
// The wrong one is invisible until a user complains and unfixable while it sits
// in the durable shared cache. Every rule here rejects a bad candidate so the
// English source stays visible for that one string.

describe("the null bug, at the root", () => {
  it("a non-string is rejected before String() can coerce it", () => {
    // parsed.t.map(String) turned a JSON null into the literal "null" and cached
    // it as a button label.
    expect(validateTranslation("Next", null).ok).toBe(false);
    expect(validateTranslation("Next", undefined).ok).toBe(false);
    expect(validateTranslation("Next", 42).ok).toBe(false);
    expect(validateTranslation("Next", null).reason).toBe("not-a-string");
  });

  it("the literal words null/undefined are rejected too", () => {
    expect(validateTranslation("Next", "null").ok).toBe(false);
    expect(validateTranslation("Next", "undefined").ok).toBe(false);
  });

  it("an empty or whitespace candidate is rejected", () => {
    expect(validateTranslation("Next", "").ok).toBe(false);
    expect(validateTranslation("Next", "   ").ok).toBe(false);
  });
});

describe("placeholders must survive exactly", () => {
  it("extracts the token multiset", () => {
    expect(placeholders("{n} of {total} shops")).toEqual(["{n}", "{total}"]);
    expect(placeholders("no tokens")).toEqual([]);
  });

  it("a dropped placeholder is rejected", () => {
    // "you have {n} shops left" -> "il te reste des boutiques" cannot be filled
    // by a first-occurrence String.replace and renders "you have  shops left".
    expect(validateTranslation("You have {n} shops left", "Il te reste des boutiques").ok).toBe(false);
    expect(validateTranslation("You have {n} shops left", "Il te reste des boutiques").reason).toBe(
      "placeholder-drift"
    );
  });

  it("a preserved placeholder passes", () => {
    expect(validateTranslation("You have {n} shops", "Tu as {n} boutiques").ok).toBe(true);
  });

  it("a renamed placeholder is rejected", () => {
    expect(validateTranslation("{shop} replied", "{boutique} a répondu").ok).toBe(false);
  });
});

describe("brand words survive - Will above all", () => {
  it("Will must stay verbatim", () => {
    // The load-bearing case: the assistant's name is also an English auxiliary.
    expect(validateTranslation("Will is on it", "Will s'en occupe").ok).toBe(true);
    expect(validateTranslation("Will is on it", "Il s'en occupe").ok).toBe(false);
    expect(validateTranslation("Will is on it", "Il s'en occupe").reason).toBe("brand-lost");
  });

  it("the other brand words are enforced", () => {
    expect(validateTranslation("Connect WhatsApp", "Conecta Google").ok).toBe(false);
    expect(validateTranslation("Upgrade to Ultra", "Passe à Suprême").ok).toBe(false);
  });

  it("Will is actually in the do-not-translate list", () => {
    expect(DO_NOT_TRANSLATE).toContain("Will");
  });

  it("a brand word as a substring does not trigger a false positive", () => {
    // "Pro" inside "Product" is not the brand word, so a source without the
    // standalone brand word imposes no constraint.
    expect(validateTranslation("Product details", "Détails du produit").ok).toBe(true);
  });
});

describe("coarse length sanity catches refusals, not register", () => {
  it("a model that returned an explanation is rejected", () => {
    const src = "Back";
    const rambling = "In this context the most appropriate translation would be ".repeat(3);
    expect(validateTranslation(src, rambling).ok).toBe(false);
    expect(validateTranslation(src, rambling).reason).toBe("too-long");
  });

  it("legitimate expansion within the bound passes", () => {
    // German expands; 'Search' -> 'Durchsuchen' is fine.
    expect(validateTranslation("Search", "Durchsuchen").ok).toBe(true);
  });

  it("a short source is not held to the shrink floor", () => {
    // "OK" -> a single CJK char must not be rejected as too short.
    expect(validateTranslation("OK", "好").ok).toBe(true);
  });

  it("MAX_RATIO is generous enough for real expansion", () => {
    expect(MAX_RATIO).toBeGreaterThanOrEqual(3);
  });
});

// M23: THE MODEL WAS HANDED A BARE ARRAY OF UNRELATED STRINGS.
//
// ["Next","Back","Light","Dark","Bargain", ...] - fourteen items with no
// indication of part of speech, register or length budget, so the localiser had
// to guess all three per item. "Bargain" is a verb on a button and a noun in a
// sentence, and a context-free model picks whichever is more common in its own
// language. The role is derived from the string's own shape, so no caller
// changes and nothing can fall out of sync.

describe("copy role is derived from the string itself", () => {
  it("a short fragment with no terminal punctuation is a control label", () => {
    for (const s of ["Next", "Back", "Bargain", "Edit", "Find my deal"]) {
      expect(roleOf(s)).toBe("label");
    }
  });

  it("terminal punctuation makes it prose regardless of length", () => {
    expect(roleOf("Done.")).toBe("sentence");
    expect(roleOf("Ready?")).toBe("sentence");
    expect(roleOf("Wait!")).toBe("sentence");
  });

  it("a long fragment is prose even without punctuation", () => {
    const long = "x".repeat(LABEL_MAX_CHARS + 1);
    expect(roleOf(long)).toBe("sentence");
  });

  it("it is TOTAL - an empty or whitespace string still resolves", () => {
    expect(roleOf("")).toBe("label");
    expect(roleOf("   ")).toBe("label");
  });

  it("the brief carries text, role and an advisory budget", () => {
    const b = translationBrief("Next");
    expect(b.text).toBe("Next");
    expect(b.role).toBe("label");
    // Advisory only - MAX_RATIO in validateTranslation is the ENFORCED bound.
    // Telling the model up front produces shorter buttons than rejecting after.
    expect(b.maxChars).toBeGreaterThanOrEqual(LABEL_MAX_CHARS);
  });

  it("prose gets the real ceiling the validator will apply anyway", () => {
    const src = "Your first real quotes within the hour.";
    expect(translationBrief(src).maxChars).toBe(src.length * MAX_RATIO);
  });
});

describe("brand tokens round-trip", () => {
  it("every DNT word becomes its own token and comes back exactly", () => {
    const src = "Ask Will to compare WheelDeal Pro with PayPal checkout";
    const prot = protectBrands(src);
    expect(prot).not.toMatch(/WheelDeal|PayPal|\bWill\b|\bPro\b/);
    expect(prot).toMatch(/\{brand\d+\}/);
    expect(restoreBrands(prot)).toBe(src);
  });

  it("word boundaries hold - Pro never tokenises inside Product", () => {
    expect(protectBrands("Products from professionals")).toBe("Products from professionals");
  });

  it("a translation that keeps the tokens passes the placeholder check", () => {
    const prot = protectBrands("Upgrade to Pro today!");
    // A pretend Hebrew translation keeping the token verbatim:
    const cand = prot.replace("Upgrade to", "שדרגו אל").replace("today!", "היום!");
    expect(validateTranslation(prot, cand).ok).toBe(true);
  });

  it("a translation that translates the token away is placeholder-drift", () => {
    const prot = protectBrands("Upgrade to Pro today!");
    expect(validateTranslation(prot, "שדרגו אל פרו היום!").reason).toBe("placeholder-drift");
  });
});

describe("the route uses the validator, not String() coercion", () => {
  const route = readCode("src/app/api/translate/route.ts");

  it("maps through validateTranslation and drops rejects to null", () => {
    // Validated against the PROTECTED source: {brandN} tokens ride the
    // placeholder multiset, then restoreBrands puts the words back.
    expect(route).toMatch(/validateTranslation\(protectedTexts\[i\], cand\)/);
    expect(route).toMatch(/restoreBrands\(\(cand as string\)\.trim\(\)\)/);
  });

  it("the OLD String() coercion is gone", () => {
    expect(route).not.toMatch(/parsed\.t\.map\(\(s\) => String\(s\)\)/);
  });

  it("brand words travel as tokens, so a transliteration cannot retire a string", () => {
    // The old behavioural rule ("keep these words verbatim" + brand-lost
    // rejection) rejected Hebrew transliterations of WheelDeal and left those
    // strings permanently English. Structural now: the model never sees the
    // word, only a token it cannot translate.
    expect(route).toMatch(/texts\.map\(protectBrands\)/);
    expect(route).toMatch(/\{brandN\} tokens are protected brand names/);
  });

  it("a rejected chunk gets ONE stricter retry, and the reasons are surfaced", () => {
    expect(route).toMatch(/translateChunk\(langName, again, true\)/);
    expect(route).toMatch(/rejected: rejectedAll/);
  });

  it("M23: it sends a structured brief, NOT a bare array of strings", () => {
    expect(route).toMatch(/JSON\.stringify\(protectedTexts\.map\(translationBrief\)\)/);
    // And the prompt explains what the role means, or the field is decoration.
    expect(route).toMatch(/"label" is a button or control caption/);
    expect(route).toMatch(/Input is a JSON array of \{ text, role, maxChars \}/);
  });

  it("the reply contract is still index-aligned, so validation stays positional", () => {
    // validateTranslation compares out[i] to texts[i]; a reordered or reshaped
    // reply would validate each translation against the wrong source.
    expect(route).toMatch(/in the exact same order and count/);
    expect(route).toMatch(/parsed\.t\.length === texts\.length/);
  });

  it("a rejected element keeps the English source (caller guards on truthiness)", () => {
    // The cache write skips nulls, so the source stays untranslated rather
    // than caching a bad value.
    expect(route).toMatch(/if \(res\.out\[j\]\) cached\[src\] = res\.out\[j\] as string;/);
  });
});
