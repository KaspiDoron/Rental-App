import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

// W4.7 - THE GREETINGS (owner report 5, item 3).
//
// "The ai agents keep writing 'Hi' every new message in a single thread which
// makes the shop think it's an automatic bot; writing hi or hello more than one
// time is not humanize behavior."
//
// The field screenshots show "Hi", "Hi there!" and "Hey there!" in ONE thread,
// and that was not three composers being warm - it was ONE function rolling
// dice. `humanizeVariant` matched a leading greeting and substituted a
// DIFFERENT random one on every send; it never removed one, and it had no
// notion of where in a thread it was.
//
// Every "never greet again" mechanism that DID exist was built into the graph
// engine and the legacy loop - the two engines that engine-route.ts demoted to
// failover. SPTE, the engine that actually answers shops, had none of it: no
// strip, no post-rail, no prompt rule, and its own `momentum` template opened
// with a hard-coded "Hi again!".

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const readCode = (p: string) => stripComments(readFileSync(join(process.cwd(), p), "utf8"));

const chatMock = vi.hoisted(() => ({ fn: vi.fn(async (): Promise<string | null> => null) }));
vi.mock("./ai", () => ({
  chat: (...args: unknown[]) => chatMock.fn(...(args as [])),
  extractJson: <T,>(s: string): T | null => {
    try {
      return JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1)) as T;
    } catch {
      return null;
    }
  },
}));
vi.mock("./runtime-config", () => ({
  sbSelect: vi.fn(async () => []),
  sbSelectStrict: vi.fn(async () => ({ rows: [] })),
  sbInsert: vi.fn(async () => true),
  sbUpdate: vi.fn(async () => true),
  sbDelete: vi.fn(async () => true),
  getConfig: vi.fn(async () => undefined),
  getConfigExact: vi.fn(async () => undefined),
  setConfig: vi.fn(async () => ({ ok: true, persistent: true })),
}));

import { hasLeadingGreeting, stripLeadingGreeting } from "./copy/greeting";
import { humanizeForOutbound, humanizeVariant } from "./wa-guard";
import { stripGreeting } from "./orchestrator";
import { recheckMessage } from "./wa/recheck-message";
import { voiceDirectives, voiceProfileFor } from "./voice";
import { compileStyleDirectives } from "./copy/promptCompiler";
import { openerSeed } from "./copy/matrix";
import { localizeMessage } from "./agents";

describe("the greeting definition itself", () => {
  it('strips "X again!" as ONE phrase - the two nudge templates opened that way', () => {
    // THE BUG: the old alternation matched the bare "Hi" and left the adverb
    // behind as a sentence of its own.
    expect(stripLeadingGreeting("Hi again! Just checking in - any chance on 250?")).toBe(
      "Just checking in - any chance on 250?"
    );
    expect(stripLeadingGreeting("Hello again, is 250/day still available?")).toBe(
      "Is 250/day still available?"
    );
    // ...and the old regex's actual output, so a regression is unmistakable.
    expect(stripLeadingGreeting("Hi again! Planning my trip")).not.toMatch(/^Again/);
  });

  it("has a RIGHT BOUNDARY - a word that merely starts with a greeting survives", () => {
    // The old `\s*[!,.]*\s*` tail could match EMPTY, so "Hitting" -> "Tting".
    expect(stripLeadingGreeting("Hitting the road tomorrow - do you have a 125?")).toBe(
      "Hitting the road tomorrow - do you have a 125?"
    );
    expect(stripLeadingGreeting("Hollandaise")).toBe("Hollandaise");
    expect(hasLeadingGreeting("Hitting the road")).toBe(false);
  });

  it("removes the everyday English openers, and never strips to nothing", () => {
    for (const [input, want] of [
      ["Hi there! Do you have a scooter?", "Do you have a scooter?"],
      ["Hey there, is 250 ok?", "Is 250 ok?"],
      ["Good morning! Any chance on 220?", "Any chance on 220?"],
      ["Hello - what is your best rate?", "What is your best rate?"],
    ] as const) {
      expect(stripLeadingGreeting(input)).toBe(want);
    }
    // A bare greeting is a poor message; a blank one is a lost turn.
    expect(stripLeadingGreeting("Hi!")).toBe("Hi!");
  });

  it("reads a LOCAL greeting too - the localizer writes those, not English ones", () => {
    // The second line of defence. The first is telling localizeMessage not to
    // write one at all (see the localize test below); this catches the case
    // where a localized opener is re-sent into an already-open thread.
    expect(stripLeadingGreeting("สวัสดีครับ มีรถว่างไหมครับ")).toBe("มีรถว่างไหมครับ");
    expect(stripLeadingGreeting("Hola! Me puedes hacer 300 al día?")).toBe(
      "Me puedes hacer 300 al día?"
    );
    expect(hasLeadingGreeting("Xin chào, có xe không?")).toBe(true);
  });

  it("the orchestrator's validator repair is the SAME definition", () => {
    expect(stripGreeting("Hi again! Just checking in")).toBe(stripLeadingGreeting("Hi again! Just checking in"));
  });
});

