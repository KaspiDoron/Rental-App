import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const cfg: Record<string, string | undefined> = {};
vi.mock("./runtime-config", () => ({
  getConfig: async (k: string) => cfg[k],
  setConfig: async () => ({ ok: true, persistent: false }),
}));

import { allowedPlanFor, isAllowed } from "./allowlist";

beforeEach(() => {
  for (const k in cfg) delete cfg[k];
  delete process.env.BETA_LOCK;
  delete process.env.BETA_ALLOWLIST;
  delete process.env.OWNER_EMAIL;
});

describe("allowedPlanFor - the private-beta login gate", () => {
  it("the owner is always allowed as ultra", async () => {
    expect(await allowedPlanFor("kaspidoron@gmail.com")).toBe("ultra");
    expect(await allowedPlanFor("KASPIDORON@gmail.com")).toBe("ultra"); // case-insensitive
  });

  it("an unlisted email is refused (null) - cannot hold a session", async () => {
    expect(await allowedPlanFor("stranger@example.com")).toBeNull();
    expect(await isAllowed("stranger@example.com")).toBe(false);
  });

  it("a listed tester gets their pinned plan from the config allowlist", async () => {
    cfg["beta_allowlist"] = JSON.stringify([
      { email: "tester@example.com", plan: "pro" },
      { email: "vip@example.com", plan: "ultra" },
    ]);
    expect(await allowedPlanFor("tester@example.com")).toBe("pro");
    expect(await allowedPlanFor("vip@example.com")).toBe("ultra");
    expect(await allowedPlanFor("nope@example.com")).toBeNull();
  });

  it("BETA_LOCK=off opens the gate to anyone (as free)", async () => {
    process.env.BETA_LOCK = "off";
    expect(await allowedPlanFor("anyone@example.com")).toBe("free");
  });

  it("honors the env BETA_ALLOWLIST fallback", async () => {
    process.env.BETA_ALLOWLIST = "vip@example.com:ultra";
    expect(await allowedPlanFor("vip@example.com")).toBe("ultra");
  });
});
