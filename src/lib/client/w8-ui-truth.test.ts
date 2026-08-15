import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

import { I18N_CATALOG } from "../i18n-catalog";
import { reconcileMessages } from "../../components/useTranscriptScroll";
import type { ThreadMsg } from "../../components/MessageBubble";

// ---------------------------------------------------------------------------
// W8 #15: THREE TRAVELLER-FACING SURFACES RENDERED ENGLISH IN 19 LANGUAGES.
// ---------------------------------------------------------------------------
//
// `t()` refuses any string outside the catalogue - deliberately, because an
// uncatalogued string is POSTed to /api/translate and cached into a GLOBALLY
// SHARED row, so unbounded input is a cross-user leak. The consequence is that
// "wrapped in t()" is not the same as "translated": a string the generator
// never saw is silently returned as-is, with no error anywhere.

describe("W8 #15: the server-composed copy is in the catalogue", () => {
  const inCatalog = new Set(I18N_CATALOG);
  const expectAll = (label: string, strings: string[]) => {
    const missing = strings.filter((s) => !inCatalog.has(s));
    expect(missing, `${label}: ${missing.join(" | ")}`).toEqual([]);
  };

  it("every Activity feed title - all of them are authored server-side", () => {
    const route = readFileSync(join(process.cwd(), "src/app/api/activity/route.ts"), "utf8");
    const block = route.slice(
      route.indexOf("const STAGE_TITLES"),
      route.indexOf("interface TraceRow")
    );
    const stageTitles = [...block.matchAll(/:\s*"((?:[^"\\]|\\.)+)",/g)].map((m) =>
      JSON.parse(`"${m[1]}"`)
    );
    expect(stageTitles.length).toBeGreaterThanOrEqual(14);
    expectAll("STAGE_TITLES", stageTitles);
    expectAll("feed titles", [
      "You messaged the shop yourself",
      "Message sent to the shop",
      "The shop replied (with a photo)",
      "The shop replied",
      "Confirmed offer in",
      "Offer in (unconfirmed)",
      "Will is waiting on purpose",
      "A shop shared a contact",
      "Will flagged this reply - please review",
    ]);
  });

  it("a shared contact's NAME is appended, not baked into the title", async () => {
    // A name inside the title makes every occurrence a unique string, which the
    // catalogue can never contain - so that one line was untranslatable by
    // construction. The name is a proper noun and is not translated anyway.
    const route = readCode("src/app/api/activity/route.ts");
    expect(route).not.toMatch(/A shop shared a contact: \$\{/);
    expect(route).toMatch(/sharedName: shared\.name \?\? undefined/);
    const feed = readCode("src/components/activity/ActivityFeed.tsx");
    expect(feed).toMatch(/it\.meta\?\.sharedName \? `: \$\{it\.meta\.sharedName\}` : ""/);
  });

  it("every drop line - title AND detail, a closed set of our own sentences", async () => {
    const { dropFeedItem } = await import("../wa/safety-signals");
    const reasons = [
      "no-rfq-thread",
      "unresolved-identity",
      "empty-media",
      "derived-unattributed",
      "vendor-gate-unavailable",
      "store-failed",
      "sync-turn-failed",
      "sync-error",
      "something-unmapped",
    ];
    const seen: string[] = [];
    for (const r of reasons) {
      const inb = dropFeedItem("inbound-dropped", JSON.stringify({ reason: r }));
      if (inb) seen.push(inb.title, inb.detail);
    }
    for (const r of ["duplicate", "rfq-dedup", "engagement-halt", "other"]) {
      const snd = dropFeedItem("send-dropped", JSON.stringify({ reason: r }));
      if (snd) seen.push(snd.title, snd.detail);
    }
    expect(seen.length).toBeGreaterThan(10);
    expectAll("dropFeedItem", seen);
    // ...and the feed actually passes a drop's detail through t().
    const feed = readCode("src/components/activity/ActivityFeed.tsx");
    expect(feed).toMatch(/it\.kind === "drop" \? t\(it\.detail\) : it\.detail/);
  });

  it("every WhatsApp-safety explainer sentence", async () => {
    const { classifySafety } = await import("../wa/safety-signals");
    const disconnected = classifySafety(
      {
        connection: "close",
        // classifySafety reads neither of these; they are here because
        // SafetySignals requires them, and null is the honest "not measured".
        lastWebhookOkAt: null,
        lastInboundAt: null,
        lastOutboundAt: new Date().toISOString(),
        inboundDropped24h: 0,
        sendDropped24h: 0,
      },
      Date.now()
    );
    const attention = classifySafety(
      {
        connection: "open",
        lastWebhookOkAt: null,
        lastInboundAt: null,
        lastOutboundAt: new Date().toISOString(),
        inboundDropped24h: 2,
        sendDropped24h: 0,
      },
      Date.now()
    );
    expectAll("classifySafety", [disconnected!.publicReason, attention!.publicReason]);
    // senderSafety's own three, read off the source so a reword cannot drift.
    const guard = readFileSync(join(process.cwd(), "src/lib/wa-guard.ts"), "utf8");
    const publicReasons = [...guard.matchAll(/publicReason:\s*\n?\s*"((?:[^"\\]|\\.)+)"/g)].map(
      (m) => JSON.parse(`"${m[1]}"`)
    );
    expect(publicReasons.length).toBeGreaterThanOrEqual(3);
    expectAll("senderSafety", publicReasons);
  });

  it("every queueReasonLabel - the SHORT line on every queued row", async () => {
    const { queueReasonLabel, classifyQueueReason } = await import("../queue-reason");
    const probes = [
      "shop is closed now",
      "paused by you",
      "director hold",
      "batch-spacing",
      "sync-retry",
      "introductions full - refreshes soon",
      "daily introductions done - resumes next morning",
      "cold outreach frozen by the circuit breaker",
      "human pacing gap",
      "held - daily message allowance reached, resumes 14:32",
      "",
    ];
    const kinds = new Set(probes.map((p) => classifyQueueReason(p)));
    // Every classification is exercised, so no label can hide behind a gap.
    expect(kinds.size).toBeGreaterThanOrEqual(10);
    expectAll("queueReasonLabel", probes.map((p) => queueReasonLabel(p)));
    // The queue viewer's own two states.
    expectAll("queue states", ["Sending now", "Sending shortly"]);
    // ...and the badge translates the joined list rather than concatenating raw.
    const badge = readCode("src/components/WaSafetyBadge.tsx");
    expect(badge).toMatch(/publicQueueReasons \?\? \[\]\)\.map\(\(r\) => t\(r\)\)/);
  });

  it("REGRESSION: a daily-cap hold no longer classifies as 'unknown'", async () => {
    const { classifyQueueReason } = await import("../queue-reason");
    // "held - daily message allowance reached" matched none of the classifier's
    // words, so THE cap hold - the one the whole anti-ban budget exists to
    // produce - rendered as a blank "Queued - sends automatically".
    expect(classifyQueueReason("held - daily message allowance reached, resumes 14:32")).toBe(
      "limit"
    );
  });

  it("the BookingSheet is translated - it is where a deposit is committed", () => {
    const raw = readFileSync(join(process.cwd(), "src/components/BookingSheet.tsx"), "utf8");
    const calls = (raw.match(/(?<![A-Za-z0-9_$])t\(/g) ?? []).length;
    // It had TWO translated strings in 570 lines.
    expect(calls).toBeGreaterThan(30);
    const literals = [...raw.matchAll(/(?<![A-Za-z0-9_$])t\("((?:[^"\\]|\\.)*)"\)/g)].map((m) =>
      JSON.parse(`"${m[1]}"`)
    );
    expect(literals.length).toBeGreaterThan(30);
    expectAll("BookingSheet", literals);
  });
});

