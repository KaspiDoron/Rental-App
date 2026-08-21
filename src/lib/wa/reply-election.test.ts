import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const readCode = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// OWNER REPORT 7, P0-B: THE SILENCE BUG.
//
// When `wa_processed` is missing or unreachable, agent-loop falls back to a
// last-resort dedupe. That fallback used to COUNT stored inbound rows and
// stand down when it saw more than one - so two concurrent deliveries of the
// same message both saw two rows, both concluded the other one had it, and
// the shop got NO reply at all. The rule written to prevent a duplicate could
// silence the conversation instead.

describe("two deliveries of one message elect exactly ONE owner", () => {
  beforeEach(() => vi.resetModules());

  /** A real conditional insert: the first caller for a slot wins, the rest lose. */
  const claimTable = () => {
    const taken = new Set<string>();
    return vi.fn(async (_t: string, row: { sender_key: string; slot_key: string }) => {
      const k = `${row.sender_key}|${row.slot_key}`;
      if (taken.has(k)) return "lost";
      taken.add(k);
      return "won";
    });
  };

  it("THE REGRESSION: concurrent deliveries produce one winner, never zero", async () => {
    const sbInsertClaim = claimTable();
    vi.doMock("../runtime-config", () => ({ sbInsertClaim }));
    const { electReplyOwner } = await import("./inbound-claim");

    // Sequential on purpose: the conditional INSERT is what serializes the two
    // deliveries, whatever order they arrive in. What is under test is the
    // decision rule, and the old one answered "stand down" to both.
    const first = await electReplyOwner("a@x.com", "a@x.com:MSG1");
    const second = await electReplyOwner("a@x.com", "a@x.com:MSG1");
    const verdicts = [first, second];

    expect(sbInsertClaim, "both deliveries actually consulted the claim").toHaveBeenCalledTimes(2);
    expect(verdicts.filter(Boolean), "exactly one delivery answers the shop").toHaveLength(1);
    expect(verdicts.filter((v) => !v), "and exactly one stands down").toHaveLength(1);
  });

  it("two RECEIVERS of the same broadcast id both answer their own traveller", async () => {
    // The claim key is receiver-scoped (H4); the election must not undo that.
    const sbInsertClaim = claimTable();
    vi.doMock("../runtime-config", () => ({ sbInsertClaim }));
    const { electReplyOwner } = await import("./inbound-claim");

    expect(await electReplyOwner("a@x.com", "a@x.com:BCAST")).toBe(true);
    expect(await electReplyOwner("b@x.com", "b@x.com:BCAST")).toBe(true);
  });

  it("an unreachable claim table FAILS OPEN - a duplicate beats a dead thread", async () => {
    vi.doMock("../runtime-config", () => ({
      sbInsertClaim: vi.fn(async () => "error"),
    }));
    const { electReplyOwner } = await import("./inbound-claim");
    expect(await electReplyOwner("a@x.com", "a@x.com:MSG1")).toBe(true);
  });

  it("...and so does a claim layer that throws outright", async () => {
    vi.doMock("../runtime-config", () => ({
      sbInsertClaim: vi.fn(async () => {
        throw new Error("supabase unreachable");
      }),
    }));
    const { electReplyOwner } = await import("./inbound-claim");
    expect(await electReplyOwner("a@x.com", "a@x.com:MSG1")).toBe(true);
  });
});

describe("the counting fallback that could silence a shop is gone", () => {
  it("agent-loop elects, and no longer stands down on a row COUNT", () => {
    const loop = readCode("src/lib/agent-loop.ts");
    expect(loop).toMatch(/electReplyOwner\(opts\.senderEmail, replyKey\)/);
    // The exact symmetric shape that produced zero answers.
    expect(loop).not.toMatch(/if \(dup\.length > 1\) return;/);
  });

  it("the election lives in a DIFFERENT table from the claim it backs up", () => {
    // Backing up wa_processed with another wa_processed read would inherit the
    // very outage it exists to survive.
    const claim = readCode("src/lib/wa/inbound-claim.ts");
    const start = claim.indexOf("export async function electReplyOwner");
    // Bound the slice to THIS function - the lease helpers below it legitimately
    // talk about wa_processed.
    const fn = claim.slice(start, claim.indexOf("\n}", start));
    expect(fn).toMatch(/wa_send_claims/);
    expect(fn).not.toMatch(/wa_processed/);
  });
});
