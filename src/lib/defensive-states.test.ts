import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { I18N_CATALOG } from "./i18n-catalog";

vi.mock("server-only", () => ({}));

const readRaw = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const deals = stripComments(readRaw("src/app/deals/page.tsx"));

// M1: A FAILED LOAD IS NOT AN EMPTY ONE.
//
// The Trips page caught a failed `/api/deals` read silently, left `sessions` at
// [], and rendered "No hunts yet - and I'm ready" - to a traveller who had run
// ten searches. It is the fail-green shape again, but this time pointed at the
// user: the app states as fact something it never checked, and the reasonable
// conclusion from the other side of the screen is that their trips are gone.

describe("the trips read can fail", () => {
  it("a non-ok response is a failure, not an empty payload", () => {
    // Without this, a 500 returning an HTML error page parses to `{}` and
    // `d.sessions ?? []` renders the empty state with total confidence.
    expect(deals).toMatch(/if \(!r\.ok\) throw new Error\(String\(r\.status\)\)/);
  });

  it("the catch records the failure instead of swallowing it", () => {
    // D7 refined the rule: only the FIRST load's failure raises the error
    // card - a failed background refresh keeps the last-good data on screen
    // instead of replacing real trips with an error state.
    expect(deals).toMatch(/if \(first\) setLoadFailed\(true\)/);
  });

  it("a later success clears the flag", () => {
    // Otherwise a retry that works still shows the error card.
    expect(deals).toMatch(/setLoadFailed\(false\)/);
  });
});

describe("the two states are mutually exclusive", () => {
  it("the empty state is gated on the load having succeeded", () => {
    // `canHistory &&` joined the chain in W6.1 (Trips is a Pro/Ultra section,
    // so a free plan never reaches the empty state at all) - the ordering rule
    // this file exists for is unchanged.
    expect(deals).toMatch(
      /!loading && canHistory && !loadFailed && sessions\.length === 0 && bookings\.length === 0/
    );
  });

  it("the failure card renders before the empty card", () => {
    // Two cards - "you have no trips" and "we could not check" - is worse than
    // either alone, so the failure branch has to come first and exclude it.
    const fail = deals.indexOf("!loading && canHistory && loadFailed &&");
    const empty = deals.indexOf("!loading && canHistory && !loadFailed && sessions.length === 0");
    expect(fail).toBeGreaterThan(-1);
    expect(fail).toBeLessThan(empty);
  });
});

describe("the failure copy is honest and actionable", () => {
  it("it says nothing is lost, because nothing is", () => {
    // The traveller's fear is that their trips are gone. Answer it directly.
    expect(deals).toMatch(/Nothing is lost/);
  });

  it("it offers the one action that helps", () => {
    expect(deals).toMatch(/Try again/);
  });

  it("it does not blame the traveller or invent a cause", () => {
    const card = deals.slice(deals.indexOf("Couldn't load your trips"));
    expect(card.slice(0, 600)).not.toMatch(/your fault|invalid|error code/i);
  });

  it("the copy is translated", () => {
    for (const s of ["Couldn't load your trips", "Try again"]) {
      expect(I18N_CATALOG, `missing from the catalogue: "${s}"`).toContain(s);
    }
  });
});

describe("the offline banner still covers the other half", () => {
  it("a genuinely offline device is told so app-wide", () => {
    // M1 has two halves - no network at all, and a server that answered badly.
    // The first was already built; this test pins that it was not removed
    // while the second was added.
    const banner = readRaw("src/components/OfflineBanner.tsx");
    expect(banner).toMatch(/navigator\.onLine/);
    expect(banner).toMatch(/addEventListener\("offline"/);
  });
});
