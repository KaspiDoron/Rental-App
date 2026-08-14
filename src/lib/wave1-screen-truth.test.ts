import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// WAVE 1 (owner report 5) - THE SCREEN TELLS THE TRUTH IT ALREADY KNOWS.
//
// "No price yet - your agent is asking for one" was the else-branch of one
// boolean (vendor_replies.found) while the app KNEW the price in four other
// places: the thread's standing field, the photographed board (raw.reading -
// already used as rival leverage in OTHER shops' threads!), the derived option
// menu, and the reply text itself. These pins hold the whole path together:
// server rollup -> client admission -> card provenance. Each assertion fails on
// a revert of its edit.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("/api/replies - the effective price consults every source, in trust order", () => {
  const src = read("src/app/api/replies/route.ts");

  it("reads the photographed board's prices (raw->reading) for the card", () => {
    expect(src).toMatch(/reading:raw->reading/);
    expect(src).toMatch(/readingPricesByVendor/);
  });

  it("computes effectivePrice: thread field, then menu photo, then derived menu", () => {
    const block = src.slice(src.indexOf("const effectivePrice"));
    const thread = block.indexOf('"thread"');
    const photo = block.indexOf('"menu-photo"');
    const menu = block.indexOf('"menu"', photo + 12);
    expect(thread).toBeGreaterThan(-1);
    expect(photo).toBeGreaterThan(thread);
    expect(menu).toBeGreaterThan(photo);
    // Only when the row itself has nothing - a confirmed price wins outright.
    expect(block).toMatch(/if \(r\.found && r\.price_per_day\) return null/);
  });

  it("ships it to the client on every reply row", () => {
    expect(src).toMatch(/effectivePrice,\s*[\r\n]\s*createdAt/);
  });
});

describe("the client ADMITS a sourced price instead of dropping the row", () => {
  const page = read("src/app/page.tsx");

  it("a row with an effectivePrice is no longer skipped", () => {
    // The old drop: `if (!r.found || !r.pricePerDay) continue;` - which threw
    // away everything ON the row (options, thread price, board price).
    expect(page).not.toMatch(/if \(!r\.found \|\| !r\.pricePerDay\) continue;/);
    expect(page).toMatch(/if \(!confirmed && !r\.effectivePrice\?\.pricePerDay\) continue;/);
  });

  it("a confirmed row always outranks a sourced one, whatever the timestamps", () => {
    expect(page).toMatch(/\(confirmed && !curConfirmed\)/);
  });

  it("a sourced price never replaces a confirmed offer and never inflates the round", () => {
    expect(page).toMatch(/if \(!confirmedRow && v\.offer && !v\.offer\.priceSource\) return v;/);
    expect(page).toMatch(/confirmedRow \? v\.offer\.round \+ 1 : v\.offer\.round/);
  });
});

describe("provenance is DISCLOSED wherever the price shows", () => {
  it("the vendor card says where a sourced price came from", () => {
    const card = read("src/components/VendorCard.tsx");
    expect(card).toMatch(/offer\.priceSource/);
    expect(card).toMatch(/price-menu photo/);
  });

  it("the status panel carries the provenance chip", () => {
    const page = read("src/app/page.tsx");
    expect(page).toMatch(/from menu photo/);
    expect(page).toMatch(/from price menu/);
  });
});

