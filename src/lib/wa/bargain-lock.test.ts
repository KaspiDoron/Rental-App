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
const panel = readCode("src/components/ThreadDashboard.tsx");
const activity = readCode("src/app/api/activity/route.ts");
const page = readCode("src/app/page.tsx");

describe("the client can finally see the agent working", () => {
  it("the route rolls agent rows up per vendor, beside the intro queue", () => {
    expect(activity).toMatch(
      /const agentPending: Record<string, \{ count: number; sending: boolean; own: boolean \}>/
    );
    expect(activity).toMatch(/\n    agentPending,/); // it reaches the response body
  });

  it("it uses the SAME lifecycle definition as every other surface", () => {
    const block = activity.slice(activity.indexOf("const agentPending"), activity.indexOf("let waHealth"));
    expect(block).toMatch(/outboxState\(r\.not_before, meta, now\) === "sending"/);
  });

  it("REPRODUCTION: an EDITED bargain draft counts as busy - it did not", () => {
    // The rollup reused INTRO_KINDS, which contains "custom" - and "custom" is
    // exactly what BargainDraftModal queues a hand-edited draft as. So the one
    // path where the traveller had just written the message by hand was the one
    // the lock could not see, and a second tap stacked a second message.
    const block = activity.slice(activity.indexOf("const NOT_BUSY_KINDS"), activity.indexOf("let waHealth"));
    expect(block).toMatch(/const NOT_BUSY_KINDS = new Set\(\["rfq", "human-manual"\]\);/);
    expect(block).toMatch(/if \(!kind \|\| NOT_BUSY_KINDS\.has\(kind\)\) continue;/);
    expect(block).not.toMatch(/INTRO_KINDS/);
    expect(block).toMatch(/if \(cancelledSet\.has\(r\.to_number\)\) continue;/);
    // ...and the QUEUE panel keeps its own filter: a different question.
    expect(activity).toMatch(/const INTRO_KINDS = new Set\(\["rfq", "custom", "human-manual"\]\);/);
  });

  it("and it says WHOSE message is holding the shop", () => {
    const block = activity.slice(activity.indexOf("const NOT_BUSY_KINDS"), activity.indexOf("let waHealth"));
    expect(block).toMatch(/own: prev\.own \|\| kind === "custom"/);
  });

  it("it carries a COUNT and a state, never the drafted text", () => {
    // The draft belongs to the conversation. A rollup is all a button needs,
    // and shipping the text here would put it on a surface that never asked
    // for it.
    const block = activity.slice(activity.indexOf("const agentPending"), activity.indexOf("let waHealth"));
    expect(block).not.toMatch(/\bbody\b/);
  });

  it("the page threads it to BOTH surfaces that can bargain", () => {
    expect(page).toMatch(/setAgentPending\(/);
    expect(page).toMatch(/agentPending=\{agentPending\[v\.id\]\}/);
    expect(page).toMatch(/agentPending=\{agentPending\[dashboardFor\.id\]\}/);
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
    expect(card).toMatch(/agentBusyLabel\(agentPending, t\)/);
  });

  it("busy reads as a STATUS, not as a live red button", () => {
    // The same lesson the queued RFQ chip already learned: a muted chip, and
    // `disabled:opacity-100` so it does not merely look like a broken button.
    expect(card).toMatch(/cursor-default border-line bg-card2 text-soft disabled:opacity-100/);
  });

  it("REPRODUCTION: the OTHER Bargain button is gated too", () => {
    // The lock was written on the card. ThreadDashboard has its own Bargain
    // button in its sticky action bar, and it was the plain
    // `onClick={() => onBargain(vendor)}` this suite bans on the card - so
    // opening the thread first walked straight around the guarantee.
    expect(panel).toMatch(/const agentBusy = \(agentPending\?\.count \?\? 0\) > 0;/);
    expect(panel).toMatch(/disabled=\{agentBusy\}/);
    expect(panel).toMatch(/aria-disabled=\{agentBusy\}/);
    expect(panel).toMatch(/if \(agentBusy\) return;/);
    expect(panel).not.toMatch(/onClick=\{\(\) => onBargain\(vendor\)\}/);
    expect(panel).toMatch(/Agents are currently negotiating with this shop/);
  });

  it("both buttons say the same thing, from one definition", () => {
    // Two surfaces drifting apart is how the first hole opened.
    const shared = readCode("src/lib/client/agent-busy.ts");
    expect(shared).toMatch(/export function agentBusyLabel/);
    expect(shared).toMatch(/Your message is going out/);
    expect(card).toMatch(/agentBusyLabel\(agentPending, t\)/);
    expect(panel).toMatch(/agentBusyLabel\(agentPending, t\)/);
  });

  it("the thread poll cannot land an OLD response over a new one", () => {
    expect(panel).toMatch(/let inFlight: AbortController \| null = null;/);
    expect(panel).toMatch(/inFlight\?\.abort\(\);/);
    expect(panel).toMatch(/signal: ctl\.signal/);
    // An abort is us replacing our own request - blanking the transcript for
    // it would be the bug it fixes.
    expect(panel).toMatch(/!== "AbortError"/);
  });

  it("the new copy is translatable", () => {
    const cat = readCode("src/lib/i18n-catalog.ts");
    expect(cat).toMatch(/"Your agent is on it"/);
    expect(cat).toMatch(/"Sending now"/);
    expect(cat).toMatch(/"Your message is going out"/);
    expect(cat).toMatch(/"Agents are currently negotiating with this shop"/);
  });
});
