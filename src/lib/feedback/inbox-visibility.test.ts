import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// "I HAVE FULLY VISIBLE EACH AND EVERY FEEDBACK" (owner report 5 #18) - and
// two things quietly made that false.
//
//   * /api/admin/feedback read a hard `limit=100` with no pagination, and then
//     reported `total: rows.length` - the PAGE SIZE - which the panel renders
//     as a metric labelled "Total". With 101 reports the 101st-oldest was
//     unreachable through any UI, the owner was told he had exactly 100, and
//     nothing anywhere said otherwise.
//   * The reporter's unread badge was erased by the click that revealed it:
//     the modal PATCHed /api/feedback with the body "{}", which the route reads
//     as "no id" and therefore stamps `user_seen_at` on EVERY one of the
//     caller's reports. The route's per-report `id` branch had no caller at all.

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: n - i,
    category: i % 3 === 0 ? "bug" : "ui",
    body: `report ${n - i}`,
    image_count: 0,
    created_at: new Date(Date.now() - i * 60_000).toISOString(),
  }));

async function loadInbox(total: number | null, table = rows(250)) {
  const reads: string[] = [];
  vi.doMock("@/lib/session", () => ({
    requireManagement: async () => ({ email: "boss@example.com", role: "owner" }),
  }));
  vi.doMock("@/lib/runtime-config", () => ({
    sbSelect: async (t: string, q: string) => {
      reads.push(q);
      if (t !== "feedback") return [];
      const p = new URLSearchParams(q);
      const cat = p.get("category");
      let out = table;
      if (cat?.startsWith("eq.")) out = out.filter((r) => r.category === cat.slice(3));
      const offset = Number(p.get("offset") ?? 0) || 0;
      const limit = Number(p.get("limit") ?? 50) || 50;
      return out.slice(offset, offset + limit);
    },
    sbCountDark: async () => total,
    sbUpdate: async () => true,
    sbDelete: async () => true,
  }));
  const mod = await import("@/app/api/admin/feedback/route");
  return { GET: mod.GET, reads };
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.restoreAllMocks());

describe("the owner can reach every report, and is told how many there are", () => {
  it("`total` is the real count, not the size of the page it just sent", async () => {
    const { GET } = await loadInbox(250);
    const body = await (await GET(new Request("http://x/api/admin/feedback"))).json();
    expect(body.feedback).toHaveLength(100);
    // This was `rows.length` - i.e. 100 - rendered under the label "Total".
    expect(body.total).toBe(250);
    expect(body.shown).toBe(100);
    expect(body.hasMore).toBe(true);
    expect(body.nextOffset).toBe(100);
  });

  it("the 101st report is actually reachable", async () => {
    const { GET } = await loadInbox(250);
    const page2 = await (
      await GET(new Request("http://x/api/admin/feedback?offset=100&limit=100"))
    ).json();
    expect(page2.feedback[0].body).toBe("report 150");
    expect(page2.offset).toBe(100);
    const page3 = await (
      await GET(new Request("http://x/api/admin/feedback?offset=200&limit=100"))
    ).json();
    expect(page3.feedback).toHaveLength(50);
    expect(page3.hasMore).toBe(false);
  });

  it("a caller cannot ask for an unbounded page", async () => {
    const { GET } = await loadInbox(250);
    const body = await (
      await GET(new Request("http://x/api/admin/feedback?limit=99999&offset=-5"))
    ).json();
    expect(body.limit).toBe(200);
    expect(body.offset).toBe(0);
  });

  it("an unreadable count is `null`, never a number the panel made up", async () => {
    // sbCount answers 0 on any failure, which under a label saying "Total"
    // means an outage renders as "you have no feedback".
    const { GET } = await loadInbox(null);
    const body = await (await GET(new Request("http://x/api/admin/feedback"))).json();
    expect(body.total).toBeNull();
    // ...and the owner still gets a way forward from a full page.
    expect(body.hasMore).toBe(true);
  });

  it("the count respects the active category filter, like the list does", async () => {
    const { GET, reads } = await loadInbox(84);
    await GET(new Request("http://x/api/admin/feedback?category=bug"));
    expect(reads.some((q) => q.includes("category=eq.bug"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------

async function loadUserFeedback() {
  const updates: { scope: string; patch: Record<string, unknown> }[] = [];
  vi.doMock("@/lib/session", () => ({
    getSession: async () => ({ email: "t@example.com", role: "user", plan: "free" }),
    adminEmails: async () => ["boss@example.com"],
  }));
  vi.doMock("@/lib/runtime-config", () => ({
    sbSelect: async () => [],
    sbInsert: async () => true,
    sbInsertReturning: async () => [{ id: 7 }],
    sbDelete: async () => true,
    sbUpdate: async (_t: string, scope: string, patch: Record<string, unknown>) => {
      updates.push({ scope, patch });
      return true;
    },
  }));
  vi.doMock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true }), clientIp: () => "1" }));
  vi.doMock("@/lib/agents", () => ({ triageFeedback: async () => ({ isRealIssue: true }) }));
  vi.doMock("@/lib/email", () => ({ sendEmail: async () => ({ sent: true }) }));
  const mod = await import("@/app/api/feedback/route");
  return { PATCH: mod.PATCH, updates };
}

const patch = (body: unknown) =>
  new Request("http://x/api/feedback", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("marking a report read touches THAT report", () => {
  it("an id scopes the stamp to one row - the branch no client ever used", async () => {
    const { PATCH, updates } = await loadUserFeedback();
    await PATCH(patch({ id: 7 }));
    expect(updates).toHaveLength(1);
    expect(updates[0].scope).toContain("id=eq.7");
    // Ownership stays in the FILTER: an id alone can never reach another user.
    expect(updates[0].scope).toContain("reporter_email=eq.t%40example.com");
  });

  it("an empty body still stamps everything - which is why nobody may send one", async () => {
    const { PATCH, updates } = await loadUserFeedback();
    await PATCH(patch({}));
    expect(updates[0].scope).not.toContain("id=eq.");
  });
});

const modal = readFileSync(join(process.cwd(), "src/components/FeedbackModal.tsx"), "utf8");

describe("the click that reveals the badge is not the click that erases it", () => {
  it("opening the TAB no longer stamps every report", () => {
    // `body: "{}"` is the bug in one literal: the route reads it as "no id".
    const openYours = modal.slice(modal.indexOf("const openYours"), modal.indexOf("return ("));
    expect(openYours).not.toMatch(/method: "PATCH"/);
    expect(modal).not.toMatch(/body: "\{\}"/);
  });

  it("opening a REPORT stamps that report, by id", () => {
    expect(modal).toMatch(/body: JSON\.stringify\(\{ id: report\.id \}\)/);
    // ...and only when there is something unread to clear.
    expect(modal).toMatch(/if \(next && \(report\.unread \?\? 0\) > 0\)/);
  });
});
