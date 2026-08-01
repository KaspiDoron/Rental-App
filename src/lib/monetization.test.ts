import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

import { planSendPriority, compareOutboxRows, outboxSendPriority } from "./wa/outbox-policy";
import { routableOrigin } from "./request-origin";

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// THREE THINGS THAT WERE SOLD, PROMISED OR IMPLIED AND NEVER BUILT.

describe("priority processing, the paid feature that did not exist", () => {
  it("plan orders Ultra, then Pro, then everyone else", () => {
    expect(planSendPriority("ultra")).toBeLessThan(planSendPriority("pro"));
    expect(planSendPriority("pro")).toBeLessThan(planSendPriority("free"));
    expect(planSendPriority(null)).toBe(planSendPriority("free"));
    expect(planSendPriority("ULTRA")).toBe(planSendPriority("ultra"));
  });

  it("REPRODUCTION: a paying reply no longer sits behind a free one", () => {
    const free = { kind: "auto-answer", plan: "free", notBefore: "2026-08-01T10:00:00Z" };
    const paid = { kind: "auto-answer", plan: "ultra", notBefore: "2026-08-01T10:00:01Z" };
    // The free row is due a second EARLIER, which is all the old sort looked at.
    expect(compareOutboxRows(paid, free)).toBeLessThan(0);
  });

  it("...but it is a TIE-BREAK, never a queue-jump past a different kind", () => {
    // A paid cold introduction still waits behind anyone's live reply: an
    // engaged shop is the more urgent thing in the system whoever is paying.
    const paidIntro = { kind: "rfq", plan: "ultra", notBefore: "2026-08-01T10:00:00Z" };
    const freeReply = { kind: "auto-answer", plan: "free", notBefore: "2026-08-01T11:00:00Z" };
    expect(compareOutboxRows(freeReply, paidIntro)).toBeLessThan(0);
  });

  it("the traveller's OWN words still outrank everything, on any plan", () => {
    expect(outboxSendPriority("custom")).toBeLessThan(outboxSendPriority("auto-answer"));
    const freeTyped = { kind: "custom", plan: "free", notBefore: "2026-08-01T12:00:00Z" };
    const ultraAuto = { kind: "auto-bargain", plan: "ultra", notBefore: "2026-08-01T10:00:00Z" };
    expect(compareOutboxRows(freeTyped, ultraAuto)).toBeLessThan(0);
  });

  it("age still decides between equals", () => {
    const older = { kind: "auto-answer", plan: "pro", notBefore: "2026-08-01T10:00:00Z" };
    const newer = { kind: "auto-answer", plan: "pro", notBefore: "2026-08-01T10:05:00Z" };
    expect(compareOutboxRows(older, newer)).toBeLessThan(0);
  });

  it("and the drain actually uses the comparator", () => {
    const guard = readCode("src/lib/wa-guard.ts");
    expect(guard).toMatch(/const \{ compareOutboxRows \} = await import\("\.\/wa\/outbox-policy"\);/);
    expect(guard).toMatch(/\.sort\(\(a, b\) => compareOutboxRows\(keyOf\(a\), keyOf\(b\)\)\)/);
  });
});

describe("REPRODUCTION: an Ultra insight shipped to every plan", () => {
  const route = readCode("src/app/api/vendors/route.ts");

  it("fastResponder is stripped for anyone without the entitlement", () => {
    // Discovery stamps it on every vendor; the route returned it to everyone,
    // so the whole value of the Ultra reply-speed filter sat in a free user's
    // network tab.
    expect(route).toMatch(/const canSeeSpeed = can\(session\.plan, "fast-responder-filter"\);/);
    expect(route).toMatch(/v\.fastResponder \? \{ \.\.\.v, fastResponder: undefined \} : v/);
    expect(route).toMatch(/NextResponse\.json\(\{ vendors: payload/);
  });
});

describe("REPRODUCTION: a checkout PayPal cannot return from", () => {
  it("the routability filter rejects exactly the hosts Cloud Run produces", () => {
    expect(routableOrigin("http://0.0.0.0:8080")).toBeNull();
    expect(routableOrigin("http://localhost:3000")).toBeNull();
    expect(routableOrigin("http://container-abc")).toBeNull();
    expect(routableOrigin("https://wheeldeal.pro")).toBe("https://wheeldeal.pro");
  });

  it("checkout uses it, and falls back to the configured site origin", () => {
    // `requestOrigin` deliberately keeps localhost valid for local dev, so a
    // checkout could be created with a return URL nobody can follow - and the
    // traveller who paid landed nowhere.
    const checkout = readCode("src/app/api/billing/checkout/route.ts");
    expect(checkout).toMatch(/publicRequestOrigin\(req\) \?\? \(await resolveSiteOrigin\(\)\)/);
    expect(checkout).not.toMatch(/= requestOrigin\(req\)/);
  });
});

describe("REPRODUCTION: a key the owner sets that nothing reads", () => {
  it("TWITTER_HANDLE resolves through the Key Vault, like every other key", () => {
    // The admin screen writes it and reads it back, so it looked saved - while
    // the only consumer read process.env, which on Cloud Run is whatever was
    // baked at deploy time.
    const layout = readCode("src/app/layout.tsx");
    expect(layout).toMatch(/const twitterHandle = await getConfig\("TWITTER_HANDLE"\)/);
    expect(layout).not.toMatch(/process\.env\.TWITTER_HANDLE/);
  });
});
