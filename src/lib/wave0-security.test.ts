import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rateLimit, clientIp, _resetRateLimit } from "./rate-limit";

// WAVE 0 - security hotfixes. Each fix lands with a test that fails on revert.
// The behavioral tests exercise the new limiter directly; the source pins guard
// the route/config wiring the way this repo already pins deploy-env and
// safety-signals - a reintroduction of the defect turns the assertion red.

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("rateLimit - the sessionless route limiter", () => {
  beforeEach(() => _resetRateLimit());

  it("allows up to max in a window and refuses the next", async () => {
    // No REDIS_URL in the test env, so this exercises the per-instance window.
    for (let i = 0; i < 5; i++) {
      expect((await rateLimit("t", "1.2.3.4", 5, 3600)).ok, `hit ${i + 1}`).toBe(true);
    }
    const over = await rateLimit("t", "1.2.3.4", 5, 3600);
    expect(over.ok).toBe(false);
    expect(over.retryAfter).toBeGreaterThan(0);
  });

  it("keeps separate counters per id and per bucket", async () => {
    for (let i = 0; i < 5; i++) await rateLimit("t", "a", 5, 3600);
    expect((await rateLimit("t", "a", 5, 3600)).ok).toBe(false); // a is spent
    expect((await rateLimit("t", "b", 5, 3600)).ok).toBe(true); // b is fresh
    expect((await rateLimit("other", "a", 5, 3600)).ok).toBe(true); // other bucket
  });

  it("clientIp reads the proxy headers Cloud Run sets, newest-hop first", () => {
    const req = new Request("https://x/y", {
      headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" },
    });
    expect(clientIp(req)).toBe("9.9.9.9");
    expect(clientIp(new Request("https://x/y"))).toBe("unknown");
  });
});

describe("prune_old_rows is no longer callable by the anon key", () => {
  it("security-fix.sql revokes the default grant and hands EXECUTE to service_role only", () => {
    const sql = read("supabase/security-fix.sql");
    expect(sql).toMatch(/revoke all on function public\.prune_old_rows\(int\) from anon/i);
    expect(sql).toMatch(/revoke all on function public\.prune_old_rows\(int\) from authenticated/i);
    expect(sql).toMatch(/grant execute on function public\.prune_old_rows\(int\) to service_role/i);
  });
});

describe("PayPal webhook - a hint can never drive a downgrade", () => {
  const src = read("src/app/api/webhooks/paypal/route.ts");
  it("the verified activation link wins; the downgrade path trusts ONLY the link", () => {
    // grantEmail may bootstrap from the hint; downgradeEmail is link-only.
    expect(src).toMatch(/const linked = subscriptionId \? await subscriberFor\(subscriptionId\) : null/);
    expect(src).toMatch(/const grantEmail = linked \|\| hintEmail \|\| ""/);
    expect(src).toMatch(/const downgradeEmail = linked \|\| ""/);
  });
  it("the suspension/downgrade branch consumes downgradeEmail, not the raw hint", () => {
    expect(src).toMatch(/else if \(verified && downgradeEmail\)/);
    // The old, exploitable form must be gone.
    expect(src).not.toMatch(/const email = hintEmail \|\|/);
  });
  it("a sale reads billing_agreement_id first (its own id is the SALE id)", () => {
    expect(src).toMatch(/isSale\s*[\r\n ]*\?\s*resource\.billing_agreement_id \?\? resource\.id/);
  });
});

describe("wa/ping fails CLOSED", () => {
  const src = read("src/app/api/wa/ping/route.ts");
  it("refuses with 403 when the token cannot be derived, before doing any work", () => {
    expect(src).toMatch(/if \(!expected\) \{[\s\S]*?status: 403/);
    // The old fail-open shape (guarding only the check on `if (expected)`) is gone.
    expect(src).not.toMatch(/const hosts = await pingAllHosts\(\);[\s\S]{0,40}if \(expected\) \{\s*const token/);
  });
});

describe("admin erase targets the RIGHT column on every table", () => {
  const src = read("src/app/api/admin/users/route.ts");
  it("maps each table to its real user column (feedback keys on reporter_email)", () => {
    expect(src).toMatch(/bookings:\s*"user_email"/);
    expect(src).toMatch(/searches:\s*"user_email"/);
    expect(src).toMatch(/feedback:\s*"reporter_email"/);
    expect(src).toMatch(/wa_sessions:\s*"email"/);
    // The old blanket `email=eq.` loop over all four tables must be gone.
    expect(src).not.toMatch(/for \(const table of \["bookings", "searches", "feedback", "wa_sessions"\]\)/);
  });
  it("reports a partial erase instead of answering 200 on a failed purge", () => {
    expect(src).toMatch(/Partial erase/);
    expect(src).toMatch(/status: 500/);
  });
});

describe("auth/forgot is throttled", () => {
  const src = read("src/app/api/auth/forgot/route.ts");
  it("rate-limits per (ip,email) and per ip before touching the password", () => {
    expect(src).toMatch(/rateLimit\("forgot", `\$\{ip\}:\$\{key\}`/);
    expect(src).toMatch(/rateLimit\("forgot-ip", ip/);
  });
});

describe("open spend paths are throttled", () => {
  it("feedback POST rate-limits and caps image bytes", () => {
    const src = read("src/app/api/feedback/route.ts");
    expect(src).toMatch(/rateLimit\("feedback"/);
    expect(src).toMatch(/MAX_IMAGE_B64/);
  });
  it("reviews GET rate-limits the billed Places lookup", () => {
    const src = read("src/app/api/reviews/route.ts");
    expect(src).toMatch(/rateLimit\("reviews"/);
  });
});

describe("setConfig no longer pins an instance after a failed save", () => {
  const src = read("src/lib/runtime-config.ts");
  it("clears the in-memory value on a successful durable save", () => {
    // The delete must sit on the success path, right before {ok:true,persistent:true}.
    expect(src).toMatch(/delete s\.mem\[name\];\s*[\r\n]\s*return \{ ok: true, persistent: true \}/);
  });
  it("guards the vault encryption key in production", () => {
    expect(src).toMatch(/function cryptoKey\(\): Buffer \{[\s\S]*?NODE_ENV === "production"[\s\S]*?throw new Error/);
  });
});

describe("revocation is not advisory, and a fresh read is really fresh", () => {
  it("getSession refuses a blocked account", () => {
    const src = read("src/lib/session.ts");
    expect(src).toMatch(/rec\?\.status === "blocked"\) return null/);
  });
  it("getUser({fresh}) distinguishes a gone row from a transient error", () => {
    const src = read("src/lib/access.ts");
    expect(src).toMatch(/if \(opts\?\.fresh\) \{[\s\S]*?sbSelectStrict[\s\S]*?return undefined/);
  });
});
