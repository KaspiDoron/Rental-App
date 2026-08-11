import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

vi.mock("server-only", () => ({}));

// FOUR GATES THAT OPENED WHEN THEIR SECRET COULD NOT BE READ.
//
// One shape, four costumes: `if (secret) { check() }`. The author's intent was
// "this check is optional in dev". The behaviour is "authentication disables
// itself whenever the vault hiccups" - and every one of these secrets comes
// from the Supabase-backed Key Vault, which is exactly the thing that hiccups.
//
//   auth/google       - `aud` verified only `if (expectedAud)`. Google's
//                       tokeninfo validates a token minted for ANY OAuth
//                       client, so with expectedAud undefined, any Google ID
//                       token from any app replayed here minted a wd_session
//                       for that token's email. Account takeover, no trace.
//   webhooks/whatsapp - the HMAC checked only `if (appSecret)`. Unsigned POSTs
//                       accepted, stored, and fed to processVendorReply: anyone
//                       with the URL could fabricate a shop's prices inside a
//                       live negotiation, and the agent would bargain against
//                       them.
//   admin/users       - not a gate but the same carelessness: `...u` spread
//                       every account's scrypt passwordHash and home-stay
//                       COORDINATES to a browser.
//   request-origin    - `x-forwarded-host` is client input, and it chose the
//                       URL the server fetched (SSRF), the URL registered on
//                       Evolution WITH THE WEBHOOK TOKEN IN IT, and PayPal's
//                       return URL.
//
// Absent secret means REFUSE, never SKIP.

