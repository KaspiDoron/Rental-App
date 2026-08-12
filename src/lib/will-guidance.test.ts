import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { deriveWillStep, type WillStepInput } from "./will-assistant";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// "WILL'S GUIDANCE IS IRRELEVANT" (W-6) was not a copywriting problem.
//
// `deriveWillStep` took six inputs - waConnected / waPhase / phase /
// vendorCount / offerCount / closing - and NONE of them can see what the
// traveller has actually entered. So the whole pre-search half of the funnel
// collapsed into one step, `SEARCH_INPUT`, and the inline catalogue in
// page.tsx had exactly one thing to say across four genuinely different
// situations: nothing typed at all, a bike described with no stay pinned, a
// stay pinned with no bike described, and a form that is ready to send.
//
// Three quarters of the time that advice named a step the traveller had
// already taken, which is precisely what "irrelevant" feels like.

const linked: WillStepInput = {
  waConnected: true,
  waPhase: null,
  phase: "idle",
  vendorCount: 0,
  offerCount: 0,
  closing: false,
};

describe("the pre-search step is derived from what the traveller entered", () => {
  it("nothing entered is its own step", () => {
    expect(deriveWillStep({ ...linked, hasRequest: false, hasStay: false })).toBe("SEARCH_EMPTY");
  });

  it("a request with no stay asks for the stay", () => {
    expect(deriveWillStep({ ...linked, hasRequest: true, hasStay: false })).toBe(
      "SEARCH_NEEDS_STAY"
    );
  });

  it("a stay with no request asks for the request", () => {
    expect(deriveWillStep({ ...linked, hasRequest: false, hasStay: true })).toBe(
      "SEARCH_NEEDS_REQUEST"
    );
  });

  it("both present is the ONLY state that may say 'press it'", () => {
    expect(deriveWillStep({ ...linked, hasRequest: true, hasStay: true })).toBe("SEARCH_READY");
  });

  it("the missing STAY outranks the missing request", () => {
    // Not a style choice. Discovery searches outward from the origin, so with
    // no stay not one shop is contacted however well the bike is described -
    // whereas a vague request only means the profiler has less to work with.
    // If this ever flips, Will would send someone to refine text that is
    // already good enough while the actual blocker sits untouched.
    expect(deriveWillStep({ ...linked, hasRequest: false, hasStay: false })).not.toBe(
      "SEARCH_NEEDS_REQUEST"
    );
    expect(deriveWillStep({ ...linked, hasRequest: true, hasStay: false })).toBe(
      "SEARCH_NEEDS_STAY"
    );
  });

  it("a caller that reports NEITHER input still gets the old lumped step", () => {
    // The refinement is opt-in on purpose: a caller that cannot see the form
    // must not be told the form is empty - that is the same class of lie as
    // the fail-green reads elsewhere in this repo, just in copy.
    expect(deriveWillStep(linked)).toBe("SEARCH_INPUT");
  });

  it("...and a caller that reports only ONE of them is still refined", () => {
    // Half-reporting is real: `hasStay` comes from `origin`, which exists
    // before any text does. Treating a partial report as "unknown" would put
    // the traveller back on the generic step for the whole first half.
    expect(deriveWillStep({ ...linked, hasStay: true })).toBe("SEARCH_NEEDS_REQUEST");
    expect(deriveWillStep({ ...linked, hasRequest: true })).toBe("SEARCH_NEEDS_STAY");
  });
});

describe("the funnel steps still win over the input steps", () => {
  it("an unlinked user is on the link step even with a complete form", () => {
    expect(
      deriveWillStep({ ...linked, waConnected: false, hasRequest: true, hasStay: true })
    ).toBe("WA_LINK_PENDING");
  });

  it("a search in flight is never 'ready to search'", () => {
    // `hasRequest`/`hasStay` stay true for the whole run, so an ordering slip
    // here would tell someone to press a button they already pressed.
    for (const phase of ["profiling", "running"]) {
      expect(deriveWillStep({ ...linked, phase, hasRequest: true, hasStay: true })).toBe(
        "AGENTS_DISPATCHED"
      );
    }
    expect(
      deriveWillStep({ ...linked, phase: "done", vendorCount: 6, hasRequest: true, hasStay: true })
    ).toBe("NEGOTIATING");
    expect(
      deriveWillStep({ ...linked, offerCount: 2, hasRequest: true, hasStay: true })
    ).toBe("RESULTS_READY");
  });

  it("still says nothing at all while the link status is unknown", () => {
    expect(
      deriveWillStep({ ...linked, waConnected: null, hasRequest: true, hasStay: true })
    ).toBeNull();
  });
});

