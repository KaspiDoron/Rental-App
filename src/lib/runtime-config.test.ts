import { describe, it, expect, afterEach, vi } from "vitest";
// server-only is a no-op import at runtime; stub it so vitest can load the module.
vi.mock("server-only", () => ({}));
import { encryptString, decryptString } from "./runtime-config";

// SESSION_SECRET rotation recovery: a value encrypted under an OLD secret must
// still decrypt after the secret rotates, PROVIDED the old secret is offered via
// SESSION_SECRET_PREVIOUS. This is the "all my keys vanished after the Vercel ->
// Cloud Run migration" recovery path - the vault rows are intact, just locked
// under the previous key.

const OLD = "old-session-secret-value-1234567890";
const NEW = "new-session-secret-value-abcdefghij";

afterEach(() => {
  delete process.env.SESSION_SECRET;
  delete process.env.SESSION_SECRET_PREVIOUS;
});

describe("runtime-config vault decryption - SESSION_SECRET rotation recovery", () => {
  it("round-trips under a single stable secret", () => {
    process.env.SESSION_SECRET = OLD;
    const blob = encryptString("sk-live-example-key");
    expect(decryptString(blob)).toBe("sk-live-example-key");
  });

  it("a rotated secret ALONE cannot read old rows (this is the reported outage)", () => {
    process.env.SESSION_SECRET = OLD;
    const blob = encryptString("gsk_groq_example");
    // Secret rotates; no previous configured.
    process.env.SESSION_SECRET = NEW;
    delete process.env.SESSION_SECRET_PREVIOUS;
    expect(decryptString(blob)).toBeNull();
  });

  it("SESSION_SECRET_PREVIOUS recovers old rows without reverting the new secret", () => {
    process.env.SESSION_SECRET = OLD;
    const blob = encryptString("gsk_groq_example");
    process.env.SESSION_SECRET = NEW;
    process.env.SESSION_SECRET_PREVIOUS = OLD;
    expect(decryptString(blob)).toBe("gsk_groq_example");
  });

  it("supports several comma-separated previous secrets (multiple rotations)", () => {
    process.env.SESSION_SECRET = OLD;
    const blob = encryptString("evolution-api-key");
    process.env.SESSION_SECRET = NEW;
    process.env.SESSION_SECRET_PREVIOUS = `some-other-old-secret-000000000000, ${OLD}`;
    expect(decryptString(blob)).toBe("evolution-api-key");
  });

  it("new writes use the CURRENT secret, readable without the previous fallback", () => {
    process.env.SESSION_SECRET = NEW;
    process.env.SESSION_SECRET_PREVIOUS = OLD;
    const blob = encryptString("freshly-saved-key");
    delete process.env.SESSION_SECRET_PREVIOUS;
    expect(decryptString(blob)).toBe("freshly-saved-key");
  });
});
