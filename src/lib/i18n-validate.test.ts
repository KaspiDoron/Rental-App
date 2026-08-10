import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  validateTranslation,
  placeholders,
  DO_NOT_TRANSLATE,
  MAX_RATIO,
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

describe("the route uses the validator, not String() coercion", () => {
  const route = readCode("src/app/api/translate/route.ts");

  it("maps through validateTranslation and drops rejects to null", () => {
    expect(route).toMatch(/validateTranslation\(texts\[i\], cand\)/);
    expect(route).toMatch(/v\.ok \? \(cand as string\)\.trim\(\) : null/);
  });

  it("the OLD String() coercion is gone", () => {
    expect(route).not.toMatch(/parsed\.t\.map\(\(s\) => String\(s\)\)/);
  });

  it("the prompt names the do-not-translate list, including Will", () => {
    expect(route).toMatch(/DO_NOT_TRANSLATE\.join/);
    expect(route).toMatch(/"Will" is the name of the assistant/);
  });

  it("a rejected element keeps the English source (caller guards on truthiness)", () => {
    // The cache write is `if (out[j]) cached[src] = out[j]` - a null is skipped,
    // so the source stays untranslated rather than caching a bad value.
    expect(route).toMatch(/if \(out\[j\]\) cached\[src\] = out\[j\];/);
  });
});