// ---------------------------------------------------------------------------
// W8 #16: AN OPEN TRANSCRIPT NEVER REPAINTED WHEN THE READING ARRIVED.
// ---------------------------------------------------------------------------

describe("W8 #16: the transcript signature notices a patched-in row", () => {
  const msg = (over: Partial<ThreadMsg> = {}): ThreadMsg =>
    ({
      id: "i1",
      dir: "in",
      text: "[photo]",
      at: "2026-08-15T10:00:00.000Z",
      media: { id: "wa-1", kind: "image" },
      ...over,
    }) as ThreadMsg;

  it("REPRODUCTION: the media reading is patched onto an EXISTING row", () => {
    const before = [msg()];
    const after = [
      msg({
        reading: {
          status: "ok",
          confidence: "high",
        } as unknown as ThreadMsg["reading"],
      }),
    ];
    // Count, first id, last id and the last text's length are all identical -
    // which is every input the old signature had. The sheet kept its old array
    // for its whole life and the Agentic-summary panel never appeared.
    expect(after).toHaveLength(before.length);
    expect(after[0].id).toBe(before[0].id);
    expect(after[0].text.length).toBe(before[0].text.length);
    // ...and the reconcile now returns the NEW array.
    expect(reconcileMessages(before, after)).toBe(after);
  });

  it("the English gloss lands the same way and is noticed too", () => {
    const before = [msg({ text: "300 baht" })];
    const after = [msg({ text: "300 baht", english: "300 baht per day" })];
    expect(reconcileMessages(before, after)).toBe(after);
  });

  it("a genuinely unchanged poll still keeps its array identity", () => {
    // The whole point of the reconcile: an unchanged transcript must not
    // re-run the scroll effect and snap a reader back to the bottom.
    const before = [msg(), msg({ id: "i2", text: "hello" })];
    const after = [msg(), msg({ id: "i2", text: "hello" })];
    expect(reconcileMessages(before, after)).toBe(before);
  });

  it("a reading that DISAPPEARS is noticed as well (no one-way latch)", () => {
    const withReading = [
      msg({ reading: { status: "ok" } as unknown as ThreadMsg["reading"] }),
    ];
    expect(reconcileMessages(withReading, [msg()])).not.toBe(withReading);
  });
});

