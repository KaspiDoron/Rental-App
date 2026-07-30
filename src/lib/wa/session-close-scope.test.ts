import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const readCode = (p: string) =>
  readFileSync(p, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

// The ghost-removal incident's server half: /api/session/close tombstoned
// EVERY shop messaged in the last 7 days (by recency, not by session), fired
// on every new search with a blind retry - so the retry could re-tombstone
// shops the new batch had just deliberately cleared, and six never-removed
// shops rendered as "REMOVED BY YOU".

describe("a close is scoped to the session it closes", () => {
  const route = readCode("src/app/api/session/close/route.ts");

  it("the enumeration is bounded by the closing session's own window", () => {
    expect(route).toMatch(/last_sent_at=gte\.\$\{encodeURIComponent\(fromIso\)\}/);
    expect(route).toMatch(/last_sent_at=lte\.\$\{encodeURIComponent\(\s*beforeIso\s*\)\}/);
    // The outbox purge is bounded too - rows created after the cutoff belong
    // to the NEW session.
    expect(route).toMatch(/created_at=lte\.\$\{encodeURIComponent\(beforeIso\)\}/);
  });

  it("a retried close can never touch a shop the new session already queued", () => {
    expect(route).toMatch(/created_at=gt\.\$\{encodeURIComponent\(beforeIso\)\}/);
    expect(route).toMatch(/freshlyQueued/);
    expect(route).toMatch(/\.filter\(\(d\) => !freshlyQueued\.has\(d\)\)/);
  });

  it("the epochs are clamped server-side - a client cannot widen the window", () => {
    expect(route).toMatch(/Math\.min\(Number\(body\.before\), nowMs\)/);
    expect(route).toMatch(/Math\.max\(Number\(body\.from\), nowMs - 7 \* 24 \* 3600_000\)/);
  });

  it("both client call sites pass the closing session's bounds", () => {
    const page = readCode("src/app/page.tsx");
    expect(page).toMatch(/JSON\.stringify\(\{ from: searchEpoch \|\| undefined, before: epoch \}\)/);
    expect(page).toMatch(/JSON\.stringify\(\{ from: searchEpoch \|\| undefined, before: clearEpoch \}\)/);
  });
});

describe("the queue payload never advertises a tombstoned shop", () => {
  it("activity filters cancelled recipients out of the queue and ships the typed list", () => {
    const activity = readCode("src/app/api/activity/route.ts");
    expect(activity).toMatch(/!cancelledSet\.has\(r\.to_number\)/);
    expect(activity).toMatch(/cancelledEntries/);
    expect(activity).toMatch(/cancelledShops,/);
  });

  it("the mass route treats an unconfirmed tombstone clear as a refusal, not a queue", () => {
    const mass = readCode("src/app/api/outreach/mass/route.ts");
    expect(mass).toMatch(/const cleared = await clearCancellation\(session\.email, digits\)\.catch\(\(\) => false\);/);
    expect(mass).toMatch(/still-removed/);
  });
});
