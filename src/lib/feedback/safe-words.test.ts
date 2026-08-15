import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  containsAbuse,
  abuseKind,
  matchesAny,
  ABUSE_PATTERNS,
  OUTBOUND_BLOCKLIST,
} from "../safety/blocklist";
import { normalizeVerdict } from "./verdict";

// W6.2 - "Don't allow to add curses / language which is not good behavior - we
// want safe words feedback page." (owner report 5, item 18)
//
// There was NO profanity or abuse filter anywhere in the feedback pipeline. The
// repo's only blocklist lived inside `runSafety`, which guards outbound
// WhatsApp and is called by no feedback route; the triage prompt was not asked
// to notice abuse; and a negative triage verdict blocked NOTHING - the row went
// in and the text was rendered verbatim to the owner.

describe("the deterministic floor", () => {
  it("catches the words the owner meant", () => {
    for (const bad of [
      "this app is fucking broken",
      "you are an idiot",
      "you people are useless",
      "shitty little app",
      "I will kill you",
    ]) {
      expect(containsAbuse(bad), bad).toBe(true);
    }
  });

  // EVERY STRING BELOW WAS PROVED LIVE AGAINST THE OLD FLOOR, with no LLM key
  // configured - i.e. in exactly the configuration the floor exists for. All of
  // them were accepted with HTTP 200, stored, and rendered to the owner.
  it("catches obfuscation - the normal way abuse is actually typed", () => {
    for (const bad of [
      "fuk you",
      "your app is f*cking broken",
      "fvck this",
      "phuck your support",
      "you are an a$$hole",
      "f.u.c.k this app",
      "f u c k you",
      "sh1t app",
      "b4stards",
    ]) {
      expect(containsAbuse(bad), bad).toBe(true);
    }
  });

  it("catches slurs - a whole family the list simply did not have", () => {
    for (const bad of ["you retard", "what a faggot", "n1gger", "you are a retard", "retarded app team"]) {
      expect(containsAbuse(bad), bad).toBe(true);
    }
  });

  it("catches a VEILED threat, which contains no threatening word at all", () => {
    for (const bad of [
      "I know where you live",
      "we know where you work",
      "watch your back",
      "I will find you",
      "I will get you for this",
    ]) {
      expect(containsAbuse(bad), bad).toBe(true);
    }
  });

  it("catches directed personal insults the old list had no noun for", () => {
    for (const bad of ["you are a dick", "you are a prick", "you people are scumbags", "whore"]) {
      expect(containsAbuse(bad), bad).toBe(true);
    }
  });

  it("names the FAMILY, so the refusal is not always about swearing", () => {
    expect(abuseKind("I know where you live")).toBe("threat");
    expect(abuseKind("n1gger")).toBe("hate");
    expect(abuseKind("you are an idiot")).toBe("insult");
    expect(abuseKind("f*ck this")).toBe("profanity");
    expect(abuseKind("the map is blank on iOS")).toBeNull();
  });

  it("normalisation does not eat word boundaries - the Scunthorpe rule", () => {
    for (const fine of [
      "Scunthorpe pickup was fine",
      "the flame retardant seat cover is torn",
      "shiitake mushrooms at the shop next door",
      "the bus hit a pothole and the app crashed",
      "I had to kill the app to get it working",
      "this is a fake shop listing",
      "please classify this as a bug",
      // OUTBOUND SENTENCES THE AGENT REALLY WRITES. This list is a superset for
      // the WhatsApp guard, so a threat pattern that eats an offer would gag
      // the negotiator - and "come to your hotel" IS the delivery product.
      "I will find you a better price",
      "I will get you two more quotes today",
      "the shop can come to your hotel with the scooter",
      "they will deliver to your room in the morning",
    ]) {
      expect(containsAbuse(fine), fine).toBe(false);
    }
  });

  it("does NOT catch anger at the product - that is the feedback we want", () => {
    for (const fine of [
      "This is terrible, nothing works and I want a refund",
      "The map is broken on my phone and I am furious about it",
      "Worst experience, the shop never replied",
      // THE FILTER MUST NOT BECOME A COMPLAINT FILTER. These are blunt product
      // judgements, which is exactly the feedback the owner asked to receive -
      // and they ARE refused on the outbound path, where the reader is a shop.
      "the price radar is useless and feels like a scam",
      "this whole flow is stupid",
      // The audit's own false-positive guards: ordinary rental complaints.
      "this shop screwed me",
      "the scooter was crap",
      "the shop was a nightmare and I lost a day",
    ]) {
      expect(containsAbuse(fine), fine).toBe(false);
    }
  });

  it("is one list, not two copies - outbound extends the same patterns", () => {
    // The whole reason it moved out of agents.ts: a word added for one surface
    // has to protect the other by construction.
    for (const rx of ABUSE_PATTERNS) expect(OUTBOUND_BLOCKLIST).toContain(rx);
    // ...and the contact-prying rule is outbound-only. "email me at x" is a
    // normal, welcome thing for a bug reporter to write.
    expect(OUTBOUND_BLOCKLIST.length).toBeGreaterThan(ABUSE_PATTERNS.length);
    expect(containsAbuse("my personal email is a@b.com if you need more")).toBe(false);
    expect(matchesAny("what is your whatsapp, the personal one?", OUTBOUND_BLOCKLIST)).toBe(true);
    // ...and so are the blunt judgement words, which a shop must never be sent
    // but a bug report may freely contain.
    expect(matchesAny("this is a scam", OUTBOUND_BLOCKLIST)).toBe(true);
    expect(containsAbuse("this is a scam")).toBe(false);
  });

  it("blank text is not abuse", () => {
    expect(containsAbuse("")).toBe(false);
    expect(containsAbuse("   ")).toBe(false);
  });

  it("the patterns are stateless - a shared regex must not carry /g", () => {
    // A /g flag on a module-level constant makes `test` alternate true/false
    // across calls, which would let every second abusive report through.
    for (const rx of OUTBOUND_BLOCKLIST) expect(rx.flags).not.toContain("g");
    expect(containsAbuse("you idiot")).toBe(true);
    expect(containsAbuse("you idiot")).toBe(true);
  });
});