describe("the page actually feeds Will the inputs", () => {
  const page = readCode("src/app/page.tsx");

  it("the derivation is passed the request, the stay and the consent tick", () => {
    const call = /deriveWillStep\(\{[\s\S]*?\}\)/.exec(page);
    expect(call, "the deriveWillStep call site moved").toBeTruthy();
    expect(call![0]).toMatch(/hasRequest:/);
    expect(call![0]).toMatch(/hasStay:/);
    expect(call![0]).toMatch(/idpDeclared:/);
  });

  it("a tap-built request counts, not just typed text", () => {
    // The builder is the whole point of "not a typer?" - if only `rawText`
    // counted, someone who built their request in taps would be told to
    // describe a bike they had already picked.
    const call = /deriveWillStep\(\{[\s\S]*?\}\)/.exec(page)![0];
    expect(call).toMatch(/rawText/);
    expect(call).toMatch(/builderFields/);
  });

  it("the memo re-derives when those inputs change", () => {
    // A stale dep array is how this defect comes back silently: the step would
    // be correct exactly once, then freeze on the first render's inputs.
    const deps = /deriveWillStep\(\{[\s\S]*?\}\),\s*\[([\s\S]*?)\]/.exec(page);
    expect(deps, "the memo dep array moved").toBeTruthy();
    for (const d of ["rawText", "builderFields", "origin", "idpConsent"]) {
      expect(deps![1], `${d} is not a dependency`).toContain(d);
    }
  });
});

describe("each new step has its own advice, anchored where the fix is", () => {
  const page = readCode("src/app/page.tsx");

  it("every new step is handled - an unhandled one shows nothing", () => {
    for (const step of ["SEARCH_EMPTY", "SEARCH_NEEDS_STAY", "SEARCH_NEEDS_REQUEST", "SEARCH_READY"]) {
      expect(page, `${step} has no branch`).toContain(`"${step}"`);
    }
  });

  it("the missing-stay bubble points at the stay field, not the search box", () => {
    const branch = /step === "SEARCH_NEEDS_STAY"[\s\S]{0,900}/.exec(page);
    expect(branch, "the SEARCH_NEEDS_STAY branch moved").toBeTruthy();
    expect(branch![0]).toMatch(/anchor: "\[data-tour='stay'\]"/);
  });

  it("the missing-request bubble points at the request box", () => {
    const branch = /step === "SEARCH_NEEDS_REQUEST"[\s\S]{0,900}/.exec(page);
    expect(branch, "the SEARCH_NEEDS_REQUEST branch moved").toBeTruthy();
    expect(branch![0]).toMatch(/anchor: "\[data-tour='request'\]"/);
  });

  it("every anchor Will points at exists in the page", () => {
    // A bubble whose anchor does not resolve has nothing to attach to - the
    // guidance is computed, then rendered nowhere.
    for (const a of ["stay", "request", "find"]) {
      expect(page, `[data-tour='${a}'] does not exist`).toContain(`data-tour="${a}"`);
    }
  });

  it("'ready' does not say press it while the consent tick still blocks it", () => {
    // The Find button is DISABLED without the licence tick. Telling someone to
    // press a dead button is worse than saying nothing, so the ready step
    // splits and names the last real blocker.
    const branch = /step === "SEARCH_READY"[\s\S]{0,900}/.exec(page);
    expect(branch, "the SEARCH_READY branch moved").toBeTruthy();
    expect(branch![0]).toMatch(/!idpConsent/);
  });
});
