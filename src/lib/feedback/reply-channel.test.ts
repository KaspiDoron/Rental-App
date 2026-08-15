import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// THE OTHER HALF OF THE FEEDBACK PAGE (owner report 5 #18).
//
// `moderateFeedback` had exactly ONE caller in the repo - POST /api/feedback -
// so the opening message of a report was screened and every reply in the thread
// after it was not. POST /api/feedback/reply took the text straight to the
// insert: any slur or threat was stored verbatim, rendered to the owner in the
// admin panel, and emailed to every admin address.
//
// And the insert's answer was thrown away. `sbInsert` returns a BOOLEAN - false
// on no connection, a 404, an RLS refusal or a network error - and the route
// returned `{ok:true}` regardless, so both UIs painted the reply as sent. The
// most plausible field repro is the owner's own complaint that users cannot see
// his responses: a deployment whose schema predates the feedback-threads block
// has no `feedback_replies` table, so every owner reply returned 200, painted,
// and vanished.
//
// Both are asserted by RUNNING the route.

interface Harness {
  role?: "user" | "owner";
  insertOk?: boolean;
  /** What the model would say. `null` is the no-LLM-key reality. */
  model?: { abusive: boolean; kind: string; reason: string } | null;
}

async function loadReply(opts: Harness = {}) {
  const inserts: { table: string; rows: Record<string, unknown>[] }[] = [];
  const emails: { to: string[]; subject: string }[] = [];
  vi.doMock("@/lib/session", () => ({
    getSession: async () => ({
      email: opts.role === "owner" ? "boss@example.com" : "t@example.com",
      role: opts.role ?? "user",
      plan: "pro",
    }),
    adminEmails: async () => ["boss@example.com"],
  }));
  vi.doMock("@/lib/runtime-config", () => ({
    sbSelect: async () => [{ id: 7, reporter_email: "t@example.com" }],
    sbInsert: async (table: string, rows: Record<string, unknown>[]) => {
      inserts.push({ table, rows });
      return opts.insertOk ?? true;
    },
  }));
  vi.doMock("@/lib/email", () => ({
    sendEmail: async (m: { to: string[]; subject: string }) => {
      emails.push(m);
      return { sent: true };
    },
  }));
  // The floor has to hold with NO model available - that is the whole point of
  // there being a floor, and it is the configuration the audit reproduced on.
  vi.doMock("../semantic/parse", () => ({
    semanticParse: async () => ({
      value: opts.model === undefined ? null : opts.model,
      degraded: opts.model === undefined,
      attempts: 1,
    }),
  }));
  const mod = await import("@/app/api/feedback/reply/route");
  return { POST: mod.POST, inserts, emails };
}

const send = (body: string) =>
  new Request("http://x/api/feedback/reply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ feedbackId: 7, body }),
  });

beforeEach(() => vi.resetModules());
afterEach(() => vi.restoreAllMocks());

describe("the reply channel is screened, like the report that opened it", () => {
  it("a threat is refused BEFORE it is stored or emailed to anyone", async () => {
    const { POST, inserts, emails } = await loadReply();
    const res = await POST(send("I know where you live, fix it"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.rejected).toBe("language");
    expect(body.stored).toBe(false);
    // Nothing reached the table, and nothing reached the owner's inbox.
    expect(inserts).toHaveLength(0);
    expect(emails).toHaveLength(0);
    // The refusal never quotes the abuse back at the person who wrote it.
    expect(String(body.error)).not.toMatch(/know where you live/);
  });

  it("a slur is refused with copy that fits what it was, not generic priggishness", async () => {
    const { POST } = await loadReply();
    const body = await (await POST(send("your support team are r3tards"))).json();
    expect(body.rejected).toBe("language");
    expect(String(body.error)).toMatch(/hateful|discriminatory/i);
  });

  it("management is screened too - the rule is about the page, not the cookie", async () => {
    const { POST, inserts } = await loadReply({ role: "owner" });
    const res = await POST(send("you are an idiot, read the docs"));
    expect(res.status).toBe(400);
    expect(inserts).toHaveLength(0);
  });

  it("...and fury about the product still goes straight through", async () => {
    const { POST, inserts, emails } = await loadReply();
    const res = await POST(
      send("this is still broken, the shop screwed me and the scooter was crap - I want a refund")
    );
    expect(res.status).toBe(200);
    expect(inserts).toHaveLength(1);
    expect(emails).toHaveLength(1);
  });
});

describe("a reply that did not persist does not answer ok:true", () => {
  it("a refused insert is a 502 with stored:false, and no email is sent", async () => {
    const { POST, emails } = await loadReply({ insertOk: false });
    const res = await POST(send("any update on this?"));
    // The old route ignored sbInsert's boolean and answered {ok:true}, so both
    // UIs rendered the reply as sent into a table that never took it.
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.stored).toBe(false);
    // Telling the other side about a message that does not exist would send
    // them to a thread that can never show it.
    expect(emails).toHaveLength(0);
  });

  it("a stored reply says so, and notifies the other side", async () => {
    const { POST, emails } = await loadReply({ insertOk: true });
    const body = await (await POST(send("any update on this?"))).json();
    expect(body).toEqual({ ok: true, stored: true });
    expect(emails).toHaveLength(1);
  });
});
