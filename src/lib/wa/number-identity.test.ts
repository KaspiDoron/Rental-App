import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// OWNER REPORT 8, A4+A5 - the warm-up has to be about the NUMBER.
//
// Every reputation fact keys on sender_key = the user's EMAIL, and created_at
// is what the ramp reads as "how old is this number". So: link A, hunt a week,
// unlink, link a brand-new burner B -> B inherits A's age (ramp factor 1.0),
// A's trust and A's counters on its first day. Nothing reset that row.

describe("a swapped number restarts its warm-up", () => {
  beforeEach(() => vi.resetModules());

  // `rows: []` and `rows: [{phone_tail: null}]` are DIFFERENT WORLDS, and this
  // harness could not tell them apart - it mapped a null tail to an absent row,
  // so the "first time" test below was really exercising the no-row case while
  // asserting a PATCH. That is exactly the production bug owner report 8.1
  // found: on a first link there is no reputation row yet, so the patch matched
  // nothing and the tail was never stored. The mock now models both, and
  // captures inserts as well as updates.
  const mockRep = (
    row: { phone_tail: string | null } | null,
    updates: Record<string, unknown>[],
    inserts: Record<string, unknown>[] = []
  ) =>
    vi.doMock("../runtime-config", () => ({
      sbSelectStrict: vi.fn(async () => ({ rows: row ? [row] : [] })),
      sbUpdate: vi.fn(async (_t: string, _f: string, patch: Record<string, unknown>) => {
        updates.push(patch);
        return true;
      }),
      sbSelect: vi.fn(async () => []),
      sbInsert: vi.fn(async (_t: string, rows: Record<string, unknown>[]) => {
        inserts.push(...rows);
        return true;
      }),
      sbInsertClaim: vi.fn(async () => "won"),
      sbInsertReturning: vi.fn(async () => []),
      sbDelete: vi.fn(async () => true),
      getConfig: vi.fn(async () => null),
      sbCountDark: vi.fn(async () => 0),
    }));

  it("THE REGRESSION: a different number resets age, trust and counters", async () => {
    const updates: Record<string, unknown>[] = [];
    mockRep({ phone_tail: "1111" }, updates);
    const { noteLinkedNumber } = await import("../wa-guard");
    expect(await noteLinkedNumber("a@x.com", "+66 81 234 2222")).toBe("reset");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      phone_tail: "2222",
      trust_score: 20,
      sent_total: 0,
      replies_total: 0,
      last_send_at: null,
      // EVERY counter describing the old number, not just two of them. Zeroing
      // sent_total while leaving delivered_total standing does not lose
      // information, it corrupts the ratios built from them: computeRisk arms
      // its read-rate test at delivered_total >= 8, so a fresh number could
      // inherit an already-armed engagement test whose denominator describes a
      // number it has never been.
      delivered_total: 0,
      reads_total: 0,
      blocks_total: 0,
      fails_total: 0,
      invalid_numbers_total: 0,
      new_contacts_today: 0,
      risk_score: 0,
      // Holds belong to the number that earned them.
      paused_until: null,
      cold_hold_until: null,
    });
    // created_at is the one the ramp reads - it MUST be restamped.
    expect(updates[0].created_at, "the warm-up clock restarts").toBeTruthy();
  });

  it("the SAME number keeps everything it earned", async () => {
    const updates: Record<string, unknown>[] = [];
    mockRep({ phone_tail: "2222" }, updates);
    const { noteLinkedNumber } = await import("../wa-guard");
    expect(await noteLinkedNumber("a@x.com", "+66812342222")).toBe("unchanged");
    expect(updates, "re-linking the same number must not wipe its trust").toHaveLength(0);
  });

  it("learning the number for an EXISTING row STAMPS without resetting", async () => {
    // The row's age belongs to this number; we just did not know which it was.
    const updates: Record<string, unknown>[] = [];
    mockRep({ phone_tail: null }, updates);
    const { noteLinkedNumber } = await import("../wa-guard");
    expect(await noteLinkedNumber("a@x.com", "+66812342222")).toBe("stamped");
    expect(updates[0]).toEqual({ phone_tail: "2222" });
    expect(updates[0]).not.toHaveProperty("created_at");
  });

  it("THE REGRESSION: with NO row the tail is INSERTED, not patched into nothing", async () => {
    // On a first link the reputation row does not exist - it is created lazily
    // by getReputation on the first guarded send. The old code PATCHed anyway,
    // matched zero rows, stored nothing, and returned "stamped" as though it
    // had. So the next link of a genuinely different number saw prior=null all
    // over again and took the no-reset branch: a burner inherits the previous
    // number's age, trust and counters on its first day - the precise failure
    // this function exists to prevent.
    const updates: Record<string, unknown>[] = [];
    const inserts: Record<string, unknown>[] = [];
    mockRep(null, updates, inserts);
    const { noteLinkedNumber } = await import("../wa-guard");
    expect(await noteLinkedNumber("a@x.com", "+66812342222")).toBe("stamped");
    expect(updates, "a PATCH against a missing row writes nothing").toHaveLength(0);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      sender_key: "a@x.com",
      phone_tail: "2222",
      trust_score: 20,
      sent_total: 0,
    });
    // The number is bound to a reputation from the moment it is LINKED, not
    // from its first send, so the swap detector has something to compare to.
    expect(inserts[0].created_at).toBeTruthy();
  });

  it("no number and an unreadable row both leave the reputation ALONE", async () => {
    // Wrongly resetting costs warm-up progress; wrongly keeping costs the
    // account. But guessing on an outage would reset every number at once.
    const updates: Record<string, unknown>[] = [];
    mockRep(null, updates);
    const { noteLinkedNumber } = await import("../wa-guard");
    expect(await noteLinkedNumber("a@x.com", null)).toBe("skipped");
    expect(await noteLinkedNumber("a@x.com", "12")).toBe("skipped");
    expect(await noteLinkedNumber("", "+66812342222")).toBe("skipped");
    expect(updates).toHaveLength(0);
  });

  it("only the last four digits are stored - not a second copy of the number", async () => {
    const updates: Record<string, unknown>[] = [];
    mockRep({ phone_tail: "1111" }, updates);
    const { noteLinkedNumber } = await import("../wa-guard");
    await noteLinkedNumber("a@x.com", "+66 81 234 5678");
    expect(updates[0].phone_tail).toBe("5678");
    expect(JSON.stringify(updates[0])).not.toMatch(/66812345678/);
  });

  it("the connect route calls it at link time", () => {
    const route = read("src/app/api/wa/connect/route.ts");
    expect(route).toMatch(/noteLinkedNumber\(session\.email, phone\)/);
    // ...and the column is additive so a pre-migration deploy is unchanged.
    expect(read("supabase/schema.sql")).toMatch(
      /add column if not exists phone_tail text/
    );
  });
});

describe("one number, one account", () => {
  const route = read("src/app/api/wa/connect/route.ts");

  it("THE REGRESSION: a number already linked elsewhere is refused", () => {
    expect(route).toMatch(/already linked to another WheelDeal account/);
    expect(route).toMatch(/status: 409/);
  });

  it("it compares against OTHER accounts, never the caller's own", () => {
    expect(route).toMatch(/\(r\.email \?\? ""\)\.toLowerCase\(\) !== session\.email\.toLowerCase\(\)/);
  });

  it("a too-short or absent number skips the check rather than blocking a link", () => {
    expect(route).toMatch(/if \(digits\.length >= 8\)/);
  });
});
