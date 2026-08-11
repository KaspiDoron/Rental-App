import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// AN EMERGENCY STOP THAT ARRIVES HALF A MINUTE LATE IS NOT AN EMERGENCY STOP.
//
// `killSwitchOn()` read through `getConfigStrict`, which reads the whole vault
// on a 30s per-instance cache. So the owner pulling the handle mid-incident
// left every WARM instance sending WhatsApp messages, spending LLM tokens and
// taking PayPal checkouts for up to thirty more seconds - and a warm instance
// is the normal case, not the edge case.
//
// The fail-CLOSED behaviour is the part that must not change: unreadable still
// means KILLED (src/lib/fail-closed.test.ts owns that contract, and it still
// passes unmodified). This file is about the other half - that a flip is
// OBSERVED promptly - and it is executed against a stubbed transport rather
// than pinned to source, because "the constant is 3000" would tell us nothing
// about whether the read actually goes anywhere near the vault.

const SUPA_ENV = {
  SUPABASE_URL: "https://stub.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-stub",
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** A vault whose KILL_SWITCH value the test can flip mid-run, like the owner. */
function stubVault(initial: string) {
  const seen: string[] = [];
  const store = { kill: initial };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      seen.push(url);
      // The single-row reader asks for one key by name; the whole-vault reader
      // asks for the filtered table. Answer each in its own shape.
      if (url.includes("key=eq.KILL_SWITCH")) return json([{ value: store.kill }]);
      // The whole-vault read is answered empty on purpose: these tests measure
      // WHEN each path goes back to the vault, not what it decodes, and a
      // plaintext row here would only trip the decrypt warning.
      return json([]);
    })
  );
  return { store, seen };
}

async function freshModules() {
  vi.resetModules();
  globalThis.__wheeldeal_cfg__ = undefined;
  return { usage: await import("./usage"), rc: await import("./runtime-config") };
}

describe("the stop arrives in seconds, not in half a minute", () => {
  const saved = { ...process.env };

  beforeEach(() => {
    Object.assign(process.env, SUPA_ENV);
    // KILL_SWITCH is deliberately not a deploy env var - an env value would
    // short-circuit the vault read and the test would prove nothing.
    delete process.env.KILL_SWITCH;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    process.env = { ...saved };
    globalThis.__wheeldeal_cfg__ = undefined;
  });

  it("REPRODUCTION: a warm instance sees the flip within seconds", async () => {
    const { store } = stubVault("0");
    const { usage } = await freshModules();

    expect(await usage.killSwitchOn()).toBe(false); // warm, running
    store.kill = "1"; // the owner pulls the handle

    // Inside the window the instance is still holding its last read - that is
    // the bounded cost of not querying on literally every send.
    expect(await usage.killSwitchOn()).toBe(false);

    vi.advanceTimersByTime(3_500);
    expect(await usage.killSwitchOn()).toBe(true);
  });

  it("...at a moment when the 30s cache has not even asked again", async () => {
    // The contrast IS the fix, and it is measured by who goes back to the
    // vault. Same instant, same flipped switch: the general config path - what
    // the switch used to read through - has not re-read at all and would not
    // for another twenty-odd seconds, while the gate has re-read and changed
    // its answer.
    const { store, seen } = stubVault("0");
    const { usage, rc } = await freshModules();

    await usage.killSwitchOn();
    await rc.getConfig("KILL_SWITCH");
    const vaultReadsBefore = seen.filter((u) => u.includes("not.like")).length;
    expect(vaultReadsBefore).toBe(1);

    store.kill = "1"; // the owner pulls the handle
    vi.advanceTimersByTime(3_500);

    expect(await usage.killSwitchOn(), "the safety gate").toBe(true);
    await rc.getConfig("KILL_SWITCH");
    expect(
      seen.filter((u) => u.includes("not.like")).length,
      "the old read path has not gone back to the vault"
    ).toBe(vaultReadsBefore);
  });

  it("costs ONE query however many sends are in flight", async () => {
    // A gate on every send path cannot afford a round trip per send. Concurrent
    // callers share the in-flight read, and the window covers the rest.
    const { seen } = stubVault("0");
    const { usage } = await freshModules();

    await Promise.all(Array.from({ length: 25 }, () => usage.killSwitchOn()));
    const reads = seen.filter((u) => u.includes("key=eq.KILL_SWITCH"));
    expect(reads).toHaveLength(1);
  });

  it("reads ONE row by exact key, not the whole vault", async () => {
    // The 30s cache exists because the vault read is a full-table download plus
    // a decrypt of every row. Doing THAT every 3s would be a regression dressed
    // up as a fix.
    const { seen } = stubVault("0");
    const { usage } = await freshModules();
    await usage.killSwitchOn();

    const reads = seen.filter((u) => u.includes("app_config"));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatch(/key=eq\.KILL_SWITCH/);
    expect(reads[0]).toMatch(/limit=1/);
    expect(reads[0], "must not be the whole-vault select").not.toMatch(/not\.like/);
  });

  it("the instance that FLIPPED the switch is not the last to notice", async () => {
    // setConfig drops the per-key cache as well as the vault cache, so the
    // admin request that wrote the value sees its own write immediately.
    const { store } = stubVault("0");
    const { usage, rc } = await freshModules();

    expect(await usage.killSwitchOn()).toBe(false);
    store.kill = "1";
    await rc.setConfig("KILL_SWITCH", "1");
    expect(await usage.killSwitchOn()).toBe(true);
  });

  it("REGRESSION: unreadable is still KILLED, at any point in the window", async () => {
    // The freshness change must not have loosened the fail-closed contract.
    const { usage } = await freshModules();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    expect(await usage.killSwitchOn()).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(await usage.killSwitchOn()).toBe(true);
  });

  it("an outage does not become a query storm either", async () => {
    // The negative window is short, but it has to exist: without it every send
    // during a Supabase wobble issues its own doomed request.
    const seen: string[] = [];
    const { usage } = await freshModules();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        seen.push(String(input));
        return new Response("boom", { status: 500 });
      })
    );
    await Promise.all(Array.from({ length: 20 }, () => usage.killSwitchOn()));
    expect(seen.filter((u) => u.includes("key=eq.KILL_SWITCH"))).toHaveLength(1);
  });
});