// ---------------------------------------------------------------------------
// W8 #18/#19: state that colour alone conveyed, and a triple-fetched endpoint.
// ---------------------------------------------------------------------------

describe("W8 #18: toggle and filter state is announced, not just coloured", () => {
  it("the view switcher and the list-axis switcher share one pressed toggle", () => {
    const page = readCode("src/app/page.tsx");
    const btn = page.slice(page.indexOf("function ToggleBtn("), page.length);
    expect(btn.slice(0, 900)).toMatch(/aria-pressed=\{active\}/);
  });

  it("every filter chip in the rail carries its state", () => {
    const filters = readCode("src/components/Filters.tsx");
    const chip = filters.slice(filters.indexOf("function Chip("), filters.indexOf("</button>"));
    expect(chip).toMatch(/aria-pressed=\{active\}/);
  });

  it("the feedback category and status chips too", () => {
    // RAW, not readCode: this file contains accept="image/*", whose `/*` opens
    // a block comment as far as the naive stripper is concerned and swallows
    // the rest of the component.
    const fb = readFileSync(join(process.cwd(), "src/components/FeedbackModal.tsx"), "utf8");
    expect(fb).toMatch(/aria-pressed=\{category === c\.id\}/);
    expect(fb).toMatch(/aria-pressed=\{pick === c\.id\}/);
  });
});

const flight = vi.hoisted(() => ({ calls: 0 }));
vi.mock("./fetch-json", () => ({
  fetchJson: vi.fn(async () => {
    flight.calls++;
    await new Promise((r) => setTimeout(r, 5));
    return { ok: true, status: 200, data: { testMode: true, poll: { activityMs: 9000 } } };
  }),
}));

describe("W8 #19: /api/config/public is fetched once per page load", () => {
  beforeEach(async () => {
    flight.calls = 0;
    const { resetPublicConfigCache } = await import("./public-config");
    resetPublicConfigCache();
  });

  it("three concurrent callers share ONE request", async () => {
    const { loadPublicConfig } = await import("./public-config");
    const [a, b, c] = await Promise.all([
      loadPublicConfig(),
      loadPublicConfig(),
      loadPublicConfig(),
    ]);
    expect(flight.calls).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a.testMode).toBe(true);
  });

  it("a later caller reuses the resolved value rather than re-asking", async () => {
    const { loadPublicConfig } = await import("./public-config");
    await loadPublicConfig();
    await loadPublicConfig();
    expect(flight.calls).toBe(1);
  });

  it("an unreachable endpoint yields the fallback cadence, never a throw", async () => {
    const { loadPublicConfig, PUBLIC_CONFIG_FALLBACK, resetPublicConfigCache } = await import(
      "./public-config"
    );
    resetPublicConfigCache();
    const { fetchJson } = await import("./fetch-json");
    vi.mocked(fetchJson).mockResolvedValueOnce({ ok: false, status: 0, error: "x" } as never);
    const d = await loadPublicConfig();
    expect(d).toEqual(PUBLIC_CONFIG_FALLBACK);
    expect(d.poll.activityMs).toBeGreaterThan(0);
  });

  it("the three traveller-facing consumers all go through it", () => {
    for (const f of [
      "src/app/page.tsx",
      "src/components/AdBanner.tsx",
      "src/components/TestModeBanner.tsx",
    ]) {
      const src = readCode(f);
      expect(src, `${f} still fetches the endpoint directly`).not.toMatch(
        /fetch\("\/api\/config\/public"\)/
      );
      expect(src, `${f} does not use the shared loader`).toMatch(/loadPublicConfig\(\)/);
    }
  });
});

// ---------------------------------------------------------------------------
// W8 #20: the last traveller-facing component painting outside the tokens.
// ---------------------------------------------------------------------------

describe("W8 #20: AgentKillSwitch follows the theme like everything else", () => {
  it("no raw Tailwind palette colour survives", () => {
    const src = readCode("src/components/AgentKillSwitch.tsx");
    // emerald/amber/orange/red-600 do not follow the dark-mode flip - the card
    // kept its light-mode colours on a dark screen.
    expect(src).not.toMatch(/\b(?:bg|text|from|via|to|ring|border)-(?:emerald|amber|orange|slate|gray|zinc|neutral|stone)-/);
    expect(src).not.toMatch(/\btext-red-\d/);
    // ...and the one-off dark: override goes with them: a token IS the dark
    // answer, so nothing states it twice.
    expect(src).not.toMatch(/dark:text-red-/);
  });

  it("it uses the app's own semantic tokens", () => {
    const src = readCode("src/components/AgentKillSwitch.tsx");
    for (const token of ["bg-savings", "bg-warn", "text-brandred", "bg-card2", "text-strong"]) {
      expect(src, `${token} missing`).toContain(token);
    }
  });

  it("those tokens are defined for BOTH themes", () => {
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    for (const v of ["--green", "--warn", "--red"]) {
      // Once in the light root, and again under the dark selector.
      expect((css.match(new RegExp(`\\${v}:`, "g")) ?? []).length).toBeGreaterThanOrEqual(2);
    }
  });
});