describe("the send-time choke point knows where in the thread it is", () => {
  const RAW = "Hi there! Could you do 250 per day? Best regards";

  it("MID-THREAD: the greeting is removed and never rolled in again", () => {
    // The reported defect, executed: three consecutive mid-thread sends.
    const sends = [
      "Hi there! Just checking in - any chance on that better rate?",
      "Hey there! ok so 250 works for me?",
      "Hello! and does that include the helmet?",
    ].map((t) => humanizeForOutbound("u@example.com", "66812345678", t, { firstOutbound: false }));
    for (const out of sends) expect(hasLeadingGreeting(out)).toBe(false);
    // ...and the default is the safe one: a caller that says nothing at all
    // must never manufacture a greeting.
    expect(hasLeadingGreeting(humanizeForOutbound("u@example.com", "66812345678", RAW))).toBe(false);
  });

  it("FIRST OUTBOUND: the greeting stays, and the pool still varies it", () => {
    const out = humanizeForOutbound("u@example.com", "66812345678", RAW, { firstOutbound: true });
    expect(hasLeadingGreeting(out)).toBe(true);
    // Forty cold openers must not share one first word: the swap fires here.
    const pool = new Set(
      ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com", "f@x.com", "g@x.com"].map((k) =>
        humanizeForOutbound(k, "66812345678", RAW, { firstOutbound: true }).slice(0, 6)
      )
    );
    expect(pool.size).toBeGreaterThan(1);
  });

  it('never produces the "Hey there! again!" artifact from an "X again" opener', () => {
    // The swap used to match only the leading "Hi " of "Hi again!" and put a
    // WHOLE greeting in its place - on every single momentum/recheck send.
    for (let i = 0; i < 20; i++) {
      const rand = () => i / 20;
      const out = humanizeVariant("Hi again! Any chance on 250?", rand, { firstOutbound: true });
      // "Hey there! again!" / "Hello! again!" - a greeting glued to the orphan
      // adverb. The negative lookahead in the swap regex is what prevents it.
      expect(out).not.toMatch(/\b(hi|hey|hello)\b[^.!?]*!\s*again/i);
      expect(out).toBe("Hi again! Any chance on 250?");
    }
  });

  it("stays deterministic per (sender, shop, text, position) - the park contract", () => {
    const a = humanizeForOutbound("u@example.com", "+66 81 234 5678", RAW, { firstOutbound: false });
    const b = humanizeForOutbound("u@example.com", "66812345678", RAW, { firstOutbound: false });
    expect(a).toBe(b);
  });

  it("guardOutbound DERIVES the position - no caller is trusted with it", () => {
    const guard = readCode("src/lib/wa-guard.ts");
    expect(guard).toMatch(/hasMessagedShopBefore\(opts\.senderKey, opts\.toDigits\)/);
    expect(guard).toMatch(
      /humanizeForOutbound\(opts\.senderKey, opts\.toDigits, opts\.text, \{ firstOutbound \}\)/
    );
    // An unreadable answer resolves to "not the first": an extra greeting is
    // the reported defect, a missing one is a wording nit.
    expect(guard).toMatch(/priorSend === null \? opts\.firstOutbound === true : priorSend === false/);
    // ...and the derivation reads a column that exists in the BASE schema, so
    // a database that never took the later migrations cannot turn every thread
    // into "unknown" at once.
    expect(guard).toMatch(/select=last_sent_at/);
  });
});

