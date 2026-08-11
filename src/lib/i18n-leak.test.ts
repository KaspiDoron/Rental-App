import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  pending,
  failed,
  translatable,
  catalogue,
  queueForTranslation,
  queueSharedText,
} from "./i18n-gate";
import { I18N_CATALOG } from "./i18n-catalog";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// THE SECOND LEAK. DELETING DomTranslator DID NOT CLOSE IT.
//
// DomTranslator walked the whole body and POSTed every text node; it is gone.
// `t()` had the same terminal behaviour through a much smaller door: every
// string handed to it went into `pending`, was POSTed to /api/translate, and
// was cached into `app_config` key `I18N_<lang>` - ONE ROW, read by every user
// of that language.
//
// And `t()` is called with runtime values in 22 places - `t(offer.vehicleNote)`
// (shop-written), `t(chip.text)`, `t(queueItem.reason)` (carries the
// traveller's own trust score and cap). So one traveller's shop text became
// another traveller's dictionary.
//
// `pending` is the ONLY source of the /api/translate payload, and
// queueForTranslation is the only way into it - so these executed tests decide
// exactly what leaves the device. That matters here: a source pin on the guard
// line would still pass against a provider that queued the string elsewhere.

describe("REPRODUCTION: t() uploaded whatever it was handed", () => {
  beforeEach(() => {
    pending.clear();
    failed.clear();
  });

  // Real user text, of the kind the dynamic call sites hand to t() today.
  const PRIVATE = [
    "Rafols Motorbike Rental",
    "Hey! Do you have a scooter for 5 days?",
    "hourly cap reached (15/h at trust 20)",
    "Honda PCX 160 - 2023, 12,400 km",
    "Sunrise Beach Hotel, Room 214",
  ];

  it("a shop name, a transcript line and a per-user reason never enter the queue", () => {
    for (const s of PRIVATE) {
      expect(queueForTranslation(s), `"${s}" was accepted for upload`).toBe(false);
    }
    expect([...pending]).toEqual([]);
  });

  it("...and they are not even considered translatable", () => {
    for (const s of PRIVATE) expect(translatable(s)).toBe(false);
  });

  it("real UI copy from the catalogue IS still queued", () => {
    const known = I18N_CATALOG[0];
    expect(queueForTranslation(known)).toBe(true);
    expect([...pending]).toEqual([known]);
  });

  it("a string the server already declined is not re-queued", () => {
    const known = I18N_CATALOG[1];
    failed.add(known);
    expect(queueForTranslation(known)).toBe(false);
    expect([...pending]).toEqual([]);
  });

  it("t() reaches the queue ONLY through the gate", () => {
    // If a later edit re-adds a bare `pending.add(s)` inside the provider, the
    // executed tests above would still pass while the leak was reopened. This
    // pins the single door shut.
    const src = readCode("src/lib/i18n.tsx");
    expect(src).toMatch(/queueForTranslation\(s\);/);
    expect(src).not.toMatch(/pending\.add\(/);
  });
});

describe("tShared: the one escape hatch, and how narrow it is", () => {
  beforeEach(() => {
    pending.clear();
    failed.clear();
  });

  it("queues text outside the catalogue - that is the whole point", () => {
    // Owner-authored FAQ copy is global by construction: same for every
    // traveller, written by the operator, carrying nothing about the user.
    expect(queueSharedText("Do I need an international licence?")).toBe(true);
    expect([...pending]).toEqual(["Do I need an international licence?"]);
  });

  it("is used by the FAQ and by nothing else in the app", () => {
    const faq = readCode("src/components/FaqSection.tsx");
    expect(faq).toMatch(/tShared\(it\.q\)/);
    expect(faq).toMatch(/tShared\(it\.a\)/);

    // Any other consumer is a new hole in the gate and must be argued for.
    const hits = readFileSync(join(process.cwd(), "src/lib/i18n.tsx"), "utf8");
    expect(hits).toMatch(/NEVER hand it a shop name/);
  });
});

describe("the catalogue is the gate, so it has to be complete", () => {
  const catalog = new Set(catalogue());

  it("the catalogue and the shipped constant are the same set", () => {
    expect(catalog.size).toBe(new Set(I18N_CATALOG).size);
  });

  it("computed copy declared in i18n-extras reaches the catalogue", async () => {
    const { I18N_EXTRAS } = await import("./i18n-extras");
    expect(I18N_EXTRAS.length).toBeGreaterThan(20);
    for (const s of I18N_EXTRAS) {
      expect(catalog.has(s), `extras string missing from the catalogue: "${s}"`).toBe(true);
    }
  });

  it("the strings reached only through a variable are declared", () => {
    // Each of these renders as t(variable), so the generator's grep for literal
    // t("...") cannot see it. Before the gate they were translated by accident,
    // because t() queued anything at all. Now they must be declared in
    // i18n-extras or they ship in English.
    for (const s of [
      // TrustPanel MECHANICS. UPDATED, not merely re-pointed: the sample this
      // used to name ("One conversation per shop per day...") was one of six
      // claims RETRACTED from the component, and this test was the only thing
      // still asserting it belonged in the catalogue - which is part of how the
      // extras file stayed out of step with the panel for so long. The sample
      // now names a mechanic the panel actually renders, and i18n-drift.test.ts
      // checks the WHOLE list rather than one representative.
      "One introduction per shop. After that your agent only writes again once the shop has actually written back.",
      "Compare the top 3", // WillSheet QUICK
      "DIFFERENT VEHICLE", // offer-badges label
      "Nothing to do - it resolves itself, usually within a few minutes.", // offer-badges next
      "high", // AgenticSummary confidence
    ]) {
      expect(catalog.has(s), `not in the catalogue: "${s}"`).toBe(true);
    }
  });

  it("the generator survives a missing extras file instead of crashing", () => {
    // i18n-extras.ts was deleted once by a dead-code sweep - nothing IMPORTS
    // it, the generator only reads it - and readFileSync threw ENOENT, so the
    // catalogue silently could not be regenerated at all.
    const gen = readFileSync(join(process.cwd(), "scripts/gen-i18n-catalog.js"), "utf8");
    expect(gen).toMatch(/existsSync\("src\/lib\/i18n-extras\.ts"\)/);
  });
});