describe("moderateFeedback: model first, floor underneath", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("refuses on the floor without ever calling a model", async () => {
    const parse = vi.fn();
    vi.doMock("../semantic/parse", () => ({ semanticParse: parse }));
    const { moderateFeedback } = await import("./moderation");
    const v = await moderateFeedback("your app is fucking useless");
    expect(v.allowed).toBe(false);
    expect(v.source).toBe("blocklist");
    expect(parse).not.toHaveBeenCalled();
    // The refusal is polite and does not quote the abuse back at them.
    expect(v.message).toBeTruthy();
    expect(v.message).not.toMatch(/fucking/);
  });

  it("refuses on the MODEL's judgement for words no list has", async () => {
    vi.doMock("../semantic/parse", () => ({
      semanticParse: async () => ({
        value: { abusive: true, kind: "insult", reason: "insults the developer" },
        degraded: false,
        attempts: 1,
      }),
    }));
    const { moderateFeedback } = await import("./moderation");
    const v = await moderateFeedback("whoever built this is a complete waste of oxygen");
    expect(v.allowed).toBe(false);
    expect(v.source).toBe("model");
    expect(v.kind).toBe("insult");
  });

  it("a model outage does NOT close the feedback box", async () => {
    vi.doMock("../semantic/parse", () => ({
      semanticParse: async () => ({ value: null, degraded: true, attempts: 0 }),
    }));
    const { moderateFeedback } = await import("./moderation");
    const v = await moderateFeedback("the search spinner never stops on iOS");
    expect(v.allowed).toBe(true);
    expect(v.source).toBe("clean");
  });

  it("a thrown moderator does not take the report down either", async () => {
    vi.doMock("../semantic/parse", () => ({
      semanticParse: async () => {
        throw new Error("boom");
      },
    }));
    const { moderateFeedback } = await import("./moderation");
    expect((await moderateFeedback("the map is blank")).allowed).toBe(true);
  });

  it("...but the floor still bites during that outage", async () => {
    vi.doMock("../semantic/parse", () => ({
      semanticParse: async () => {
        throw new Error("boom");
      },
    }));
    const { moderateFeedback } = await import("./moderation");
    expect((await moderateFeedback("you idiot, fix it")).allowed).toBe(false);
  });
});

describe("the triage verdict can no longer crash the route", () => {
  it("a verdict missing `severity` is coerced, not dereferenced", () => {
    // `verdict.severity.toUpperCase()` in the escalation subject threw a
    // TypeError AFTER the row was inserted: the user saw "Something went
    // wrong", nothing was escalated, and re-submitting duplicated the row.
    const v = normalizeVerdict({ isRealIssue: true, summary: "map blank" }, "the map is blank");
    expect(v.severity).toBe("medium");
    expect(() => v.severity.toUpperCase()).not.toThrow();
  });

  it("garbage does not become a silent spam filter", () => {
    // When we cannot tell, the report reaches a human. The opposite default
    // would turn a malformed model answer into a shredder.
    expect(normalizeVerdict(null, "the map is blank").isRealIssue).toBe(true);
    expect(normalizeVerdict("nope", "x").isRealIssue).toBe(true);
  });

  it("keeps a good verdict exactly as given", () => {
    const good = { isRealIssue: false, severity: "high" as const, summary: "s", reason: "r" };
    expect(normalizeVerdict(good, "body")).toEqual(good);
  });

  it("always has a summary an email subject can use", () => {
    expect(normalizeVerdict({}, "  the booking sheet will not close  ").summary).toBe(
      "the booking sheet will not close"
    );
    expect(normalizeVerdict({}, "").summary).toBe("feedback");
  });
});

