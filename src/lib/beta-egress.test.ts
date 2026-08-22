import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// OWNER REPORT 8, A7+A9 - what actually breaks first at 50 users.
//
// Measured egress was ~2.6 MB/min PER ACTIVE USER, which exhausts Supabase's
// free 5 GB monthly allowance in under an hour at 50 testers. The failure mode
// is the project being restricted - i.e. the whole app going dark on launch
// day - and it was absent from both ops docs.

describe("the polls stop shipping jsonb they never read", () => {
  const thread = read("src/app/api/thread/route.ts");

  it("THE BIGGEST ONE: ThreadPeek projects three keys, not the whole raw blob", () => {
    // 600 rows every 10s carrying full provider payloads, to render a one-line
    // preview built from exactly raw.vendorId / raw.englishGloss / raw.english.
    expect(thread).toMatch(/select=body,received_at,to_number,raw->>vendorId,raw->>englishGloss/);
    expect(thread).toMatch(/select=body,received_at,from_number,raw->>english/);
    expect(thread).not.toMatch(/select=body,received_at,to_number,raw&direction=eq\.outbound/);
    expect(thread).not.toMatch(/select=body,received_at,from_number,raw&direction=eq\.inbound/);
  });

  it("...and re-nests them into the shape peek-batch expects", () => {
    // The projection flattens; buildPeeks reads m.raw?.x. Both must hold.
    expect(thread).toMatch(/raw: \{ vendorId: r\.vendorId, englishGloss: r\.englishGloss \}/);
    expect(thread).toMatch(/raw: \{ english: r\.english \}/);
  });

  it("the peek poll runs at 30s, not 10s", () => {
    const store = read("src/lib/client/thread-peek-store.ts");
    expect(store).toMatch(/export const PEEK_POLL_MS = 30_000;/);
  });

  it("the activity feed reads 40 traces, not 120", () => {
    const act = read("src/app/api/activity/route.ts");
    expect(act).toMatch(/order=created_at\.desc&limit=40`/);
    expect(act).not.toMatch(/reasoning,output,created_at&user_email=eq\.\$\{enc\}[^`]*limit=120/);
  });

  it("the 400-row rfq read pulls one key, and KEEPS its row count", () => {
    // Row count is load-bearing: truncating it silently regresses the
    // "messaged" progress bar (the L5 bug). Only the payload shrinks.
    const act = read("src/app/api/activity/route.ts");
    expect(act).toMatch(/select=to_number,raw->>vendorId&direction=eq\.outbound/);
    expect(act).toMatch(/limit=400`/);
  });

  it("the two row shapes are normalised rather than re-inflated", () => {
    const act = read("src/app/api/activity/route.ts");
    expect(act).toMatch(/m\.raw\?\.vendorId \?\? m\.vendorId/);
  });
});

describe("Google Places: the only unbounded-$ exposure", () => {
  const g = read("src/lib/google.ts");

  it("THE FIX: vendor discovery caches for 6 hours, not 10 minutes", () => {
    expect(g).toMatch(/cacheSet\(ck, out, 6 \* 3600_000\)/);
    expect(g).not.toMatch(/cacheSet\(ck, out, 10 \* 60_000\)/);
  });

  it("the daily search cap is 5 for the beta", () => {
    expect(read("src/lib/usage.ts")).toMatch(/LIMIT_SEARCHES_PER_DAY: 5,/);
  });

  it("rating fields are KEPT - four surfaces render them", () => {
    // Dropping them would fall two SKU tiers but break VendorCard,
    // CompareSheet, MassBargainPreview and ReviewsSheet. That is a product
    // regression, not a cost optimisation.
    expect(g).toMatch(/"places\.rating"/);
    expect(g).toMatch(/"places\.userRatingCount"/);
  });

  it("the doc no longer claims discovery is cached for a day", () => {
    const doc = read("SCALING.md");
    expect(doc).toMatch(/cached for 6 hours per query/);
    expect(doc).not.toMatch(/Results are cached for a day per query/);
  });
});