const readCode = (p: string) =>
  readFileSync(join(process.cwd(), p), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("Google sign-in: no audience, no session", () => {
  const route = readCode("src/app/api/auth/google/route.ts");

  it("REGRESSION: the audience check is not conditional on the audience existing", () => {
    expect(
      route,
      "`if (expectedAud && ...)` makes a vault brownout accept any OAuth client's token"
    ).not.toMatch(/if \(expectedAud && info\.aud !== expectedAud\)/);
  });

  it("an unresolvable client ID refuses the sign-in", () => {
    expect(route).toMatch(/if \(!expectedAud\) \{/);
    expect(route).toMatch(/status: 503/);
    // The refusal must be reachable BEFORE the audience comparison, or the
    // comparison runs against undefined and passes for a token with no aud.
    expect(route.indexOf("if (!expectedAud)")).toBeLessThan(
      route.indexOf("info.aud !== expectedAud")
    );
  });

  it("and it points the traveller at the path that still works", () => {
    expect(route).toMatch(/use email sign-in/);
  });
});

describe("Cloud webhook: no app secret, no writes", () => {
  const route = readCode("src/app/api/webhooks/whatsapp/route.ts");

  it("REGRESSION: the signature check is not wrapped in `if (appSecret)`", () => {
    expect(route).not.toMatch(/if \(appSecret\) \{/);
  });

  it("an absent secret is a 401, not a skipped check", () => {
    expect(route).toMatch(/if \(!appSecret\) \{/);
    const idx = route.indexOf("if (!appSecret)");
    const sigIdx = route.indexOf("signatureValid(raw, sig, appSecret)");
    const parseIdx = route.indexOf("JSON.parse(raw)");
    expect(idx).toBeGreaterThan(-1);
    expect(idx).toBeLessThan(sigIdx);
    // Nothing is parsed, stored or dispatched before both checks pass.
    expect(sigIdx).toBeLessThan(parseIdx);
  });

  it("the stale 'returns true when no secret is configured' claim is gone", () => {
    expect(
      route,
      "the comment described behaviour the function never had - the SKIP was at the call site"
    ).not.toMatch(/Returns true\s*\n?\s*when no app secret is configured/);
  });
});

describe("the management user list does not hand out password hashes", () => {
  const route = readCode("src/app/api/admin/users/route.ts");

  it("REGRESSION: the whole record is no longer spread into the response", () => {
    expect(route).not.toMatch(/users: users\.map\(\(u\) => \(\{\s*\.\.\.u,/);
  });

  it("projects an explicit allow-list", () => {
    expect(route).toMatch(/function publicUser\(/);
    expect(route).toMatch(/email: u\.email/);
    expect(route).toMatch(/plan: u\.plan/);
  });

  it("passwordHash and the stay COORDINATES never leave the server", () => {
    expect(route).not.toMatch(/passwordHash/);
    expect(route).not.toMatch(/stayLat/);
    expect(route).not.toMatch(/stayLng/);
    // The human-readable label is what an operator actually needs, and it is
    // not a location fix.
    expect(route).toMatch(/stayLabel: u\.stayLabel/);
  });
});

describe("x-forwarded-host is client input and is now allow-listed", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  const reqWith = (headers: Record<string, string>) =>
    new Request("http://0.0.0.0:8080/api/x", { headers });

  async function load(siteOrigin: string, trustedHosts?: string) {
    vi.resetModules();
    vi.doMock("server-only", () => ({}));
    vi.doMock("@/lib/site", () => ({ resolveSiteOrigin: async () => siteOrigin }));
    vi.doMock("@/lib/runtime-config", () => ({
      getConfig: async (k: string) => (k === "TRUSTED_HOSTS" ? trustedHosts : undefined),
    }));
    return import("./request-origin");
  }

  it("REPRODUCTION: the old resolver believed any host it was handed", async () => {
    const { publicRequestOrigin } = await load("https://wheeldeal.pro");
    expect(
      publicRequestOrigin(reqWith({ "x-forwarded-host": "attacker.example" })),
      "one header chose the origin the server would fetch and register"
    ).toBe("https://attacker.example");
  });

  it("an unrecognised forwarded host is refused", async () => {
    const { trustedRequestOrigin } = await load("https://wheeldeal.pro");
    expect(await trustedRequestOrigin(reqWith({ "x-forwarded-host": "attacker.example" }))).toBeNull();
    // Including the lookalikes.
    expect(
      await trustedRequestOrigin(reqWith({ "x-forwarded-host": "wheeldeal.pro.attacker.example" }))
    ).toBeNull();
  });

  it("the owner's own host is accepted", async () => {
    const { trustedRequestOrigin } = await load("https://wheeldeal.pro");
    expect(await trustedRequestOrigin(reqWith({ "x-forwarded-host": "wheeldeal.pro" }))).toBe(
      "https://wheeldeal.pro"
    );
  });

  it("TRUSTED_HOSTS widens it, so a gateway URL needs no redeploy", async () => {
    const { trustedRequestOrigin } = await load(
      "https://wheeldeal.pro",
      "gw-abc.a.run.app, staging.wheeldeal.pro"
    );
    expect(await trustedRequestOrigin(reqWith({ "x-forwarded-host": "gw-abc.a.run.app" }))).toBe(
      "https://gw-abc.a.run.app"
    );
    expect(await trustedRequestOrigin(reqWith({ "x-forwarded-host": "other.a.run.app" }))).toBeNull();
  });

  it("an UNREADABLE vault narrows the list, never widens it", async () => {
    vi.resetModules();
    vi.doMock("server-only", () => ({}));
    vi.doMock("@/lib/site", () => ({ resolveSiteOrigin: async () => "https://wheeldeal.pro" }));
    vi.doMock("@/lib/runtime-config", () => ({
      getConfig: async () => {
        throw new Error("supabase down");
      },
    }));
    const { trustedRequestOrigin } = await import("./request-origin");
    // The canonical origin is still trusted; nothing else is. This is the whole
    // difference from every other bug in this commit: the failure direction of
    // an allow-list is fewer entries, so an outage cannot open it.
    expect(await trustedRequestOrigin(reqWith({ "x-forwarded-host": "wheeldeal.pro" }))).toBe(
      "https://wheeldeal.pro"
    );
    expect(await trustedRequestOrigin(reqWith({ "x-forwarded-host": "attacker.example" }))).toBeNull();
  });

  it("selfKickOrigin falls back to the canonical origin rather than obeying", async () => {
    const { selfKickOrigin } = await load("https://wheeldeal.pro");
    expect(
      await selfKickOrigin(reqWith({ "x-forwarded-host": "attacker.example" })),
      "the app fetched whatever host the caller named - SSRF with our own credentials"
    ).toBe("https://wheeldeal.pro");
  });

  it("the bind-address problem it was written for still stays fixed", async () => {
    const { selfKickOrigin } = await load("https://wheeldeal.pro");
    // No forwarded header at all: req.url is the Cloud Run bind address, which
    // routableOrigin rejects, so we fall through to the canonical origin. This
    // is the original I-1 defect and it must not come back.
    expect(await selfKickOrigin(reqWith({}))).toBe("https://wheeldeal.pro");
  });
});

describe("every consumer that turns an origin into an action uses the trusted one", () => {
  it.each([
    ["src/app/api/wa/connect/route.ts", "registers the Evolution webhook URL"],
    ["src/app/api/admin/wa-doctor/route.ts", "re-arms the webhook with the token in the URL"],
    ["src/app/api/billing/checkout/route.ts", "becomes PayPal's return URL"],
    ["src/app/api/admin/ping-url/route.ts", "prints a token-bearing URL"],
  ])("%s - %s", (path) => {
    const code = readCode(path);
    expect(code).toMatch(/trustedRequestOrigin\(req\)/);
    expect(code, "the untrusted resolver must not survive alongside it").not.toMatch(
      /publicRequestOrigin\(req\)/
    );
  });

  it("selfKickOrigin is the only self-fetch resolver, and it is trusted", () => {
    const lib = readCode("src/lib/request-origin.ts");
    const fn = lib.slice(lib.indexOf("export async function selfKickOrigin"));
    expect(fn).toMatch(/await trustedRequestOrigin\(req\)/);
    expect(fn).not.toMatch(/publicRequestOrigin\(req\)/);
  });
});
