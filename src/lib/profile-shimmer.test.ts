import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { I18N_CATALOG } from "./i18n-catalog";

vi.mock("server-only", () => ({}));

const readRaw = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// M11: A CONNECTION CHECK IN FLIGHT IS A SHIMMER, NEVER AN ANSWER.
//
// The profile screen is where every "are we connected" question is asked, and
// this repo has now shipped the same bug on two of them: a check that has not
// come back yet rendered as a confident negative. The WhatsApp pill was fixed
// when it sat on CHECKING... above a green connected box. The alerts toggle
// still had it.

describe("the alerts check does not answer before it knows", () => {
  const toggle = stripComments(readRaw("src/components/AlertsToggle.tsx"));

  it("loading has its own branch, ahead of the toggle and the pill", () => {
    // `loading` used to fall through to the non-toggle branch, whose pill reads
    // "Unavailable" - so the first moment of every profile load told a user
    // with alerts ON that the feature was unavailable.
    expect(toggle).toMatch(/const checking = state === "loading"/);
    const checkAt = toggle.indexOf("{checking ? (");
    const toggleAt = toggle.indexOf("canToggle ? (");
    expect(checkAt).toBeGreaterThan(-1);
    expect(checkAt).toBeLessThan(toggleAt);
  });

  it("the help text shimmers too", () => {
    // Rendering the `off` copy under a shimmering switch would still be telling
    // a user with alerts on that they have none.
    expect(toggle).toMatch(/checking \? \(\s*<Skeleton[\s\S]{0,120}\) : \(\s*<p/);
  });

  it("it uses the shared Skeleton, not a bespoke grey box", () => {
    expect(toggle).toMatch(/import \{ Skeleton \} from ".\/Skeleton"/);
  });

  it("the shimmer is switch-shaped, so the row does not jump on settle", () => {
    expect(toggle).toMatch(/<Skeleton className="h-6 w-11" rounded="rounded-full" \/>/);
  });

  it('"Unavailable" is still reachable for the states that really are', () => {
    // The fix must not delete the honest negative - unsupported browsers and a
    // denied permission are genuine answers, not pending ones.
    expect(toggle).toMatch(/Unavailable/);
    expect(toggle).toMatch(/state === "unconfigured" \? t\("Soon"\)/);
  });
});

describe("the WhatsApp pill keeps its four states", () => {
  const profile = stripComments(readRaw("src/app/profile/page.tsx"));

  it("not-yet-asked and could-not-ask stay distinct from not-connected", () => {
    expect(profile).toMatch(/CHECKING\.\.\./);
    expect(profile).toMatch(/CAN'T CHECK RIGHT NOW/);
    expect(profile).toMatch(/NOT CONNECTED/);
  });
});

describe("declutter: one preferences card, not three", () => {
  const profile = readRaw("src/app/profile/page.tsx");

  it("appearance and travel preferences share one section", () => {
    const prefsAt = profile.indexOf('{t("Preferences")}');
    expect(prefsAt).toBeGreaterThan(-1);
    const card = profile.slice(prefsAt, profile.indexOf("</section>", prefsAt));
    expect(card).toMatch(/t\("Appearance"\)/);
    expect(card).toMatch(/t\("Favourite ride"\)/);
    expect(card).toMatch(/t\("Home city"\)/);
  });

  it("the merged heading is in the translation catalogue", () => {
    expect(I18N_CATALOG).toContain("Preferences");
    // "Appearance" survives as a sub-label rather than a card title.
    expect(I18N_CATALOG).toContain("Appearance");
    expect(I18N_CATALOG).not.toContain("Travel preferences");
  });

  it("currency stays where it was deliberately promoted to", () => {
    // It was moved UP the page on purpose; folding it in here would undo that.
    const currencyAt = profile.indexOf('{t("Your currency")}');
    const prefsAt = profile.indexOf('{t("Preferences")}');
    expect(currencyAt).toBeGreaterThan(-1);
    expect(currencyAt).toBeLessThan(prefsAt);
  });
});
