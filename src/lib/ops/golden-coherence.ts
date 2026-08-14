// AUTHORED COHERENCE CASES (owner report 4/W2.2 - "make sure the replies
// actually make sense to the thread and the search session").
//
// The owner's golden cases freeze real conversations after the fact; these
// twelve are authored AHEAD of the failures they guard against - the
// cross-thread coherence dimensions the investigation named: rival leverage
// cited only when real, the session floor never undercut, an option menu
// carried across turns instead of re-asked, a media-derived price treated as
// a live quote on the turns that follow, and terminal moves (farewell,
// silence) never chosen while the shop is mid-conversation.
//
// Deterministic by construction (stubbed extraction, frozen floor, no LLM),
// so they run in CI via replay AND in the owner's durable eval gate: the
// vitest suite replays the seeds directly, and `ensureCoherenceGoldenCases`
// upserts them (name-keyed, idempotent) into agent_golden_cases so every
// policy/spec change is gated on them via the golden replay suite.
//
// Language-stickiness note: replay freezes composition (llmAllowed:false), so
// "a localized thread stays localized" cannot be asserted here - that
// dimension is covered by the executed unit suite in local-language.test.ts.

import type { GoldenCase } from "./types";

export type GoldenSeed = Omit<GoldenCase, "id" | "created_at">;

const RFQ = { vehicleClass: "scooter", durationDays: 5 } as Record<string, unknown>;
const FLOOR = { floor: 150, typical: 240, currency: "THB" };

const seed = (
  name: string,
  turns: GoldenCase["turns"],
  expects: GoldenCase["expects"],
  extra: Partial<GoldenSeed> = {}
): GoldenSeed => ({
  name: `coherence: ${name}`,
  thread_key: null,
  rfq: RFQ,
  region: "Chiang Mai, Thailand",
  floor: FLOOR,
  turns,
  expects,
  enabled: true,
  ...extra,
});

const quote = (pricePerDay: number, extra: Record<string, unknown> = {}) => ({
  found: true,
  pricePerDay,
  currency: "THB",
  matchesSpec: true,
  vehicleVerdict: "match",
  confidence: "high",
  ...extra,
});

