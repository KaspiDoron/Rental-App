import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// EVERY SAFETY SYSTEM TURNED ITSELF OFF AT THE SAME MOMENT.
//
// Three independent guards - the global kill switch, the per-user daily caps,
// and the WhatsApp anti-ban hour/day budgets - all read through helpers that
// collapse EVERY failure to "empty":
//
//   getConfig  -> undefined   (loadOverrides catch returns {})
//   sbSelect   -> []          (documented: never throws)
//
// "empty" and "unreadable" are the same value to the caller, so a Supabase
// brownout is indistinguishable from a healthy system with nothing configured
// and nothing sent. The convergent state during a wobble was:
//
//   kill switch OFF, every daily cap ALLOWING, both anti-ban budgets reading 0.
//
// That is precisely the configuration that gets a traveller's PERSONAL WhatsApp
// number banned, and it is reached by a database hiccup rather than by any code
// path a test would exercise. Three separate auditors each saw one third of it.
//
// These are executed tests, not source pins: each stubs the transport and
// asserts the DECISION. The distinction that matters is which failure:
//
//   500 / timeout        -> "unavailable" -> the truth is unknown -> REFUSE
//   400 + 42P01 / 404    -> "missing"     -> the table has never existed, so it
//                                            is vacuously empty -> ALLOW
//
// Failing closed on "missing" would brick every fresh install before the schema
// is run, so the second half of each pair is as important as the first.

const SUPA_ENV = {
  SUPABASE_URL: "https://stub.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-stub",
};

/** Freshly imported modules with a clean vault cache and a stubbed transport. */
async function withFetch(handler: (url: string) => Response) {
  vi.resetModules();
  globalThis.__wheeldeal_cfg__ = undefined;
  globalThis.__wheeldeal_limits__ = undefined;
  globalThis.__wheeldeal_wa_rate__ = undefined;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => handler(String(input))));
  return {
    usage: await import("./usage"),
    evolution: await import("./evolution"),
    rc: await import("./runtime-config"),
  };
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const boom = () => new Response("upstream failure", { status: 500 });
const noTable = () =>
  new Response(JSON.stringify({ code: "42P01", message: 'relation "x" does not exist' }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });

describe("REPRODUCTION: a Supabase brownout must not disarm the safety systems", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    Object.assign(process.env, SUPA_ENV);
    // KILL_SWITCH is deliberately NOT in the deploy env list - that absence is
    // half the defect, so the test must reproduce it.
    delete process.env.KILL_SWITCH;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...saved };
    globalThis.__wheeldeal_cfg__ = undefined;
    globalThis.__wheeldeal_limits__ = undefined;
    globalThis.__wheeldeal_wa_rate__ = undefined;
  });

  describe("the kill switch", () => {
    it("reads KILLED when the vault cannot be read at all", async () => {
      const { usage } = await withFetch(boom);
      // Old behaviour: `undefined === "1"` -> false -> the emergency stop
      // silently disengaged during the outage.
      expect(await usage.killSwitchOn()).toBe(true);
    });

    it("stays OFF when the vault reads fine and the switch is simply unset", async () => {
      const { usage } = await withFetch(() => ok([{ key: "OPERATOR_NAME", value: "v1:x:y:z" }]));
      expect(await usage.killSwitchOn()).toBe(false);
    });

    it("stays OFF during an outage if the environment answers - env does not go unreadable", async () => {
      process.env.KILL_SWITCH = "0";
      const { usage } = await withFetch(boom);
      expect(await usage.killSwitchOn()).toBe(false);
    });

    it("...and env still turns it ON during an outage", async () => {
      process.env.KILL_SWITCH = "1";
      const { usage } = await withFetch(boom);
      expect(await usage.killSwitchOn()).toBe(true);
    });

    it("is OFF with no Supabase configured at all - demo mode is not an outage", async () => {
      delete process.env.SUPABASE_URL;
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      const { usage } = await withFetch(boom);
      expect(await usage.killSwitchOn()).toBe(false);
    });
  });

  describe("the per-user daily caps", () => {
    it("REFUSE when api_usage is unreadable - the count is unknown, not zero", async () => {
      const { usage } = await withFetch((url) =>
        url.includes("api_usage") ? boom() : ok([])
      );
      const gate = await usage.checkDailyLimit("search", "a@b.co", "LIMIT_SEARCHES_PER_DAY");
      // Old behaviour: sbSelect -> [] -> used = 0 -> allowed for the whole outage.
      expect(gate.allowed).toBe(false);
      expect(gate.reason).toBe("unreadable");
    });

    it("ALLOW when api_usage has never existed - a fresh install has genuinely spent nothing", async () => {
      const { usage } = await withFetch((url) =>
        url.includes("api_usage") ? noTable() : ok([])
      );
      const gate = await usage.checkDailyLimit("search", "a@b.co", "LIMIT_SEARCHES_PER_DAY");
      expect(gate.allowed).toBe(true);
    });

    it("still counts normally on a healthy read", async () => {
      const { usage } = await withFetch((url) =>
        url.includes("api_usage") ? ok([{ count: 1 }, { count: 1 }]) : ok([])
      );
      const gate = await usage.checkDailyLimit("search", "c@d.co", "LIMIT_SEARCHES_PER_DAY");
      expect(gate.allowed).toBe(true);
      expect(gate.used).toBe(3);
    });

    it("still refuses at the cap on a healthy read", async () => {
      const rows = Array.from({ length: 15 }, () => ({ count: 1 }));
      const { usage } = await withFetch((url) =>
        url.includes("api_usage") ? ok(rows) : ok([])
      );
      const gate = await usage.checkDailyLimit("search", "e@f.co", "LIMIT_SEARCHES_PER_DAY");
      expect(gate.allowed).toBe(false);
    });
  });

  describe("the WhatsApp anti-ban budgets", () => {
    it("REFUSE the send when the send history is unreadable", async () => {
      const { evolution } = await withFetch((url) =>
        url.includes("whatsapp_messages") ? boom() : ok([])
      );
      const verdict = await evolution.checkRateLimit("traveller@example.com");
      // Old behaviour: lastHour = 0 and lastDay = 0 from an empty array, so both
      // caps allowed - on a real personal number, during the exact window when
      // the kill switch and the daily caps had also just failed open.
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toMatch(/unreadable/i);
    });

    it("ALLOW when whatsapp_messages has never existed", async () => {
      const { evolution } = await withFetch((url) =>
        url.includes("whatsapp_messages") ? noTable() : ok([])
      );
      expect((await evolution.checkRateLimit("fresh@example.com")).allowed).toBe(true);
    });

    it("still refuses once the durable daily count is at the cap", async () => {
      const recent = new Date().toISOString();
      const rows = Array.from({ length: 60 }, (_, i) => ({ id: i, received_at: recent }));
      const { evolution } = await withFetch((url) =>
        url.includes("whatsapp_messages") ? ok(rows) : ok([])
      );
      expect((await evolution.checkRateLimit("busy@example.com")).allowed).toBe(false);
    });
  });

  describe("the read-state signal the three of them share", () => {
    it("a failed vault read is reported as unavailable, a good one as ok", async () => {
      const bad = await withFetch(boom);
      await bad.rc.getConfig("ANYTHING");
      expect(bad.rc.vaultReadState()).toBe("unavailable");

      const good = await withFetch(() => ok([]));
      await good.rc.getConfig("ANYTHING");
      expect(good.rc.vaultReadState()).toBe("ok");
    });

    it("getConfigStrict escalates only a genuine miss, never a value it can see", async () => {
      process.env.PRESENT_IN_ENV = "yes";
      try {
        const { rc } = await withFetch(boom);
        expect(await rc.getConfigStrict("PRESENT_IN_ENV")).toEqual({ value: "yes" });
        expect(await rc.getConfigStrict("ABSENT_EVERYWHERE")).toEqual({ error: "unavailable" });
      } finally {
        delete process.env.PRESENT_IN_ENV;
      }
    });
  });
});
