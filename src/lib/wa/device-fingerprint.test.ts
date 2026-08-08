import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// THE FLEET MUST NOT ANNOUNCE ITSELF AS A FLEET.
//
// Evolution passes CONFIG_SESSION_PHONE_CLIENT straight into makeWASocket as
// browser[0] - the label Meta sees for every linked companion device. It
// shipped as the literal "WheelDeal", so every traveller using this service
// advertised the same product name.
//
// That is the worst possible value, for a reason specific to how the two
// enforcement axes differ. The velocity axis (unanswered cold outbound) earns a
// SCOPED restriction and is a per-account property. The unofficial-client axis
// earns a FULL ban, fires even on accounts doing reply-only work, and is
// fleet-correlated: a single rule keyed on a shared config string resolves to
// 100% or 0% for everyone at once. No amount of pacing touches it, and no
// per-account safety rate describes it.
//
// "Mac OS" + "Chrome" is what ANTI-BAN.md always specified, and it is also what
// Baileys' own Browsers.macOS('Chrome') default produces - which matters
// because the pairing-code path ignores these vars entirely. Before this
// change, QR links and pairing-code links presented two different fingerprints;
// now they present the same one.

const PRODUCT_NAMES = [/WheelDeal/i, /wheel[-_ ]?deal/i];

function envValue(yaml: string, key: string): string | null {
  // render.yaml shape:  - key: NAME\n        value: VALUE
  const re = new RegExp(`-\\s*key:\\s*${key}\\s*\\n\\s*value:\\s*(.+)`);
  const m = yaml.match(re);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
}

describe("the deployed device fingerprint carries no product identity", () => {
  const renderYaml = read("render.yaml");

  it("render.yaml sets a real desktop client string", () => {
    const client = envValue(renderYaml, "CONFIG_SESSION_PHONE_CLIENT");
    expect(client).toBe("Mac OS");
  });

  it("render.yaml sets a real browser name", () => {
    expect(envValue(renderYaml, "CONFIG_SESSION_PHONE_NAME")).toBe("Chrome");
  });

  it("REGRESSION: no deploy artifact reintroduces the product name as the client", () => {
    for (const artifact of ["render.yaml", "GUIDE.md"]) {
      const text = read(artifact);
      // Find every assignment of the client var in any of the three dialects
      // these files use: render.yaml `value:`, GUIDE's `KEY = VALUE`, and the
      // docker `-e KEY="VALUE"` one-liner.
      const assignments = [
        ...text.matchAll(/CONFIG_SESSION_PHONE_CLIENT\s*[=:]\s*"?([^"\n]+)"?/g),
        ...text.matchAll(/-\s*key:\s*CONFIG_SESSION_PHONE_CLIENT\s*\n\s*value:\s*(.+)/g),
      ].map((m) => m[1].trim().replace(/^["']|["']$/g, ""));

      expect(assignments.length).toBeGreaterThan(0);
      for (const value of assignments) {
        for (const pattern of PRODUCT_NAMES) {
          expect(value).not.toMatch(pattern);
        }
      }
    }
  });

  it("the docs and the deployment agree - a doc that disagrees steers the next fix wrong", () => {
    const fromRender = envValue(renderYaml, "CONFIG_SESSION_PHONE_CLIENT");
    expect(read("ANTI-BAN.md")).toContain(`CONFIG_SESSION_PHONE_CLIENT=${fromRender}`);
    expect(read("GUIDE.md")).toContain(`CONFIG_SESSION_PHONE_CLIENT = ${fromRender}`);
  });

  it("the in-code fingerprint matches the server env, so QR and pairing agree", () => {
    // CLIENT_BROWSER is the per-instance field. On stock Evolution it is inert
    // (InstanceDto has no browser field), but it must not DISAGREE with the env
    // - a fork that does read it would otherwise split the fleet in two.
    const evo = read("src/lib/evolution.ts");
    const m = evo.match(/CLIENT_BROWSER[^=]*=\s*\[([^\]]+)\]/);
    expect(m).toBeTruthy();
    const [platform, browser] = m![1]
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""));
    expect(platform).toBe(envValue(renderYaml, "CONFIG_SESSION_PHONE_CLIENT"));
    expect(browser).toBe(envValue(renderYaml, "CONFIG_SESSION_PHONE_NAME"));
  });
});
