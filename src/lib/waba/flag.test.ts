import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const config: Record<string, string | null> = {};
vi.mock("../runtime-config", () => ({
  getConfig: async (k: string) => config[k] ?? null,
}));

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// THE OWNER'S CONSTRAINT, AS A TEST.
//
// "Keep the old engine as default for now. The new official API path should be
// fully built, integrated and ready to go under the hood, but set to OFF by
// default. Once we secure a provider I should only need to plug in the
// credentials, configure the settings, and flip the switch."
//
// That is one invariant and several consequences, and the invariant is the one a
// future edit is most likely to break by "simplifying" a branch: with the flag
// off, NOTHING changes - no path, no read, no request.

beforeEach(() => {
  for (const k of Object.keys(config)) delete config[k];
});

const fullyConfigured = () => {
  config.WABA_ENABLED = "on";
  config.WABA_BASE_URL = "https://example.test";
  config.WABA_API_KEY = "k";
  config.WABA_SENDER_ID = "s";
  config.WABA_TEMPLATE_FIRST_CONTACT = "first_contact";
  config.WABA_LINK_BASE = "https://wheeldeal.test/h";
};

describe("absent configuration means OFF", () => {
  it("a fresh clone with no config has the handoff disabled", async () => {
    const { wabaConfig, wabaBlockReason } = await import("./config");
    const c = await wabaConfig();
    expect(c.enabled).toBe(false);
    expect(wabaBlockReason(c)).toBe("flag-off");
  });

  it("this is the OPPOSITE default from the warm-up gate, deliberately", async () => {
    // An unset warm-up gate should still qualify buyers (absence must not
    // disengage a product decision). An unset messaging integration must never
    // start sending on a rented account. Same reasoning, opposite direction.
    const { warmupGateOn } = await import("../warmup");
    const { wabaReady } = await import("./config");
    expect(await warmupGateOn()).toBe(true);
    expect(await wabaReady()).toBe(false);
  });

  it("only an explicit affirmative turns it on", async () => {
    const { wabaConfig } = await import("./config");
    for (const v of ["", "off", "0", "false", "no", "maybe", "ON!"]) {
      config.WABA_ENABLED = v;
      expect((await wabaConfig()).enabled, `"${v}" must not enable`).toBe(false);
    }
    for (const v of ["on", "1", "true", "yes", " ON "]) {
      config.WABA_ENABLED = v;
      expect((await wabaConfig()).enabled, `"${v}" must enable`).toBe(true);
    }
  });
});

describe("credential absence is equivalent to the flag being off, and says which", () => {
  it("the flag alone is not enough", async () => {
    const { wabaConfig, wabaBlockReason } = await import("./config");
    config.WABA_ENABLED = "on";
    expect(wabaBlockReason(await wabaConfig())).toBe("missing-credentials");
  });

  it("credentials without an approved template are not enough", async () => {
    const { wabaConfig, wabaBlockReason } = await import("./config");
    fullyConfigured();
    config.WABA_TEMPLATE_FIRST_CONTACT = "";
    expect(wabaBlockReason(await wabaConfig())).toBe("missing-template");
  });

  it("a missing link base BLOCKS rather than warns", async () => {
    // The link base is the approved button target. A template whose button
    // points nowhere still consumes the one contact per agency per day the
    // governor allows, so a soft warning here would waste the scarcest thing
    // in the whole design.
    const { wabaConfig, wabaBlockReason } = await import("./config");
    fullyConfigured();
    config.WABA_LINK_BASE = "";
    expect(wabaBlockReason(await wabaConfig())).toBe("missing-link-base");
  });

  it("fully configured is ready", async () => {
    const { wabaReady } = await import("./config");
    fullyConfigured();
    expect(await wabaReady()).toBe(true);
  });
});

