import { describe, it, expect } from "vitest";
import { stripBotSpeak, casualize, personaHumanize } from "./persona";

// Pins the anti-fingerprinting contract: corporate sign-offs never leave the
// app, and the persona pass produces varied, casual, human-looking text.

describe("stripBotSpeak", () => {
  it("removes the banned corporate sign-offs", () => {
    for (const s of [
      "Can you do 250 a day? Cheers",
      "Can you do 250 a day?\nBest regards",
      "Can you do 250 a day? Kind regards,",
      "Can you do 250 a day?\n\nWarm regards!",
      "Can you do 250 a day? Looking forward to hearing from you.",
      "Can you do 250 a day? Thank you for your time.",
      "Can you do 250 a day? Have a great day!",
    ]) {
      const out = stripBotSpeak(s);
      expect(out.toLowerCase()).not.toMatch(
        /cheers|regards|sincerely|looking forward|thank you for your|have a (nice|great|good)/
      );
      expect(out).toContain("250 a day");
    }
  });

  it("keeps casual human closers like 'thanks'", () => {
    expect(stripBotSpeak("any cheaper? thanks")).toBe("any cheaper? thanks");
  });

  it("strips stacked sign-offs", () => {
    expect(stripBotSpeak("ok great. Thanks and regards\nBest regards").toLowerCase()).not.toMatch(
      /regards/
    );
  });
});

describe("casualize (deterministic with injected rand)", () => {
  it("applies casual swaps when rand is low", () => {
    const out = casualize("I would like to rent. Could you please help. Available today?", () => 0.1);
    expect(out.toLowerCase()).toContain("wanna");
    expect(out.toLowerCase()).not.toContain("could you please");
  });

  it("leaves text unchanged when rand is high", () => {
    const src = "Could you please help with the price today?";
    expect(casualize(src, () => 0.99)).toBe(src);
  });
});

describe("personaHumanize", () => {
  it("strips a sign-off and can add exactly one emoji", () => {
    // rand=0.1 -> below the 0.45 emoji gate, so one emoji is added.
    const out = personaHumanize("Can you do 250? Best regards", () => 0.1);
    expect(out.toLowerCase()).not.toContain("regards");
    const emojis = [...out.matchAll(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2764}]/gu)];
    expect(emojis.length).toBeLessThanOrEqual(1);
  });

  it("never adds a second emoji when one is already present", () => {
    const out = personaHumanize("any cheaper? 🙏", () => 0.1);
    const emojis = [...out.matchAll(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2764}]/gu)];
    expect(emojis.length).toBe(1);
  });

  it("high rand yields no emoji and no swaps (pure strip)", () => {
    expect(personaHumanize("can you do 250 a day?", () => 0.99)).toBe("can you do 250 a day?");
  });
});
