import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// Shop B quoted 250/day. Shop A had already offered 200/day for the same 125cc
// scooter in the SAME search. The agent's push was:
//
//   "Hi again! Any chance of a better daily rate for the scooter?
//    Ready to book if the price works"
//
// No rival price, no anchor, nothing the session already knew. Two separate
// reasons, and the ranked leverage plan built for exactly this was innocent of
// both.

describe("the strongest card leads the push", () => {
  const pass = () => readCode("src/lib/spte/pass.ts");

  it("the plan is still ranked and still nameless", () => {
    const p = pass();
    expect(p).toMatch(/planLeverage\(\{/);
    expect(p).toMatch(/LEVERAGE, STRONGEST FIRST/);
    // Price and vehicle, never the rival's name.
    expect(p).toMatch(/NEVER write the name of another rental shop/);
  });

  it("the round-0 angle no longer overrides it with the duration lever", () => {
    // The prompt printed the ranked plan and then, in the next breath, told the
    // model to argue from duration regardless - so the best card was computed,
    // shown, and talked over.
    const p = pass();
    expect(p).not.toMatch(/use the \$\{days\}-day rental as your reason/);
    expect(p).toMatch(/lead \? "the leverage above as your reason"/);
  });

  it("duration is still the reason when there is genuinely nothing better", () => {
    expect(pass()).toMatch(/!lead && round <= 0 && days >= 3/);
  });

  it("the angle is computed AFTER the plan it defers to", () => {
    const p = pass();
    expect(p.indexOf("const lead = leadCard(plan)")).toBeLessThan(p.indexOf("const roundPlay ="));
  });
});

describe("every bargain path goes through a composer, not a literal", () => {
  it("Push harder asks the server to draft the message", () => {
    const page = readCode("src/app/page.tsx");
    expect(page).toMatch(/"\/api\/bargain-draft"/);
    // The literal survives only as the offline fallback.
    expect(page).toMatch(/drafted \|\|/);
  });

  it("the server draft is safety-screened before it is offered", () => {
    expect(readCode("src/app/api/bargain-draft/route.ts")).toMatch(/runSafety\(draft\.message\)/);
  });
});
