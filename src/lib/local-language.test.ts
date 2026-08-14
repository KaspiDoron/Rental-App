import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { countryForShop, regionForShop } from "./copy/region";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// OWNER REPORT 4, ITEM 8: "bargain in local language" must work END TO END -
// and it only worked in four countries. regionForShop (a SE-Asia greeting
// flavor lookup) was the only thing feeding the language decision, so a +52
// Mexico shop got fluent English with an event blaming "AI localization
// unavailable" - the AI was never asked.

const chatMock = vi.hoisted(() => ({ fn: vi.fn(async (): Promise<string | null> => null) }));
vi.mock("server-only", () => ({}));
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
  sbInsert: vi.fn(async () => true),
  sbUpdate: vi.fn(async () => true),
  sbDelete: vi.fn(async () => true),
  getConfig: vi.fn(async () => undefined),
  getConfigExact: vi.fn(async () => undefined),
  setConfig: vi.fn(async () => ({ ok: true, persistent: true })),
}));

import {
  localizeMessage,
  composeBargain,
  looksEnglish,
  threadPrefersEnglish,
  translateToEnglish,
} from "./agents";

beforeEach(() => {
  chatMock.fn.mockReset();
  chatMock.fn.mockResolvedValue(null);
});

describe("countryForShop - the language decision covers the whole map", () => {
  it("resolves far beyond the four SE-Asia flavor markets", () => {
    expect(countryForShop("5215512345678")).toBe("Mexico");
    expect(countryForShop("66812345678")).toBe("Thailand");
    expect(countryForShop("33612345678")).toBe("France");
    expect(countryForShop("905301234567")).toBe("Turkey");
    expect(countryForShop("818012345678")).toBe("Japan");
    expect(countryForShop("5491112345678")).toBe("Argentina");
  });

  it("English-speaking countries resolve too - localizeMessage declines them itself", () => {
    expect(countryForShop("14155551234")).toBe("United States");
    expect(countryForShop("447911123456")).toBe("United Kingdom");
    expect(countryForShop("6591234567")).toBe("Singapore");
  });

  it("longest prefix wins and leading zeros/punctuation are stripped", () => {
    expect(countryForShop("+972-50-1234567")).toBe("Israel"); // 972, never 9
    expect(countryForShop("0066812345678")).toBe("Thailand");
    expect(countryForShop("8551234567")).toBe("Cambodia"); // 855, never 85
  });

  it("falls back to the label, then to undefined - never a guess", () => {
    expect(countryForShop("999123", "Tulum, Mexico")).toBe("Tulum, Mexico");
    expect(countryForShop("", "")).toBeUndefined();
  });

  it("regionForShop keeps its narrow flavor role untouched", () => {
    expect(regionForShop("66812345678")).toBe("thailand");
    expect(regionForShop("5215512345678")).toBeUndefined(); // flavor only - by design
  });
});

describe("localizeMessage - honest reasons, executed (Mexico + Thailand)", () => {
  it("MEXICO: a Spanish rewrite with preserved numbers goes through", async () => {
    chatMock.fn.mockResolvedValue(
      JSON.stringify({
        message: "Hola! Me puedes hacer 300 al día por los 5 días?",
        english: "Hi! Can you do 300 a day for the 5 days?",
      })
    );
    const out = await localizeMessage("Can you do 300 a day for the 5 days?", "Mexico");
    expect(out.localized).toBe(true);
    expect(out.text).toContain("300");
    expect(out.english).toContain("300");
  });

  it("THAILAND: same path, and the region string reaches the prompt", async () => {
    chatMock.fn.mockResolvedValue(
      JSON.stringify({ message: "ลดเหลือ 250 ได้ไหมครับ", english: "can you do 250?" })
    );
    const out = await localizeMessage("Could you do 250 a day?", "Ko Tao, Thailand");
    expect(out.localized).toBe(true);
    expect(JSON.stringify(chatMock.fn.mock.calls[0])).toContain("Ko Tao, Thailand");
  });

  it("a drifted number is refused twice and named as the reason", async () => {
    chatMock.fn.mockResolvedValue(
      JSON.stringify({ message: "puedo pagar 350 al día señor amigo", english: "350 a day" })
    );
    const out = await localizeMessage("Can you do 300 a day?", "Mexico");
    expect(out.localized).toBe(false);
    expect(out.reason).toBe("numbers-drifted");
    expect(out.text).toContain("300"); // the English fallback quotes the RIGHT number
  });

  it("an unreachable AI is 'ai-unavailable' - a missing region is NOT", async () => {
    expect((await localizeMessage("Can you do 300?", "Mexico")).reason).toBe("ai-unavailable");
    const noRegion = await localizeMessage("Can you do 300?", undefined);
    expect(noRegion.reason).toBe("no-region");
    const english = await localizeMessage("Can you do 300?", "Singapore");
    expect(english.reason).toBe("english-region");
    // Neither decline ever spent an LLM call.
    expect(chatMock.fn).toHaveBeenCalledTimes(2); // only the Mexico attempts
  });
});