describe("dry run ships ON and nothing leaves the process", () => {
  it("an unset dry-run flag means DRY, not live", async () => {
    // The first live send has to be a decision, not a side effect of pasting a
    // key. On a rented WABA a malformed first contact costs quality rating we
    // cannot buy back.
    const { wabaConfig } = await import("./config");
    expect((await wabaConfig()).dryRun).toBe(true);
    config.WABA_ENABLED = "on";
    expect((await wabaConfig()).dryRun).toBe(true);
  });

  it("only an explicit off turns dry run off", async () => {
    const { wabaConfig } = await import("./config");
    config.WABA_DRY_RUN = "off";
    expect((await wabaConfig()).dryRun).toBe(false);
  });

  it("a dry-run send makes no network call and still renders the wire text", async () => {
    fullyConfigured();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { wabaSend } = await import("./send");
    const r = await wabaSend({
      lane: "template",
      to: "+66 81 234 5678",
      templateName: "first_contact",
      language: "en",
      variables: ["Sunrise Rentals", "scooter", "12 Aug"],
      buttonSuffix: "tok123",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    // The preview is the point: you can read exactly what would have gone out.
    expect(r.preview).toContain("first_contact");
    expect(r.preview).toContain("Sunrise Rentals");
    expect(r.preview).toContain("https://wheeldeal.test/h/tok123");
    fetchSpy.mockRestore();
  });

  it("a blocked send makes no network call either", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { wabaSend } = await import("./send");
    const r = await wabaSend({ lane: "freeform", to: "66812345678", text: "hi" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.error).toBe("flag-off");
    fetchSpy.mockRestore();
  });
});

describe("the template respects what Meta will actually approve", () => {
  const send = readCode("src/lib/waba/send.ts");

  it("the button target is our own domain, never a wa.me link", () => {
    // `wa.me` URLs and link shorteners are named template-rejection causes, so
    // a template carrying one would never have been approved at all.
    expect(send).not.toMatch(/wa\.me/);
    expect(send).toMatch(/sub_type: "url"/);
  });

  it("the button carries a variable suffix on a fixed approved base", () => {
    expect(send).toMatch(/parameters: \[\{ type: "text", text: m\.buttonSuffix \}\]/);
  });

  it("131049 is recognised as a recipient cap, not a retryable failure", () => {
    // Retrying burns quality rating on a message that is guaranteed
    // undeliverable until the recipient's own cap resets - and the cap is a
    // property of their inbox across ALL businesses, not of our request.
    expect(send).toMatch(/recipientCapped: code === 131049/);
  });

  it("a send never throws into the caller", () => {
    // This runs inside drain loops against an asset shared by every user at
    // once; a throw here takes the loop down for everybody.
    expect(send).toMatch(/catch \(e\) \{[\s\S]{0,260}return \{/);
  });

  it("it has a hard timeout, like the existing Cloud API sender", () => {
    expect(send).toMatch(/AbortController/);
    expect(send).toMatch(/12_000/);
  });
});

describe("REGRESSION: the legacy path is untouched", () => {
  it("no existing sender imports the new module", () => {
    // The whole point of the flag is that the live engine does not change. If
    // wa-guard or evolution reaches into waba/, the old path's behaviour now
    // depends on new configuration - which is exactly what was promised not to
    // happen.
    for (const p of ["src/lib/wa-guard.ts", "src/lib/evolution.ts", "src/lib/whatsapp.ts"]) {
      expect(readCode(p), `${p} must not depend on the handoff`).not.toMatch(/waba\//);
    }
  });

  it("the handoff module does not reach into the traveller's send path either", () => {
    // The two governors must not fight. Part 0.37 already recorded what happens
    // when two rate systems meter the same thing: the plan model loses silently.
    const cfg = readCode("src/lib/waba/config.ts");
    const send = readCode("src/lib/waba/send.ts");
    for (const code of [cfg, send]) {
      expect(code).not.toMatch(/wa-guard|checkRateLimit|drainOutbox/);
    }
  });
});