describe("the deposit chip shows EVERY alternative (owner report 5 #9)", () => {
  it("the status panel renders depositSummary, not the legacy single enum", () => {
    const page = read("src/app/page.tsx");
    // The exact literal that reported "passport or money4000" as passport-only.
    expect(page).not.toMatch(
      /depositType === "passport" \? t\("Passport deposit"\) : v\.offer\.deposit/
    );
    expect(page).toMatch(/depositSummary\(/);
  });

  it("the compare sheet uses the same shared summary", () => {
    const sheet = read("src/components/will/CompareSheet.tsx");
    expect(sheet).toMatch(/depositSummary\(/);
    expect(sheet).not.toMatch(/o\.depositType === "passport"\s*\?\s*t\("passport"\)/);
  });
});

describe("the draft popup's language belongs to the HUNT (owner report 5 #14)", () => {
  it("the modal renders language chips only on a local-language hunt", () => {
    const modal = read("src/components/BargainDraftModal.tsx");
    // No more invented default from a tier literal...
    expect(modal).not.toMatch(/isUltra \? "local" : "english"/);
    expect(modal).not.toMatch(/const isUltra = plan === "ultra"/);
    // ...the default follows the session, gated by the shared predicate...
    expect(modal).toMatch(/sessionLocalLang && localEntitled \? "local" : "english"/);
    expect(modal).toMatch(/can\(plan, "local-language"\)/);
    // ...and the whole chip row is conditional on the hunt being local.
    expect(modal).toMatch(/\{sessionLocalLang && \(/);
  });

  it("page.tsx passes the hunt's language state down", () => {
    expect(read("src/app/page.tsx")).toMatch(/sessionLocalLang=\{localLangActive\}/);
  });

  it("/api/bargain-draft resolves the thread's established language like the send path", () => {
    const route = read("src/app/api/bargain-draft/route.ts");
    expect(route).toMatch(/threadLanguageMode/);
    expect(route).toMatch(/resolveThreadLanguage/);
    expect(route).toMatch(/localLanguage: composeLocal/);
    expect(route).toMatch(/languageUsed/);
  });
});

describe("the gloss is visible everywhere (owner report 5 #15)", () => {
  // W1.5: a local-language bargain must be readable by the traveller on EVERY
  // surface that quotes it - status panel, cards, feed, trips, map, draft
  // modal - not only inside the full-conversation transcript. One doctrine:
  // the REAL text on the wire stays primary, the English gloss is a second
  // quiet line when it differs. Key facts these pins rest on: inbound rows
  // carry raw.english (agent-loop stamps it), outbound rows carry
  // raw.englishGloss (the outbox meta key every send path spreads).

  it("vendor_replies carries english_gloss (the root data gap)", () => {
    const schema = read("supabase/schema.sql");
    expect(schema).toMatch(
      /alter table public\.vendor_replies add column if not exists english_gloss text;/
    );
  });

  it("the agent loop stamps the SAME inbound gloss onto the vendor_replies row", () => {
    const loop = read("src/lib/agent-loop.ts");
    // Best-effort follow-up on the row this turn just wrote (the gloss is
    // computed after the insert), inside the inbound-gloss block.
    const block = loop.slice(loop.indexOf('finishBeforeResponse("inbound-gloss"'));
    expect(block).toMatch(/sbUpdate\("vendor_replies", `id=eq\.\$\{vr\[0\]\.id\}`, \{ english_gloss: english \}\)/);
  });

  it("/api/replies selects english_gloss (first tier only) and returns it as `english`", () => {
    const route = read("src/app/api/replies/route.ts");
    expect(route).toMatch(/select=id,vendor_id,vendor_name,reply_text,english_gloss,found/);
    expect(route).toMatch(/english: r\.english_gloss \?\? null/);
    // The degrade tiers survive WITHOUT the new column (pre-migration feed).
    expect(route).toMatch(
      /select=id,vendor_id,vendor_name,reply_text,found,price_per_day,matches_spec,confidence,auto,currency,deposit,delivers,created_at/
    );
  });

  it("the offer rows the client builds carry the gloss (Offer.messageEnglish)", () => {
    const page = read("src/app/page.tsx");
    expect(page).toMatch(/messageEnglish: r\.english\?\.slice\(0, 200\)/);
    expect(read("src/lib/types.ts")).toMatch(/messageEnglish\?: string/);
  });

  it("the status panel renders the gloss under the offer excerpt and the replied excerpt", () => {
    const page = read("src/app/page.tsx");
    // Offers & negotiations: raw shop words + gloss line.
    expect(page).toMatch(/v\.offer\.messageEnglish\.trim\(\) !== v\.offer\.message\.trim\(\)/);
    // Replied - your agent is on it: same doctrine on lastInboundText.
    expect(page).toMatch(/v\.lastInboundEnglish\.trim\(\) !== v\.lastInboundText\.trim\(\)/);
  });

  it("the activity client consumes lastOutboundText (it was silently dropped)", () => {
    const page = read("src/app/page.tsx");
    expect(page).toMatch(/lastOutboundText\?: string/);
    expect(page).toMatch(/sentText: last\.lastOutboundText/);
    // The gloss travels WITH its text - a newer English send clears the old gloss.
    expect(page).toMatch(/sentGloss: last\.lastOutboundText \? last\.lastOutboundEnglish/);
    // ...and the Awaiting-reply panel shows the REAL sent text, gloss second.
    expect(page).toMatch(/\{v\.sentText && <div className="line-clamp-2">📤 \{v\.sentText\}<\/div>\}/);
  });

  it("the feed shows the REAL text with the gloss beside it - never gloss-instead", () => {
    const route = read("src/app/api/activity/route.ts");
    // The old outbound gloss-instead read (which keyed on the inbound key
    // raw.english and so never fired) is gone in both places it lived.
    expect(route).not.toMatch(/m\.raw\?\.english \|\| m\.body/);
    // Outbound: detail = the real body, english = the outbound gloss key.
    expect(route).toMatch(/detail: \(m\.body \|\| ""\)\.slice\(0, 220\)/);
    expect(route).toMatch(/english: m\.raw\?\.englishGloss\?\.slice\(0, 220\)/);
    // Inbound reply items carry the stored gloss.
    expect(route).toMatch(/english: r\.english_gloss\?\.slice\(0, 220\)/);
    // The raw-inbound fallback query SELECTS the stored gloss (raw->>english),
    // so a reply whose agent turn has not run yet still shows its translation.
    expect(route).toMatch(/english:raw->>english/);
    expect(route).toMatch(/lastInboundEnglish = m\.english\?\.slice\(0, 240\)/);
    // And the feed client renders the second quiet line.
    const feed = read("src/components/activity/ActivityFeed.tsx");
    expect(feed).toMatch(/it\.english && it\.english\.trim\(\) !== it\.detail\.trim\(\)/);
  });

  it("ThreadPeek's always-visible one-line preview is gloss-first", () => {
    const peek = read("src/components/ThreadPeek.tsx");
    expect(peek).toMatch(/const preview = gloss && gloss !== msg\.text\.trim\(\) \? gloss : msg\.text/);
    expect(peek).toMatch(/summarize\(waPlain\(preview\)\)/);
    // ...and the card's SEEDED first reply carries the gloss too.
    expect(peek).toMatch(/fallbackReceivedEnglish/);
    expect(read("src/components/VendorCard.tsx")).toMatch(
      /fallbackReceivedEnglish=\{offer\?\.messageEnglish\}/
    );
  });

  it("the trips timeline shows shop replies (and agent sends) with the gloss", () => {
    const route = read("src/app/api/deals/route.ts");
    expect(route).toMatch(/english_gloss/);
    expect(route).toMatch(/english: r\.english_gloss\?\.slice\(0, 90\)/);
    // Agent sends: real body as text, gloss beside it (undefined for the
    // traveller's own human-manual rows, whose text is a label).
    expect(route).toMatch(/english: human \? undefined : m\.raw\?\.englishGloss\?\.slice\(0, 90\)/);
    expect(route).not.toMatch(/m\.raw\?\.english \|\| m\.body/);
    const page = read("src/app/deals/page.tsx");
    expect(page).toMatch(/e\.english && e\.english\.trim\(\) !== e\.text\.trim\(\)/);
  });

  it("BargainDraftModal shows the draft's English gloss before the traveller approves it", () => {
    const modal = read("src/components/BargainDraftModal.tsx");
    expect(modal).toMatch(/data\.english/);
    expect(modal).toMatch(/\{gloss && !edited &&/);
  });

  it("the map cards carry the shop's last line + gloss", () => {
    const map = read("src/components/MapView.tsx");
    expect(map).toMatch(/lastLineEnglish\.trim\(\) !== lastLine\.trim\(\)/);
  });
});
