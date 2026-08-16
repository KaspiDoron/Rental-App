import { describe, it, expect } from "vitest";
import { providerFailureKind, providerNeedsOwner, providerFailureCopy } from "./provider-health";

// THE OWNER'S SCREENSHOT: SambaNova painted red, with a JSON dump, for being
// popular. Every case below is a real wire string; the classifier exists so the
// panel can tell "your key is broken" apart from "their tier is full".

describe("a busy provider is not a broken one", () => {
  it("THE REPORTED CASE: SambaNova's high-demand 429", () => {
    const detail =
      'primary gpt-oss-120b: sambanova 429 - {"error":{"code":null,"message":"gpt-oss-120b-8k is currently experiencing high demand. Please try again later!","param":null,"type":""},"request_id":"53375887"} | fallback Meta-Llama-3.3-70B-Instruct: sambanova 429 - {"error":{"message":"Meta-Llama-3.3-70B-Instruct-8k is currently experiencing high demand."}}';
    expect(providerFailureKind(detail)).toBe("busy");
    expect(providerNeedsOwner("busy"), "nothing to fix - the chain moves on").toBe(false);
    expect(providerFailureCopy("busy", "sambanova")).toMatch(/free tier is at capacity/);
    expect(providerFailureCopy("busy", "sambanova")).toMatch(/nothing needs fixing/);
  });

  it("...and the other shapes of the same thing", () => {
    for (const d of [
      "openrouter 429 - rate limit exceeded",
      "anthropic 529 - overloaded_error",
      "groq: too many requests, try again later",
      "at capacity",
    ]) {
      expect(providerFailureKind(d), d).toBe("busy");
    }
  });
});

describe("but a real fault still reads as one", () => {
  it("a revoked or wrong key needs the owner", () => {
    for (const d of [
      "openai 401 - invalid_api_key",
      "gemini 403 - API key not valid. Please pass a valid API key.",
      "mistral: unauthorized",
    ]) {
      expect(providerFailureKind(d), d).toBe("auth");
      expect(providerNeedsOwner("auth")).toBe(true);
    }
  });

  it("A QUOTA-EXHAUSTED KEY IS THE OWNER'S PROBLEM, EVEN THOUGH IT ARRIVES AS A 429", () => {
    // The one case where the order of the checks is load-bearing: classifying
    // this as `busy` would tell the owner to relax about a key that has stopped
    // working until they pay. It must beat the 429 rule.
    expect(providerFailureKind("openai 429 - insufficient_quota: You exceeded your current quota")).toBe(
      "auth"
    );
    expect(providerFailureKind("402 payment required")).toBe("auth");
  });

  it("a retired model id points at the override that fixes it", () => {
    expect(providerFailureKind("groq 404 - model `llama-3.1-70b` does not exist")).toBe("model");
    expect(providerFailureCopy("model", "groq")).toMatch(/GROQ_MODEL/);
    expect(providerNeedsOwner("model")).toBe(true);
  });

  it("a timeout is slow-or-down, not misconfigured", () => {
    expect(providerFailureKind("cerebras timed out after 9000ms (no response)")).toBe("timeout");
    expect(providerNeedsOwner("timeout")).toBe(false);
  });
});

describe("it never dresses up what it does not understand", () => {
  it("an unrecognised body stays unknown and keeps its evidence", () => {
    expect(providerFailureKind("something nobody has seen before")).toBe("unknown");
    expect(providerFailureKind("")).toBe("unknown");
    expect(providerFailureKind(null)).toBe("unknown");
    expect(providerFailureCopy("unknown", "together")).toMatch(/cannot classify/);
  });

  it("the panel shows the interpretation AND the raw detail, never one alone", () => {
    // A classifier that replaced the wire text would be the panel lying more
    // politely - the thing this codebase keeps having to un-ship.
    const page = readAdmin();
    expect(page).toMatch(/providerFailureCopy\(kind!, t\.name\)/);
    expect(page).toMatch(/\{t\.detail \?\? "failed"\}/);
  });
});

function readAdmin(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { readFileSync } = require("fs") as typeof import("fs");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { join } = require("path") as typeof import("path");
  return readFileSync(join(process.cwd(), "src/app/admin/page.tsx"), "utf8");
}
