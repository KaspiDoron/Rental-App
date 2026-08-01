import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

vi.mock("server-only", () => ({}));

// The chain, mocked at the ONE seam every parser goes through. Each test
// scripts the answers the provider gives, in order.
const scripted: { answers: ({ text: string | null; provider?: string; error?: string })[]; seen: string[] } =
  { answers: [], seen: [] };

vi.mock("../ai", async () => {
  const actual = await vi.importActual<typeof import("../ai")>("../ai");
  return {
    ...actual,
    chatDetailed: async (messages: { role: string; content: string }[]) => {
      scripted.seen.push(messages.map((m) => m.content).join("\n---\n"));
      return scripted.answers.shift() ?? { text: null, error: "no provider available" };
    },
  };
});

import { semanticParse } from "./parse";

const Schema = z.object({ wantsCall: z.boolean(), confidence: z.number().min(0).max(1) });

const run = (text = "can you call me?") =>
  semanticParse({
    schema: Schema,
    shape: '{"wantsCall": boolean, "confidence": 0..1}',
    instructions: "Decide whether the sender wants a voice call.",
    text,
  });

beforeEach(() => {
  scripted.answers = [];
  scripted.seen = [];
});

describe("a validated value, or nothing", () => {
  it("a well-shaped answer comes back typed", async () => {
    scripted.answers = [{ text: '{"wantsCall": true, "confidence": 0.9}', provider: "groq" }];
    const out = await run();
    expect(out.value).toEqual({ wantsCall: true, confidence: 0.9 });
    expect(out.degraded).toBe(false);
    expect(out.attempts).toBe(1);
    expect(out.provider).toBe("groq");
  });

  it("a code fence is not a failure - models add them constantly", async () => {
    scripted.answers = [{ text: '```json\n{"wantsCall": false, "confidence": 0.2}\n```', provider: "groq" }];
    expect((await run()).value).toEqual({ wantsCall: false, confidence: 0.2 });
  });

  it("REPRODUCTION: a plausible-but-wrong shape does NOT reach the caller", async () => {
    // The whole point of the contract. Without it this returns
    // {wantsCall: "yes"} and some downstream `if (v.wantsCall)` is true forever.
    scripted.answers = [
      { text: '{"wantsCall": "yes", "confidence": 2}', provider: "groq" },
      { text: '{"wantsCall": "yes", "confidence": 2}', provider: "groq" },
    ];
    const out = await run();
    expect(out.value).toBeNull();
    expect(out.degraded).toBe(false); // it RAN - it just failed
    expect(out.error).toMatch(/wantsCall/);
  });
});

describe("the retry is shown what was wrong", () => {
  it("a schema failure is fed back, and a fixed answer is accepted", async () => {
    scripted.answers = [
      { text: '{"wantsCall": "yes", "confidence": 0.5}', provider: "groq" },
      { text: '{"wantsCall": true, "confidence": 0.5}', provider: "groq" },
    ];
    const out = await run();
    expect(out.value).toEqual({ wantsCall: true, confidence: 0.5 });
    expect(out.attempts).toBe(2);
    // A blind re-ask is a coin flip; a named violation is usually one edit away.
    expect(scripted.seen[1]).toMatch(/did not match the shape\. Fix exactly this: wantsCall/);
  });

  it("prose instead of JSON is retried too", async () => {
    scripted.answers = [
      { text: "Sure! They seem to want a call.", provider: "groq" },
      { text: '{"wantsCall": true, "confidence": 0.7}', provider: "groq" },
    ];
    expect((await run()).value).toEqual({ wantsCall: true, confidence: 0.7 });
    expect(scripted.seen[1]).toMatch(/not a JSON object/);
  });

  it("`once` spends one call when a second is not worth it", async () => {
    scripted.answers = [{ text: "nope", provider: "groq" }];
    const out = await semanticParse({
      schema: Schema,
      shape: "{}",
      instructions: "x",
      text: "y",
      options: { once: true },
    });
    expect(out.value).toBeNull();
    expect(scripted.seen.length).toBe(1);
  });
});

describe("an outage is distinguishable from a failure", () => {
  it("REPRODUCTION: no reachable provider is DEGRADED, and says so", async () => {
    // R11: silent English/degraded fallbacks are how features "look dead" in
    // the field. The caller has to be able to tell, and to surface it.
    scripted.answers = [{ text: null, error: "all providers failed: 429, 503" }];
    const out = await run();
    expect(out.value).toBeNull();
    expect(out.degraded).toBe(true);
    expect(out.error).toMatch(/429/);
  });

  it("...and it does not burn the retry conjuring a provider", async () => {
    scripted.answers = [{ text: null, error: "no provider available" }];
    await run();
    expect(scripted.seen.length).toBe(1);
  });

  it("a model that answers badly is NOT degraded - that is a prompt bug", async () => {
    scripted.answers = [
      { text: "{}", provider: "gemini" },
      { text: "{}", provider: "gemini" },
    ];
    const out = await run();
    expect(out.degraded).toBe(false);
    expect(out.provider).toBe("gemini");
  });
});

describe("the prompt asks about MEANING, not vocabulary", () => {
  it("it tells the model to judge intent, and forbids invention", async () => {
    scripted.answers = [{ text: '{"wantsCall": true, "confidence": 1}', provider: "groq" }];
    await run("ring me na");
    const system = scripted.seen[0];
    expect(system).toMatch(/Judge what the sender MEANS, not which words they used/);
    expect(system).toMatch(/NEVER invent a fact the message does not contain/);
    // The shop's own words reach the model verbatim - no normalisation step
    // gets to decide what is worth passing on.
    expect(system).toMatch(/ring me na/);
  });
});
