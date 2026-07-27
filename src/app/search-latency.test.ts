import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// A hunt is supposed to put shops on screen in under ten seconds. It was taking
// over a minute, and the reason was structural rather than any one slow call:
// three network round trips ran strictly one after another, and each one could
// spend its own timeout budget before the next even started.

const page = () => readCode("src/app/page.tsx");

describe("the search does not queue behind itself", () => {
  it("closing the old session no longer blocks the new one from starting", () => {
    // It must precede SENDING, not searching - nothing about finding shops
    // depends on the previous session being closed.
    const p = page();
    expect(p).toMatch(/const closing = \(async \(\) => \{/);
    expect(p).toMatch(/if \(!\(await closing\)\)/);
    // The old shape: awaited before the profiler had even been called.
    expect(p).not.toMatch(/let closed = await close\(\)[\s\S]{0,400}?await fetch\("\/api\/profile"/);
  });

  it("discovery starts in the same tick as the profiler when the class is known", () => {
    // The request panel already holds the vehicle class, and origin + radius +
    // class is everything discovery needs.
    const p = page();
    expect(p).toMatch(/const earlyVendorsP = structuredFields\?\.vehicleClass/);
    expect(p).toMatch(/await \(earlyVendorsP \?\? discover\(/);
  });

  it("free text still waits, because there the class IS the profiler's answer", () => {
    expect(page()).toMatch(/discover\(pData\.rfq\.vehicleClass, pData\.rfq\)/);
  });

  it("the early call still stores a real RFQ snapshot for Trips", () => {
    // Derived server-side from the same pure function the profiler uses, so the
    // fast path does not quietly lose the hunt's restorability.
    const r = readCode("src/app/api/vendors/route.ts");
    expect(r).toMatch(/deterministicRFQ\(body\.fields\)/);
    expect(page()).toMatch(/fields: rfqSnap \? undefined : structuredFields/);
  });
});

describe("a shop lookup has a budget", () => {
  it("no single Google call may spend more than a few seconds", () => {
    // 12s per call, and the chain makes more than one - two timeouts back to
    // back is 24 seconds before anything else has run.
    const g = readCode("src/lib/google.ts");
    const m = g.match(/const CALL_BUDGET_MS = (\d[\d_]*)/);
    expect(m).toBeTruthy();
    expect(Number(m![1].replace(/_/g, ""))).toBeLessThanOrEqual(8000);
    expect(g).toMatch(/ms = CALL_BUDGET_MS/);
  });
});

describe("the spinner says which wait this actually is", () => {
  it("structuring and discovering are separate phases", () => {
    const p = page();
    expect(p).toMatch(/"idle" \| "profiling" \| "discovering" \| "running" \| "done"/);
    expect(p).toMatch(/setPhase\("discovering"\)/);
  });

  it("...and the label follows the phase instead of always saying 'Structuring'", () => {
    const p = page();
    expect(p).toMatch(/phase === "discovering"\s*\?\s*t\("Finding shops near you"\)/);
  });

  it("the button stays disabled through BOTH waits", () => {
    expect(page()).toMatch(/phase === "profiling" \|\| phase === "discovering" \|\| phase === "running"/);
  });
});

describe("the IDP declaration is an act, not a stored preference", () => {
  it("is never persisted", () => {
    // One tick months ago used to speak for every search since - including
    // searches for a different vehicle CATEGORY, which is what it is about.
    const raw = read("src/app/page.tsx");
    expect(raw).not.toMatch(/wd_idp_consent/);
  });

  it("starts unchecked", () => {
    expect(page()).toMatch(/const \[idpConsent, setIdpConsent\] = useState\(false\)/);
  });

  it("is reset once the search it was made for has started", () => {
    expect(page()).toMatch(/setIdpConsent\(false\)/);
  });

  it("still gates the search button", () => {
    expect(page()).toMatch(/\|\| !idpConsent\}/);
  });
});
