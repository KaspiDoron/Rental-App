import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import {
  deriveWebhookToken,
  classifyToken,
  sameWebhookTarget,
  classifyRegisteredWebhook,
} from "./webhook-token";

const expectFor = (secret: string) =>
  createHash("sha256").update(`wd-webhook:${secret}`).digest("hex").slice(0, 32);

describe("deriveWebhookToken - current token from the live secret", () => {
  it("derives sha256(wd-webhook:secret).slice(0,32) for a real secret", () => {
    const secret = "a-very-real-session-secret-value";
    expect(deriveWebhookToken({ secret })).toBe(expectFor(secret));
    expect(deriveWebhookToken({ secret })).toHaveLength(32);
  });

  it("a rotated secret produces a DIFFERENT token (the root-cause of the incident)", () => {
    expect(deriveWebhookToken({ secret: "old-secret-old-secret-1234" })).not.toBe(
      deriveWebhookToken({ secret: "new-secret-new-secret-5678" })
    );
  });

  it("a short/absent secret is null in production, dev-fallback otherwise", () => {
    expect(deriveWebhookToken({ secret: "short", nodeEnv: "production" })).toBeNull();
    expect(deriveWebhookToken({ secret: undefined, nodeEnv: "production" })).toBeNull();
    const dev = deriveWebhookToken({ secret: "short", nodeEnv: "development" });
    expect(dev).toBe(createHash("sha256").update("wd-webhook:dev-only").digest("hex").slice(0, 32));
  });
});

describe("classifyToken", () => {
  const current = expectFor("the-current-secret-value-here");
  it("current when it matches, foreign when it doesn't, none when absent", () => {
    expect(classifyToken(current, current)).toBe("current");
    expect(classifyToken("deadbeef", current)).toBe("foreign");
    expect(classifyToken(null, current)).toBe("none");
    expect(classifyToken("", current)).toBe("none");
  });
});

describe("sameWebhookTarget - read-before-write comparator", () => {
  const origin = "https://api.wheeldeal.app";
  const token = expectFor("secretsecretsecretsecret");
  it("matches the canonical URL exactly and tolerates a trailing slash + extra params", () => {
    expect(sameWebhookTarget(`${origin}/api/webhooks/evolution?token=${token}`, origin, token)).toBe(true);
    expect(
      sameWebhookTarget(`${origin}/api/webhooks/evolution/?token=${token}&x=1`, origin, token)
    ).toBe(true);
  });
  it("false on a stale token, a different origin, or a missing token", () => {
    expect(sameWebhookTarget(`${origin}/api/webhooks/evolution?token=OLD`, origin, token)).toBe(false);
    expect(
      sameWebhookTarget(`https://other.example.com/api/webhooks/evolution?token=${token}`, origin, token)
    ).toBe(false);
    expect(sameWebhookTarget(`${origin}/api/webhooks/evolution`, origin, token)).toBe(false);
    expect(sameWebhookTarget(null, origin, token)).toBe(false);
    expect(sameWebhookTarget("not a url", origin, token)).toBe(false);
  });
});

describe("classifyRegisteredWebhook - the doctor verdict", () => {
  const origin = "https://api.wheeldeal.app";
  const current = expectFor("doctorsecretdoctorsecret");
  it("current token + matching origin", () => {
    const r = classifyRegisteredWebhook(
      `${origin}/api/webhooks/evolution?token=${current}`,
      current,
      origin
    );
    expect(r).toEqual({ tokenState: "current", originMatch: true });
  });
  it("a stale (foreign) token is flagged, origin still compared", () => {
    const r = classifyRegisteredWebhook(
      `${origin}/api/webhooks/evolution?token=STALE_OLD_TOKEN`,
      current,
      origin
    );
    expect(r.tokenState).toBe("foreign");
    expect(r.originMatch).toBe(true);
  });
  it("a preview origin is flagged as originMatch:false", () => {
    const r = classifyRegisteredWebhook(
      `https://preview-xyz.example.com/api/webhooks/evolution?token=${current}`,
      current,
      origin
    );
    expect(r.originMatch).toBe(false);
  });
  it("no registered URL => none", () => {
    expect(classifyRegisteredWebhook(null, current, origin)).toEqual({
      tokenState: "none",
      originMatch: null,
    });
  });
});
