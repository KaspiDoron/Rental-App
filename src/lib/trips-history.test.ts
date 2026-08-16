import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// W6.1 - TRIPS (owner report 5, item 17), verbatim:
//
//   "Right now we can't go back for old hunts from the trips section which is
//    bad. I want to be able to go back to old hunts and give the option to ask
//    all the shops in that old hunts if the price is still available for
//    renting on the same conditions, ONLY if we have price, deposit and how we
//    get the vehicle details (remember that the trips section should be open
//    only for pro and ultra users, for free we are putting upgrade cards tiers
//    and also make sure it is writing down there). Also make sure that even
//    when a history hunt card is collapsed we still show the location, best
//    price from the hunt, details about the search session, how many answered,
//    who didn't answer, deposit and every other detail we have."
//
// Each `it` below is one clause of that paragraph, asserted against the code
// that has to keep it. Re-open ALREADY worked - the defect was that a hunt fell
// out of the list after 14 days, so there was no row left to tap.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

const dealsApi = code("src/app/api/deals/route.ts");
const recheckApi = code("src/app/api/deals/recheck/route.ts");
const restoreApi = code("src/app/api/deals/restore/route.ts");
const page = code("src/app/deals/page.tsx");

describe("an old hunt is still THERE to go back to", () => {
  it("the list is no longer fenced to the last 14 days", () => {
    // The old read was `created_at=gte(now - 14 days) ... limit=30`, so the
    // owner's three-day Thailand hunt simply vanished from the tab after a
    // fortnight - and restore, which has no date bound at all, could then never
    // be invoked because there was no row to tap.
    expect(dealsApi).not.toMatch(/searches[\s\S]{0,400}?created_at=gte/);
    expect(dealsApi).toMatch(/MAX_HUNTS = 20/);
  });

  it("all three deals routes read the SAME hunt window", () => {
    // 40 rows, newest first, no date bound - the window restore and recheck
    // have always used. Disagreeing windows is how re-open started 404ing.
    for (const api of [dealsApi, recheckApi, restoreApi]) {
      expect(api).toMatch(/searches"?,?\s*\n?\s*`select=[^`]*limit=(\$\{SEARCH_ROW_LIMIT\}|40)/);
    }
  });

  it("the dead 30-minute grouping constant is gone from all three", () => {
    for (const api of [dealsApi, recheckApi, restoreApi]) {
      expect(api).not.toMatch(/GROUP_GAP_MS/);
    }
  });
});

describe('the re-ask happens ONLY on a full deal, "on the same conditions"', () => {
  it("filters the target list on price + deposit + fulfillment", () => {
    expect(recheckApi).toMatch(/termsComplete\(termsFor\(m\.raw\?\.vendorId\)\)/);
  });

  it("reads the deposit and the fulfillment at all - it never did", () => {
    expect(recheckApi).toMatch(/vendor_replies/);
    expect(recheckApi).toMatch(/negotiation_threads/);
    expect(recheckApi).toMatch(/deposit_type/);
  });

  it("the composer itself refuses an incomplete deal", () => {
    // Belt and braces: the invariant lives in the message, so a future route
    // cannot message an incomplete shop by forgetting to filter.
    expect(recheckApi).toMatch(/if \(!english\)/);
  });

  it("the button is offered only where there IS something to re-confirm", () => {
    // The old condition was `s.contacted > 0`, which offered the button for a
    // hunt where nobody ever answered.
    expect(page).toMatch(/\(s\.recheckable \?\? 0\) > 0/);
    expect(page).not.toMatch(/\{s\.contacted > 0 && !s\.closed && \(/);
  });
});

describe("the re-ask is gated and speaks the thread's language", () => {
  it("the ROUTE refuses a free plan - not only the button", () => {
    expect(recheckApi).toMatch(/can\(plan, "trips-history"\)/);
    expect(recheckApi).toMatch(/upgrade-required/);
  });

  it("the client sends a 402 to the upgrade sheet, not to red error text", () => {
    expect(page).toMatch(/r\.status === 402 \|\| d\?\.error === "upgrade-required"/);
  });

  it("localizes like every other send path, mid-thread and greetingless", () => {
    // This route composed English and handed it to guardOutbound - it never
    // imported localizeMessage - so a hunt conducted in Thai got one English
    // message weeks later, in the same thread, from the same number.
    expect(recheckApi).toMatch(/localizeMessage/);
    expect(recheckApi).toMatch(/threadWritesEnglish/);
    expect(recheckApi).toMatch(/greet: false/);
    expect(recheckApi).toMatch(/localLanguageAllowed/);
  });
});

describe("Trips is a Pro/Ultra section, and says so", () => {
  it("the server ships a free plan no history at all", () => {
    expect(dealsApi).toMatch(/can\(plan, "trips-history"\)/);
    expect(dealsApi).toMatch(/locked: true/);
  });

  it("the tab renders real tier cards from the shared plan catalogue", () => {
    expect(page).toMatch(/function TripsUpgradeGate/);
    expect(page).toMatch(/PLANS\.filter\(\(p\) => p\.id !== "free"\)/);
  });

  it("reuses the existing UpgradeSheet - there is no second checkout", () => {
    expect(page).toMatch(/<UpgradeSheet/);
    expect((page.match(/UpgradeSheet/g) ?? []).length).toBeLessThanOrEqual(3);
  });

  it("the gate is WRITTEN DOWN in the UI, as the owner asked", () => {
    expect(read("src/app/deals/page.tsx")).toMatch(/Trips is a Pro & Ultra feature/);
  });
});

describe("a COLLAPSED hunt card carries the hunt", () => {
  it("the API finally selects where the hunt happened", () => {
    // `SearchRow` did not even declare lat/lng, and nothing joined a place
    // label - so no card could say where a hunt ran.
    expect(dealsApi).toMatch(/lat\?: number \| null/);
    expect(dealsApi).toMatch(/reverseGeocode/);
    expect(dealsApi).toMatch(/place: originRow/);
  });

  it("the API finally joins the deposit and the fulfillment", () => {
    expect(dealsApi).toMatch(/negotiation_threads/);
    expect(dealsApi).toMatch(/depositPhrase/);
    expect(dealsApi).toMatch(/fulfillmentLabel/);
  });

  it("answered / never-answered ship BY NAME, not only as counts", () => {
    expect(dealsApi).toMatch(/answeredNames/);
    expect(dealsApi).toMatch(/silentNames/);
  });

  it("...and every one of them renders OUTSIDE the `open &&` branch", () => {
    // The counts were already computed and shipped; they only ever rendered
    // inside the expanded branch, i.e. on the one card the traveller had
    // tapped. The header button is the collapsed surface.
    const header = page.slice(page.indexOf("setExpanded((e) =>"), page.indexOf("{open && ("));
    expect(header.length).toBeGreaterThan(200);
    for (const field of [
      "s.place?.label",
      "s.depositLabel",
      "s.fulfillmentLabel",
      "s.answeredNames",
      "s.silentNames",
      "s.best",
    ]) {
      expect(header, `${field} must render on a collapsed card`).toContain(field);
    }
  });
});

// ---------------------------------------------------------------------------
// THE GATE, EXECUTED (owner report 5 #17).
//
// Everything above is source text. The paid-feature gate above - the one that
// stops a FREE plan being handed every hunt, every shop name and every price as
// JSON - was guarded by exactly two greps (`can(plan, "trips-history")` and
// `locked: true`), and BOTH of them still match when the condition is inverted
// to `if (can(plan, "trips-history"))`. A one-character revert therefore turned
// the gate inside out - free users get the whole history, paying users get the
// lock screen - with the entire suite green.
//
// So: run the real GET, for a free plan and for a paying one, and assert the
// bytes that come back. The shop name and the price are the payload the gate
// exists to withhold, so they are what the free assertion looks for.
// ---------------------------------------------------------------------------

import { vi, afterEach } from "vitest";

const SHOP = "Krabi Bike Rent";
const PRICE = 250;
const HUNT_AT = new Date(Date.now() - 60 * 60 * 1000).toISOString();

/** Load /api/deals/route with a real-looking database behind it. */
async function loadDealsGET(plan: string | null) {
  vi.resetModules();
  vi.doMock("@/lib/session", () => ({
    getSession: async () => ({ email: "t@example.com", plan }),
  }));
  vi.doMock("@/lib/google", () => ({ reverseGeocode: async () => null }));
  vi.doMock("@/lib/runtime-config", () => ({
    pgTimestamp: (iso: string) => encodeURIComponent(iso),
    sbSelectStrict: async (table: string) =>
      table === "searches"
        ? {
            rows: [
              {
                id: 1,
                query_text: "Ao Nang scooter",
                radius_km: 5,
                vehicle_class: "scooter",
                source: "vendors",
                results: 4,
                lat: 8.03,
                lng: 98.82,
                created_at: HUNT_AT,
              },
            ],
          }
        : { error: "missing" as const },
    sbSelect: async (table: string, query: string) => {
      if (table === "offers") {
        return [
          {
            id: 9,
            vendor_id: "v1",
            vendor_name: SHOP,
            price_per_day: PRICE,
            list_price_per_day: 400,
            currency: "THB",
            round: 2,
            verified: true,
            created_at: HUNT_AT,
          },
        ];
      }
      if (table === "vendor_replies") {
        return [
          {
            id: 3,
            vendor_id: "v1",
            vendor_name: SHOP,
            reply_text: `ok ${PRICE} per day`,
            english_gloss: null,
            image_count: 0,
            deposit: "passport",
            deposit_type: "passport",
            deposit_amount: null,
            deposit_currency: null,
            delivers: true,
            created_at: HUNT_AT,
          },
        ];
      }
      if (table === "whatsapp_messages" && query.includes("direction=eq.outbound")) {
        return [
          {
            id: 2,
            to_number: "66812345678",
            body: "Hello, do you have a scooter?",
            raw: { vendorId: "v1", vendorName: SHOP },
            received_at: HUNT_AT,
          },
        ];
      }
      return [];
    },
  }));
  const mod = await import("@/app/api/deals/route");
  return mod.GET;
}

describe("EXECUTED: the Trips gate withholds the payload, it does not just look like it", () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("@/lib/session");
    vi.doUnmock("@/lib/google");
    vi.doUnmock("@/lib/runtime-config");
  });

  it("a FREE caller receives the count and nothing else - no shop, no price", async () => {
    const GET = await loadDealsGET("free");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.locked).toBe(true);
    expect(body.feature).toBe("trips-history");
    expect(body.huntCount).toBe(1); // enough for an honest upgrade card
    expect(body.sessions).toEqual([]);
    expect(body.bookings).toEqual([]);

    // THE LEAK ITSELF. Redacting in the browser left all of this in the JSON.
    const wire = JSON.stringify(body);
    expect(wire).not.toContain(SHOP);
    expect(wire).not.toContain(String(PRICE));
    expect(wire).not.toContain("Ao Nang");
    expect(wire).not.toContain("66812345678");
  });

  it("a caller with NO plan at all is treated as free", async () => {
    const GET = await loadDealsGET(null);
    const body = await (await GET()).json();
    expect(body.locked).toBe(true);
    expect(JSON.stringify(body)).not.toContain(SHOP);
  });

  for (const plan of ["pro", "ultra"] as const) {
    it(`a ${plan} caller receives the hunt it paid for`, async () => {
      const GET = await loadDealsGET(plan);
      const body = await (await GET()).json();

      expect(body.locked).toBeUndefined();
      expect(body.sessions).toHaveLength(1);
      const wire = JSON.stringify(body);
      expect(wire).toContain(SHOP);
      expect(body.sessions[0].best?.current).toBe(PRICE);
      expect(body.sessions[0].query).toBe("Ao Nang scooter");
    });
  }
});
