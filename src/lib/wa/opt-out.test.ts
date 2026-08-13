import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { detectOptOutIntent, screenInboundDeterministic } from "../inbound-risk";

// THE SHOP SAID STOP, AND STOP IS FOREVER (owner report 3, 3.4 severity #3).
//
// A recipient who blocks or reports a number is WhatsApp's strongest ban
// signal, and the message before a block is almost always some spelling of
// "stop writing to me". Before this round NO opt-out state existed anywhere:
// a shop could beg to be left alone and the next hunt would cold-message it
// again. The chain under test: deterministic multilingual detection ->
// markRecipientOptedOut stamps wa_recipient_state.opted_out_at -> guardOutbound
// refuses every future send, manual included, terminally.

describe("detectOptOutIntent - multilingual, imperative-aimed-at-us only", () => {
  it("catches the English spellings a shop actually types", () => {
    expect(detectOptOutIntent("Please stop messaging me")).toBe(true);
    expect(detectOptOutIntent("don't text me again")).toBe(true);
    expect(detectOptOutIntent("Do not contact us anymore")).toBe(true);
    expect(detectOptOutIntent("remove my number from your list")).toBe(true);
    expect(detectOptOutIntent("leave me alone")).toBe(true);
    expect(detectOptOutIntent("unsubscribe")).toBe(true);
  });

  it('bare "stop" counts ONLY as the whole message (the SMS convention)', () => {
    expect(detectOptOutIntent("STOP")).toBe(true);
    expect(detectOptOutIntent("stop.")).toBe(true);
    expect(detectOptOutIntent("Stop please")).toBe(true);
    // "stop" inside ordinary rental talk must never mute a live negotiation.
    expect(detectOptOutIntent("you can stop by the shop anytime")).toBe(false);
    expect(detectOptOutIntent("we stop renting at 6pm")).toBe(false);
    expect(detectOptOutIntent("non-stop service all week")).toBe(false);
  });

  it("catches the funnel's live-market languages", () => {
    expect(detectOptOutIntent("אל תכתוב לי יותר")).toBe(true); // Hebrew
    expect(detectOptOutIntent("תפסיק לשלוח לי הודעות")).toBe(true); // Hebrew
    expect(detectOptOutIntent("อย่าส่งข้อความมาอีก")).toBe(true); // Thai
    expect(detectOptOutIntent("no me escribas más")).toBe(true); // Spanish
    expect(detectOptOutIntent("pare de enviar mensagens")).toBe(true); // Portuguese
    expect(detectOptOutIntent("ne m'écris plus")).toBe(true); // French
    expect(detectOptOutIntent("đừng nhắn tin nữa")).toBe(true); // Vietnamese
    expect(detectOptOutIntent("не пишите мне больше")).toBe(true); // Russian
    expect(detectOptOutIntent("bana yazma")).toBe(true); // Turkish
    expect(detectOptOutIntent("不要再发消息了")).toBe(true); // Chinese
  });

  it("PRECISION OVER RECALL: normal negotiation never opts a shop out", () => {
    for (const text of [
      "Yes have 125cc, 180 per day, helmet included",
      "Deposit 3000 baht cash when you pick up",
      "Sorry we are closed today, message tomorrow",
      "Can you send your passport photo?", // a RISK, not an opt-out
      "I can do 250, final price",
      "בסדר, 100 שקל ליום", // Hebrew counter-offer
      "we don't do deliveries, pickup only",
      "please don't be late for the pickup",
    ]) {
      expect([text, detectOptOutIntent(text)]).toEqual([text, false]);
    }
  });

  it("empty and whitespace never match", () => {
    expect(detectOptOutIntent("")).toBe(false);
    expect(detectOptOutIntent("   ")).toBe(false);
  });
});

describe("the opt-out rides the screen without becoming a risk", () => {
  it("screenInboundDeterministic surfaces optOut and keeps risk none", () => {
    const r = screenInboundDeterministic("please stop messaging me");
    expect(r.optOut).toBe(true);
    expect(r.risk).toBe("none");
  });

  it("a risky message is a risk whether or not it opts out", () => {
    const r = screenInboundDeterministic("send photo of your passport first");
    expect(r.risk).toBe("high");
    expect(r.optOut).toBeUndefined();
  });
});

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("the permanent veto is wired end to end (source pins)", () => {
  const guard = readCode("src/lib/wa-guard.ts");

  it("guardOutbound refuses an opted-out recipient terminally, with a durable trace", () => {
    expect(guard).toMatch(/priorRecipient\.rows\.some\(\(r\) => r\.opted_out_at\)/);
    expect(guard).toMatch(/recordSendDropped\(\s*opts\.senderKey,\s*opts\.toDigits,\s*"opted-out/);
    expect(guard).toMatch(/reason: "opted-out - this shop asked not to be messaged again"/);
  });

  it("the veto binds MANUAL sends too - it sits outside every if (opts.auto) block", () => {
    // The opt-out check must key on the recipient row alone. If it ever moves
    // inside an auto-only branch, a user-typed message would still reach a
    // shop that said stop.
    const vetoIdx = guard.indexOf('"opted-out - this shop asked not to be messaged again"');
    expect(vetoIdx).toBeGreaterThan(-1);
    const before = guard.slice(Math.max(0, vetoIdx - 600), vetoIdx);
    expect(before).not.toMatch(/if \(opts\.auto\)/);
  });

  it("the column joins the select ONLY behind the schema probe (pre-migration installs keep contactState)", () => {
    expect(guard).toMatch(/tableReady\("wa_recipient_state", "opted_out_at"\)/);
    expect(guard).toMatch(/hasOptOutCol \? ",opted_out_at/);
  });

  it("markRecipientOptedOut stamps the column and always leaves the wa-opt-out event", () => {
    expect(guard).toMatch(/export async function markRecipientOptedOut/);
    expect(guard).toMatch(/opted_out_at: new Date\(\)\.toISOString\(\)/);
    expect(guard).toMatch(/kind: "wa-opt-out"/);
  });

  it("the inbound path stamps BEFORE the risk-none early return", () => {
    const loop = readCode("src/lib/agent-loop.ts");
    const stamp = loop.indexOf("markRecipientOptedOut");
    const riskReturn = loop.indexOf('if (verdict.risk === "none") return;');
    expect(stamp).toBeGreaterThan(-1);
    expect(riskReturn).toBeGreaterThan(stamp);
  });

  it("schema.sql carries the column", () => {
    const schema = readFileSync(join(process.cwd(), "supabase/schema.sql"), "utf8");
    expect(schema).toMatch(/add column if not exists opted_out_at timestamptz/);
  });
});
