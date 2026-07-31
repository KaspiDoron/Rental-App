import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// THE ONE BUTTON IN THIS APP THAT SENDS A MESSAGE AND HAD NO LOCK.
//
// The RFQ button twenty lines below it is fully gated: a synchronous in-flight
// ref (state lands after a render commit, which is a window wide enough for two
// taps), `disabled` on every committed state, and a muted "queued" chip that
// reads as a status rather than a call to action. The Bargain button had none
// of that - no disabled, no ref, no indicator. Two taps queued two pushes at
// one shop, and only the server's 3-minute window stood in the way.
//
// It could not have been gated, either: the activity poll's queue payload
// carries INTRO kinds only, by design, so the client had no way to know the
// agent was already mid-sentence with that shop.

const card = readCode("src/components/VendorCard.tsx");
const activity = readCode("src/app/api/activity/route.ts");
const page = readCode("src/app/page.tsx");

describe("the client can finally see the agent working", () => {
  it("the route rolls agent rows up per vendor, beside the intro queue", () => {
    expect(activity).toMatch(/const agentPending: Record<string, \{ count: number; sending: boolean \}>/);
    expect(activity).toMatch(/\n    agentPending,/); // it reaches the response body
  });

  it("it uses the SAME lifecycle definition as every other surface", () => {
    const block = activity.slice(activity.indexOf("const agentPending"), activity.indexOf("let waHealth"));
    expect(block).toMatch(/outboxState\(r\.not_before, meta, now\) === "sending"/);
  });

  it("it excludes intro kinds and removed shops - it is the agent's lane only", () => {
    const block = activity.slice(activity.indexOf("const agentPending"), activity.indexOf("let waHealth"));
    expect(block).toMatch(/if \(!kind \|\| INTRO_KINDS\.has\(kind\)\) continue;/);
    expect(block).toMatch(/if \(cancelledSet\.has\(r\.to_number\)\) continue;/);
  });

  it("it carries a COUNT and a state, never the drafted text", () => {
    // The draft belongs to the conversation. A rollup is all a button needs,
    // and shipping the text here would put it on a surface that never asked
    // for it.
    const block = activity.slice(activity.indexOf("const agentPending"), activity.indexOf("let waHealth"));
    expect(block).not.toMatch(/\bbody\b/);
  });

  it("the page threads it to the card it gates", () => {
    expect(page).toMatch(/setAgentPending\(/);
    expect(page).toMatch(/agentPending=\{agentPending\[v\.id\]\}/);
  });
});

describe("and the button is gated exactly like the one beside it", () => {
  it("REPRODUCTION: a double tap can no longer queue two pushes", () => {
    // Synchronous, like rfqInFlight: `disabled` derives from state that lands
    // after a render commit, and two near-instant taps both get through it.
    expect(card).toMatch(/const bargainInFlight = useRef\(false\)/);
    const fn = card.slice(card.indexOf("const startBargain ="), card.indexOf("const alreadyAsked"));
    expect(fn).toMatch(/if \(bargainInFlight\.current \|\| agentBusy\) return;/);
    expect(fn).toMatch(/bargainInFlight\.current = true;/);
  });

  it("...and it clears itself, so a cancelled composer does not kill the button", () => {
    const fn = card.slice(card.indexOf("const startBargain ="), card.indexOf("const alreadyAsked"));
    expect(fn).toMatch(/setTimeout\(\(\) => \(bargainInFlight\.current = false\)/);
    // Tracked, like every other timer here - an untracked one kept firing
    // after the card was gone.
    expect(fn).toMatch(/timersRef\.current\.push/);
  });

  it("every path into the composer goes through the guard", () => {
    // Three call sites: the mismatch CTA, the Bargain chip, and the per-option
    // list. A guard one of them can walk around is not a guard.
    expect(card).not.toMatch(/onClick=\{\(\) => onBargain\(vendor\)\}/);
    expect(card).not.toMatch(/onBargain=\{\(o\) => onBargain\(vendor, o\)\}/);
    // One definition plus three call sites: the mismatch CTA, the chip, the list.
    expect((card.match(/startBargain\(/g) ?? []).length).toBe(3);
  });

  it("busy is SERVER truth, not this component's memory", () => {
    // The composer's own `sendState` guard resets on reopen, which is why it
    // was never enough.
    expect(card).toMatch(/const agentBusy = \(agentPending\?\.count \?\? 0\) > 0;/);
  });

  it("a busy button is disabled, and says why", () => {
    expect(card).toMatch(/disabled=\{agentBusy\}/);
    expect(card).toMatch(/aria-disabled=\{agentBusy\}/);
    expect(card).toMatch(/Your agent is on it/);
    expect(card).toMatch(/agentPending\?\.sending \? t\("Sending now"\)/);
  });

  it("busy reads as a STATUS, not as a live red button", () => {
    // The same lesson the queued RFQ chip already learned: a muted chip, and
    // `disabled:opacity-100` so it does not merely look like a broken button.
    expect(card).toMatch(/cursor-default border-line bg-card2 text-soft disabled:opacity-100/);
  });

  it("the new copy is translatable", () => {
    const cat = readCode("src/lib/i18n-catalog.ts");
    expect(cat).toMatch(/"Your agent is on it"/);
    expect(cat).toMatch(/"Sending now"/);
  });
});