describe("the hard-coded greeting sources are closed", () => {
  it("the re-check message no longer opens with one", () => {
    // W6.1: the composer now REFUSES an incomplete deal (no price, deposit or
    // fulfillment = no message at all), so the second assertion is that there
    // is no sentence to greet with rather than a greetingless one.
    const m = recheckMessage({
      pricePerDay: 400,
      currency: "PHP",
      days: 5,
      depositType: "cash",
      depositAmount: 2000,
      fulfillment: "pickup",
    });
    expect(hasLeadingGreeting(m!)).toBe(false);
    expect(m).not.toMatch(/again/i);
    expect(recheckMessage({ pricePerDay: null, currency: "PHP" })).toBeNull();
  });

  it("SPTE's own momentum template no longer opens with one", () => {
    // The PRIMARY engine's nudge - the one that actually runs.
    const pass = readCode("src/lib/spte/pass.ts");
    expect(pass).not.toMatch(/Hi again!/);
    expect(pass).toMatch(/Just checking in - any chance on that better rate/);
  });

  it("the per-turn style directive no longer NAMES a greeting to the model", () => {
    // The dead branch: `s.greeting === ""` was never true (neither pool has an
    // empty entry), so this always named one and then asked for it not to be
    // written verbatim - on composers that are mid-conversation by definition.
    const d = compileStyleDirectives(openerSeed("u@example.com", "v1", "b1"), "Philippines");
    expect(d).toMatch(/MID-CONVERSATION/);
    expect(d).not.toMatch(/in the spirit of/);
    expect(d).not.toMatch(/to your greeting/);
    expect(readCode("src/lib/copy/promptCompiler.ts")).not.toMatch(/s\.greeting === ""/);
    // Still deterministic per seed - the anti-fingerprinting contract holds.
    expect(d).toBe(compileStyleDirectives(openerSeed("u@example.com", "v1", "b1"), "Philippines"));
  });

  it("the voice persona stops claiming a greeting habit mid-conversation", () => {
    const v = voiceProfileFor("u@example.com");
    expect(voiceDirectives(v)).toContain(v.greeting); // the OPENER keeps it
    const mid = voiceDirectives(v, { greeting: false });
    expect(mid).toMatch(/MID-CONVERSATION/);
    expect(mid).not.toMatch(/usually opens with/);
    // ...and composeBargain asks for the mid-conversation form whenever the
    // thread has history - the same condition that adds the "no greeting" rule.
    expect(readCode("src/lib/agents.ts")).toMatch(/greeting: !opts\.history/);
  });

  it("the LOCALIZER is told the position, so it cannot re-add one", async () => {
    // Rule 1 of the localize prompt used to order a local greeting
    // unconditionally - which put back, in Thai, exactly what the English strip
    // had just removed.
    chatMock.fn.mockResolvedValue(
      JSON.stringify({ message: "ลดเหลือ 250 ได้ไหมครับ", english: "can you do 250?" })
    );
    await localizeMessage("Could you do 250 a day?", "Thailand", undefined, true, { greet: false });
    const midPrompt = JSON.stringify(chatMock.fn.mock.calls[0]);
    expect(midPrompt).toContain("MID-CONVERSATION");
    expect(midPrompt).not.toContain("use a natural LOCAL greeting instead");

    chatMock.fn.mockClear();
    await localizeMessage("Could you do 250 a day?", "Thailand");
    expect(JSON.stringify(chatMock.fn.mock.calls[0])).toContain("use a natural LOCAL greeting");
  });

  it("every localize call site declares a thread position", () => {
    // SPTE only ever runs INSIDE an open thread, so it is statically false.
    expect(readCode("src/lib/spte/live.ts")).toMatch(/greet: false/);
    // The graph engine knows from its own prior-outbound list.
    expect(readCode("src/lib/graph/engine.ts")).toMatch(
      /greet: input\.priorOutbound\.length === 0/
    );
    // The opener routes derive it: a SECOND search reaching a shop we already
    // messaged opens a fresh greeting inside an existing WhatsApp thread.
    expect(readCode("src/app/api/outreach/mass/route.ts")).toMatch(/greet: firstOutbound/);
    expect(readCode("src/app/api/outreach/route.ts")).toMatch(
      /greet: kind === "rfq" && established === null/
    );
  });
});