export const COHERENCE_GOLDEN_SEEDS: GoldenSeed[] = [
  seed(
    "a real rival licenses the push",
    [
      {
        shopSays: "We have Click 125, 300 baht per day.",
        stubExtraction: quote(300),
        rivalPricePerDay: 220,
      },
    ],
    [{ move: "bargain", moveNot: ["farewell", "silent"] }]
  ),
  seed(
    "no rival is ever invented",
    [{ shopSays: "Click 125 is 300 baht per day.", stubExtraction: quote(300) }],
    [{ move: "bargain", noMessageContains: ["another shop", "other shop gave"] }]
  ),
  seed(
    "the session floor is never undercut",
    [{ shopSays: "Best I can do is 200 per day.", stubExtraction: quote(200) }],
    [{ targetAtLeast: 150 }]
  ),
  seed(
    "an option menu is resolved, not farewelled",
    [
      {
        shopSays: "Some models 200 and some new 250 per day",
        stubExtraction: {
          found: true,
          pricePerDay: 200,
          currency: "THB",
          vehicleVerdict: "unclear",
          variance: true,
          confidence: "medium",
        },
      },
    ],
    [{ move: "option-probe", moveNot: ["farewell", "silent", "redirect-close"] }]
  ),
  seed(
    "the menu is CARRIED - a resolved choice is not re-asked",
    [
      {
        shopSays: "Some models 200 and some new 250 per day",
        stubExtraction: {
          found: true,
          pricePerDay: 200,
          currency: "THB",
          vehicleVerdict: "unclear",
          variance: true,
          confidence: "medium",
        },
      },
      {
        shopSays: "New one is Click 125 2024, 250 per day, helmet included.",
        stubExtraction: quote(250, { confidence: "high" }),
      },
    ],
    [{ move: "option-probe" }, { moveNot: ["option-probe", "farewell", "silent"] }]
  ),
  seed(
    "a photographed board is a live quote on THIS turn...",
    [
      {
        shopSays: "",
        imageKind: "price_sheet",
        stubExtraction: quote(250, { sheetPricePerDay: 250, confidence: "medium" }),
      },
    ],
    [{ move: "bargain", noMessageContains: ["as text", "send the price"] }]
  ),
  seed(
    "...and stays one on the NEXT - the shop never retypes a read board",
    [
      {
        shopSays: "",
        imageKind: "price_sheet",
        stubExtraction: quote(250, { sheetPricePerDay: 250, confidence: "medium" }),
      },
      {
        shopSays: "240 ok for you?",
        stubExtraction: quote(240),
      },
    ],
    [
      { move: "bargain" },
      { moveNot: ["clarify", "farewell", "silent"], noMessageContains: ["as text"] },
    ]
  ),
  seed(
    "a shop question is answered, never talked over",
    [
      {
        shopSays: "Which day you want to start? And how many days?",
        stubExtraction: { found: false, askedQuestion: true, confidence: "medium" },
      },
    ],
    [{ move: "answer", moveNot: ["bargain", "farewell", "silent"] }]
  ),
  seed(
    "a location request gets the pickup details",
    [
      {
        shopSays: "Where do you stay? We can deliver.",
        stubExtraction: { found: false, askedLocation: true, confidence: "medium" },
      },
    ],
    [{ moveNot: ["bargain", "farewell", "silent"] }]
  ),
  seed(
    "a declined shop is never price-pushed",
    [
      {
        shopSays: "Sorry we cannot rent to you.",
        stubExtraction: { found: false, declined: true, confidence: "high" },
      },
    ],
    [{ moveNot: ["bargain", "deposit-probe", "option-probe"] }]
  ),
  seed(
    "a wrong-vehicle quote is settled before any money moves",
    [
      {
        shopSays: "We have a big Nmax 155 for 400 per day.",
        stubExtraction: {
          found: true,
          pricePerDay: 400,
          currency: "THB",
          vehicleVerdict: "mismatch",
          confidence: "high",
        },
      },
    ],
    [{ moveNot: ["bargain", "closing-message", "silent"] }]
  ),
  seed(
    "firmness is respected - the third push never comes",
    [
      { shopSays: "Click 125, 300 per day.", stubExtraction: quote(300) },
      { shopSays: "Cannot, 280 is my price.", stubExtraction: quote(280, { firm: true }) },
      {
        shopSays: "280 final price, cannot go lower.",
        stubExtraction: quote(280, { firm: true }),
      },
    ],
    [{ move: "bargain" }, {}, { moveNot: ["bargain"] }]
  ),
];

/**
 * Upsert the seeds into the durable suite - name-keyed, idempotent, additive
 * only (an owner who DISABLED a seed keeps it disabled: existing rows are
 * never touched). Returns how many were inserted.
 */
export async function ensureCoherenceGoldenCases(): Promise<number> {
  const { sbSelectStrict, sbInsert } = await import("../runtime-config");
  // STRICT read: the permissive reader answers [] for "unreadable" too, and
  // seeding on that answer would double-insert every case on each blip.
  const read = await sbSelectStrict<{ name: string }>(
    "agent_golden_cases",
    "select=name&name=like.coherence:*&limit=100"
  );
  if ("error" in read) return 0; // unreadable store - do not double-insert blind
  const have = new Set(read.rows.map((r) => r.name));
  let inserted = 0;
  for (const s of COHERENCE_GOLDEN_SEEDS) {
    if (have.has(s.name)) continue;
    const ok = await sbInsert("agent_golden_cases", [s]).catch(() => false);
    if (ok) inserted++;
  }
  return inserted;
}