// ---------------------------------------------------------------------------
// THE WIRING.
// ---------------------------------------------------------------------------

const code = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const route = code("src/app/api/feedback/route.ts");
const adminRoute = code("src/app/api/admin/feedback/route.ts");
// RAW, not comment-stripped: FeedbackModal contains `accept="image/*"`, which
// a naive block-comment stripper reads as an opening delimiter and then eats
// half the component. Every assertion below is on code shapes, and the two
// negative ones name API calls that never appear in prose.
const modal = readFileSync(join(process.cwd(), "src/components/FeedbackModal.tsx"), "utf8");

describe("the pipeline actually runs the filter", () => {
  it("moderation happens BEFORE the row is written", () => {
    const mod = route.indexOf("moderateFeedback(");
    const insert = route.indexOf('sbInsertReturning<{ id: number }>("feedback"');
    expect(mod).toBeGreaterThan(-1);
    expect(mod).toBeLessThan(insert);
  });

  it("a refused report is never stored and says so", () => {
    expect(route).toMatch(/rejected: "language"/);
    expect(route).toMatch(/stored: false/);
  });

  it("the triage answer goes through zod before anything reads it", () => {
    expect(route).toMatch(/normalizeVerdict\(await triageFeedback\(/);
  });

  it("the client shows the refusal as an answer, not as a crash", () => {
    expect(modal).toMatch(/data\?\.rejected === "language"/);
    expect(modal).toMatch(/s: "blocked"/);
  });
});

describe("the reporter can actually see the answers", () => {
  it("the honest `stored` flag reaches the screen", () => {
    expect(modal).toMatch(/stored: data\.stored !== false/);
    expect(modal).toMatch(/could not save your copy/);
  });

  it("an anonymous submission is told it is a dead end", () => {
    expect(route).toMatch(/const anonymous = !email;/);
    expect(modal).toMatch(/anonymous: Boolean\(data\.anonymous\)/);
    expect(modal).toMatch(/You are signed out\./);
  });

  it("unread comes from the dead column, which is no longer dead", () => {
    expect(route).toMatch(/user_seen_at/);
    expect(route).toMatch(/export async function PATCH/);
    expect(modal).toMatch(/Number\(data\.unread \?\? 0\) > 0/);
    // ...and no device-local stamp survives.
    expect(modal).not.toMatch(/localStorage\.(get|set)Item/);
  });

  it("the PATCH can never stamp somebody else's report", () => {
    expect(route).toMatch(/reporter_email=eq\.\$\{me\}/);
  });
});

describe("categories finally do something", () => {
  it("the owner's inbox filters and counts by category", () => {
    expect(adminRoute).toMatch(/searchParams\.get\("category"\)/);
    expect(adminRoute).toMatch(/byCategory/);
    expect(adminRoute).toMatch(/category=eq\./);
  });

  it("the counts are computed over the WHOLE table, not the filtered page", () => {
    // Otherwise activating a filter would zero out every other chip.
    const counts = adminRoute.indexOf("for (const r of allCategories)");
    expect(counts).toBeGreaterThan(-1);
  });

  it("the reporter's own list filters too", () => {
    expect(modal).toMatch(/const shown = pick === "all"/);
  });
});

describe("the admin inbox no longer inlines every screenshot", () => {
  it("caps images per report and in total", () => {
    expect(adminRoute).toMatch(/IMAGES_PER_REPORT = \d+/);
    expect(adminRoute).toMatch(/IMAGES_TOTAL = \d+/);
    expect(adminRoute).not.toMatch(/data_url&feedback_id=in\.\(\$\{withImages\.join\(","\)\}\)&limit=200/);
  });

  it("still reports how many exist, so nothing is silently hidden", () => {
    expect(adminRoute).toMatch(/imageCount: r\.image_count/);
  });
});

describe("the owner can actually SLICE the inbox by category (W6.2 UI wiring)", () => {
  // The server side shipped category filtering + whole-table counts, and the
  // panel rendered neither - so "categorized properly" stopped at the API.
  const admin = readFileSync(join(process.cwd(), "src/app/admin/page.tsx"), "utf8");

  it("the panel holds the category state and seeds it from the route", () => {
    expect(admin).toMatch(/setFeedbackByCategory\(fb\.byCategory \?\? \{\}\)/);
    expect(admin).toMatch(/const \[feedbackCategory, setFeedbackCategory\]/);
  });

  it("picking a category REFETCHES rather than filtering one page", () => {
    // Filtering the loaded page would silently truncate a busy category at the
    // 100-row window; the route filters in the query for exactly that reason.
    expect(admin).toMatch(/\/api\/admin\/feedback\$\{value \? `\?category=/);
  });

  it("a withheld screenshot says so instead of vanishing", () => {
    expect(admin).toMatch(/f\.image_count > \(f\.images\?\.length \?\? 0\)/);
    expect(admin).toMatch(/more/);
  });
});
