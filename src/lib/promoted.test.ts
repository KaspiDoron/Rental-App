import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { I18N_CATALOG } from "./i18n-catalog";

vi.mock("server-only", () => ({}));

const readRaw = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  readRaw(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// M14: PROMOTED SHOPS, AND THE WORD ON THE BANNER.
//
// The placement machinery already shipped: `sponsored_shops`, the admin panel,
// the glowing frame and the pin. What it wore was "Recommended shop" - an
// editorial claim about a card that is pinned ahead of every other shop under
// EVERY sort, including "Closest" and "Best rating", because somebody paid.
//
// That is the same defect Tier 0.6 deleted eight of: a sentence the code does
// not honour. The prominence is the owner's to sell. The word is not.

describe("a paid placement says it is paid", () => {
  const card = readCode("src/components/VendorCard.tsx");

  it("the banner names the placement as paid", () => {
    expect(card).toMatch(/Promoted - paid placement/);
  });

  it('the editorial claim "Recommended shop" is gone', () => {
    expect(card).not.toMatch(/Recommended shop/);
  });

  it("it is still translated, so non-English users get the disclosure too", () => {
    // A disclosure that only English speakers can read is not a disclosure.
    expect(card).toMatch(/t\("Promoted - paid placement"\)/);
    expect(I18N_CATALOG).toContain("Promoted - paid placement");
    expect(I18N_CATALOG).not.toContain("Recommended shop");
  });

  it("the banner is gated on the flag, not always rendered", () => {
    expect(card).toMatch(/\{vendor\.sponsored && \(/);
  });
});

describe("the pin it discloses is real", () => {
  const page = readCode("src/app/page.tsx");

  it("sponsored still leads every sort - the disclosure describes live behaviour", () => {
    // If this ever stops being true the banner becomes a different kind of
    // false claim, so the two are pinned together.
    expect(page).toMatch(/const sp = \(b\.sponsored \? 1 : 0\) - \(a\.sponsored \? 1 : 0\)/);
    expect(page).toMatch(/if \(sp !== 0\) return sp;/);
  });
});

describe("the owner-facing copy matches what ships", () => {
  const admin = readRaw("src/app/admin/page.tsx");
  const lib = readRaw("src/lib/sponsored.ts");

  it("the admin panel describes the banner the traveller actually sees", () => {
    expect(admin).toMatch(/Promoted - paid placement/);
    expect(admin).not.toMatch(/Recommended shop/);
  });

  it("the module comment does not describe a tag that no longer exists", () => {
    // A comment that lies about the UI is how the next reader ships a
    // regression believing they are restoring intent.
    expect(lib).not.toMatch(/"Recommended" tag/);
  });
});

describe("promotion stays in the DISPLAY layer", () => {
  const mass = readCode("src/lib/mass-bargain.ts");

  it("a paid placement does not buy a shop into the outreach ranking", () => {
    // Paying to appear first in a list the traveller reads is one decision.
    // Paying to be MESSAGED ahead of the shops they picked is a different one
    // nobody has taken - and it would spend the traveller's own metered
    // introduction budget on the owner's revenue.
    expect(mass).not.toMatch(/sponsored/);
  });
});
