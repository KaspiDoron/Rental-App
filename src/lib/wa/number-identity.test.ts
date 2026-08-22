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

  const mockRep = (priorTail: string | null, updates: Record<string, unknown>[]) =>
    vi.doMock("../runtime-config", () => ({
      sbSelectStrict: vi.fn(async () => ({ rows: priorTail === null ? [] : [{ phone_tail: priorTail }] })),
      sbUpdate: vi.fn(async (_t: string, _f: string, patch: Record<string, unknown>) => {
        updates.push(patch);
        return true;
      }),
      sbSelect: vi.fn(async () => []),
      sbInsert: vi.fn(async () => true),
      sbInsertClaim: vi.fn(async () => "won"),
      sbInsertReturning: vi.fn(async () => []),
      sbDelete: vi.fn(async () => true),
      getConfig: vi.fn(async () => null),
      sbCountDark: vi.fn(async () => 0),
    }));

  it("THE REGRESSION: a different number resets age, trust and counters", async () => {
    const updates: Record<string, unknown>[] = [];
    mockRep("1111", updates);
    const { noteLinkedNumber } = await import("../wa-guard");
    expect(await noteLinkedNumber("a@x.com", "+66 81 234 2222")).toBe("reset");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      phone_tail: "2222",
      trust_score: 20,
      sent_total: 0,
      replies_total: 0,
      last_send_at: null,
    });
    // created_at is the one the ramp reads - it MUST be restamped.
    expect(updates[0].created_at, "the warm-up clock restarts").toBeTruthy();
  });

  it("the SAME number keeps everything it earned", async () => {
    const updates: Record<string, unknown>[] = [];
    mockRep("2222", updates);
    const { noteLinkedNumber } = await import("../wa-guard");
    expect(await noteLinkedNumber("a@x.com", "+66812342222")).toBe("unchanged");
    expect(updates, "re-linking the same number must not wipe its trust").toHaveLength(0);
  });

  it("learning the number for the first time STAMPS without resetting", async () => {
    // The row's age belongs to this number; we just did not know which it was.
    const updates: Record<string, unknown>[] = [];
    mockRep(null, updates);
    const { noteLinkedNumber } = await import("../wa-guard");
    expect(await noteLinkedNumber("a@x.com", "+66812342222")).toBe("stamped");
    expect(updates[0]).toEqual({ phone_tail: "2222" });
    expect(updates[0]).not.toHaveProperty("created_at");
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
    mockRep("1111", updates);
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
