import type { BrowserContext, Page } from "@playwright/test";

// Per-route seed factories. The philosophy is mobile-check's: everything is
// REAL (production build, real React, real CSS, real Chromium) except the
// network edges that need external services. Each stub answers the app's own
// protocol shapes; a spec that needs a failure case re-routes the same URL
// with a 500/abort/malformed body.

/** Names for the four seeded shops, one per status bucket. */
export type NameFor = (bucket: "messaged" | "replied" | "queued" | "offers") => string;

/**
 * A hunt with ALL FOUR status counters live at once (mobile-check's seed,
 * verbatim in spirit): one shop messaged-awaiting, one replied, one queued,
 * one with a landed offer. `now` must come from the caller so a spec can
 * control freshness; the TTL predicate drops stale epochs silently.
 */
export function seededWorkspace(now: number, nameFor: NameFor = (k) => `Shop ${k}`) {
  const vendor = (id: string, name: string, extra: Record<string, unknown>) => ({
    id,
    name,
    lat: 7.8804,
    lng: 98.3923,
    rating: 4.6,
    reviews: 128,
    vehicleClasses: ["scooter"],
    fulfillment: ["pickup"],
    whatsapp: `+6612345${id}`,
    basePricePerDay: 300,
    partner: false,
    demo: true,
    address: "12 Beach Road",
    distanceKm: 0.8,
    ...extra,
  });
  return {
    vendors: [
      vendor("01", nameFor("messaged"), {
        stage: "awaiting-response",
        sentText: "Hi, do you have a scooter?",
      }),
      vendor("02", nameFor("replied"), {
        stage: "negotiating",
        sentText: "Hi, do you have a scooter?",
        lastInboundText: "Yes we have Click 125 available",
        lastInboundAt: new Date(now - 60_000).toISOString(),
      }),
      vendor("03", nameFor("queued"), {
        stage: "sending",
        queuedUntil: new Date(now + 600_000).toISOString(),
      }),
      vendor("04", nameFor("offers"), {
        stage: "negotiating",
        sentText: "Hi, do you have a scooter?",
        lastInboundAt: new Date(now - 30_000).toISOString(),
        offer: { pricePerDay: 250, currency: "THB", round: 1, vendorId: "04" },
      }),
    ],
    rfq: {
      vehicleClass: "scooter",
      transmission: "automatic",
      durationDays: 3,
      accessories: [],
      fulfillment: "pickup",
    },
    source: "demo",
    rawText: "scooter for 3 days",
    origin: { lat: 7.8804, lng: 98.3923, label: "Patong Beach Hotel" },
    radiusKm: 5,
    searchEpoch: now,
  };
}

/** A workspace where shops were FOUND but nothing has been contacted yet -
 *  the exact state of owner report 3 item 9 (SHOPS_FOUND, not NEGOTIATING). */
export function seededUncontactedWorkspace(now: number) {
  const base = seededWorkspace(now);
  return {
    ...base,
    vendors: base.vendors.map((v) => ({
      ...v,
      stage: undefined,
      sentText: undefined,
      lastInboundText: undefined,
      lastInboundAt: undefined,
      queuedUntil: undefined,
      offer: undefined,
    })),
  };
}

/**
 * The baseline stubs most signed-in funnel specs need: quiet queue, empty
 * translate sweep (the seeded locale cache is then what renders), a connected
 * WhatsApp status, and public config. Anything unstubbed hits the REAL route,
 * which degrades keylessly by design.
 */
export async function seedBaseline(page: Page): Promise<void> {
  await page.route("**/api/queue**", (route) => route.fulfill({ json: { items: [] } }));
  await page.route("**/api/translate**", (route) => route.fulfill({ json: { translations: {} } }));
  await page.route("**/api/wa/status**", (route) =>
    route.fulfill({ json: { configured: true, connected: true, state: "open" } })
  );
}

/** Stub the restore route so a live hunt exists without Places/Supabase. */
export async function seedLiveHunt(
  page: Page,
  workspace?: Record<string, unknown>
): Promise<void> {
  await seedBaseline(page);
  await page.route("**/api/deals/restore**", (route) =>
    route.fulfill({ json: { payload: workspace ?? seededWorkspace(Date.now()) } })
  );
}

/**
 * Seed a live hunt CLIENT-SIDE via wd_search, the way a hunt actually survives
 * navigation. `searchEpoch` is computed IN the browser (a literal epoch from
 * the test process would be silently dropped by the TTL predicate if the two
 * clocks disagree).
 */
export async function seedWdSearch(
  context: BrowserContext,
  workspace: Record<string, unknown>
): Promise<void> {
  await context.addInitScript((w) => {
    try {
      sessionStorage.setItem("wd_search", JSON.stringify({ ...w, searchEpoch: Date.now() }));
    } catch {
      /* private mode */
    }
  }, workspace);
}