describe("the language-adaptation flip is a THREAD statement", () => {
  it("looksEnglish requires English, not merely Latin script", () => {
    expect(looksEnglish("Hi Doron, do you speak English?")).toBe(true);
    expect(looksEnglish("We have Honda Click, best price today")).toBe(true);
    // Indonesian/Tagalog are 100% ASCII - they must NOT read as English.
    expect(looksEnglish("bisa 150rb per hari bos")).toBe(false);
    expect(looksEnglish("meron po kami maganda motor")).toBe(false);
    expect(looksEnglish("สวัสดีครับ มีรถว่างครับ")).toBe(false);
  });

  it("one English line in a local thread does not flip the reply", () => {
    const thaiThread = ["สวัสดีครับ", "มีรถ Fazzio ครับ 300 บาท"];
    expect(threadPrefersEnglish("Do you speak English my friend?", thaiThread)).toBe(false);
  });

  it("two consecutive English inbounds DO flip - the shop demonstrated it", () => {
    const mixed = ["สวัสดีครับ", "Yes we have the bike for you my friend"];
    expect(threadPrefersEnglish("What is your best price for the week?", mixed)).toBe(true);
  });

  it("a thread OPENED in English adapts at once", () => {
    expect(threadPrefersEnglish("Hello, do you have a scooter for tomorrow?", [])).toBe(true);
  });

  it("the engines consume the thread-level test, not the per-turn one", () => {
    expect(readCode("src/lib/graph/engine.ts")).toMatch(
      /threadPrefersEnglish\(input\.event\.shopMessage, input\.priorInbound \?\? \[\]\)/
    );
    expect(readCode("src/lib/agent-loop.ts")).toMatch(
      /!threadPrefersEnglish\(text, priorInboundBodies\)/
    );
  });
});

describe("the gloss dead band is closed", () => {
  it("mixed text below the Latin bar is glossed now (was the 0.7-0.9 hole)", async () => {
    chatMock.fn.mockResolvedValue("ok 200 for tomorrow");
    // ~0.76 ASCII letters: not English enough to adapt, foreign enough to gloss.
    const out = await translateToEnglish("ok 200 for tomorrow ครับผม");
    expect(out).toBe("ok 200 for tomorrow");
    expect(chatMock.fn).toHaveBeenCalledTimes(1);
  });

  it("Latin-dominant text still skips the gloss without an LLM call", async () => {
    expect(await translateToEnglish("hello my friend how are you")).toBeNull();
    expect(chatMock.fn).not.toHaveBeenCalled();
  });

  it("ONE constant governs both decisions", () => {
    const agents = readCode("src/lib/agents.ts");
    expect(agents).toMatch(/export const LATIN_DOMINANT = 0\.9/);
    expect(agents).toMatch(/ascii\.length \/ letters\.length < LATIN_DOMINANT/);
    expect(agents).toMatch(/ascii\.length \/ letters\.length >= LATIN_DOMINANT/);
  });
});

describe("composeBargain never flips a local thread to English silently", () => {
  const baseOpts = {
    rfq: { vehicleClass: "scooter", durationDays: 5 } as never,
    vendor: { name: "Ko Tao Bikes" } as never,
    currentPricePerDay: 400,
    targetPricePerDay: 300,
    round: 0,
    currency: "THB",
  };

  it("AI down + localizer down on a Thai thread -> flagged, so AUTO suppresses", async () => {
    const draft = await composeBargain({ ...baseOpts, localLanguage: true, region: "Thailand" });
    expect(draft.fallback).toBe(true);
    expect(draft.localizeFailed).toBe(true);
    expect(draft.message.length).toBeGreaterThan(10); // interactive callers still get a draft
  });

  it("an English-speaking region keeps the plain English fallback, unflagged", async () => {
    const draft = await composeBargain({ ...baseOpts, localLanguage: true, region: "Singapore" });
    expect(draft.fallback).toBe(true);
    expect(draft.localizeFailed).toBeUndefined();
  });

  it("the AUTO callers actually suppress on the flag", () => {
    const nodes = readCode("src/lib/graph/nodes.ts");
    expect(nodes).toMatch(/if \(draft\.localizeFailed\)/);
    expect(nodes).toMatch(/countryForShop\(input\.event\.toDigits\)/);
    const loop = readCode("src/lib/agent-loop.ts");
    expect(loop).toMatch(/if \(draft\.localizeFailed\)/);
    expect(loop).toMatch(/countryForShop\(from\)/);
  });
});

describe("honest events on every path", () => {
  it("the reply paths emit localize-fallback with the true reason", () => {
    expect(readCode("src/lib/graph/engine.ts")).toMatch(/path: "engine-reply"/);
    expect(readCode("src/lib/agent-loop.ts")).toMatch(/path: "legacy-reply"/);
  });

  it("the false hardcoded AI blame is gone from the outreach routes", () => {
    const one = readCode("src/app/api/outreach/route.ts");
    const mass = readCode("src/app/api/outreach/mass/route.ts");
    expect(one).not.toMatch(/AI localization unavailable after retry/);
    expect(mass).not.toMatch(/AI localization unavailable after retry/);
    expect(one).toMatch(/reason: localized\.reason \?\? "ai-unavailable"/);
    expect(mass).toMatch(/reason: localized\.reason \?\? "ai-unavailable"/);
    // ...and both opener paths ask the full country map for the language.
    expect(one).toMatch(/countryForShop\(digits/);
    expect(mass).toMatch(/countryForShop\(shopDigits/);
  });

  it("a deterministic repair on localized text re-glosses instead of blinding", () => {
    const engine = readCode("src/lib/graph/engine.ts");
    expect(engine).toMatch(/let glossInvalidated = false/);
    const sets = engine.match(/glossInvalidated = true/g) ?? [];
    expect(sets.length).toBe(4); // duration, commitment, hard-constraint, numeric
    expect(engine).toMatch(/finishBeforeResponse\("outbound-regloss"/);
    expect(engine).toMatch(/translateToEnglish\(finalText\)/);
  });
});
