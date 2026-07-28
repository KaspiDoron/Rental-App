import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  RETRYABLE_VISION,
  summariseVisionFailure,
  visionFailureDetail,
  visionFailureFromStatus,
  visionFailureFromThrown,
  type VisionAttempt,
} from "./vision-read";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// AN OUTAGE WAS LAUNDERED INTO A CONFIDENT NEGATIVE.
//
// `chatVision` had exactly one failure exit - `return null` - and reached it
// from every possible cause: no API key, a rejected key, a 429, a decommissioned
// model id, an aborted call, a safety block. Its only consumer turned that null
// into `{ found: false, matchesSpec: true, confidence: "low", clarifyMessage }`,
// byte-identical to what a SUCCESSFUL read of a genuinely blank photo produces.
//
// So a provider outage reached the traveller as "Nothing readable in this one"
// printed under a price board they could read perfectly well, and reached the
// shop as a request to type out something they had already sent.

describe("a failure is classified, never collapsed", () => {
  it("HTTP statuses map to the thing an operator can act on", () => {
    expect(visionFailureFromStatus(401)).toBe("auth");
    expect(visionFailureFromStatus(403)).toBe("auth");
    expect(visionFailureFromStatus(429)).toBe("rate-limit");
    expect(visionFailureFromStatus(404)).toBe("bad-model");
    expect(visionFailureFromStatus(400)).toBe("bad-model");
    expect(visionFailureFromStatus(500)).toBe("upstream");
    expect(visionFailureFromStatus(503)).toBe("upstream");
  });

  it("our own aborted budget is a timeout, not a network fault", () => {
    // AbortController's message is the ONLY signal that the call was killed by
    // us; read as "network error" it would look like the provider was down.
    expect(visionFailureFromThrown(new Error("The operation was aborted."))).toBe("timeout");
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(visionFailureFromThrown(abort)).toBe("timeout");
    expect(visionFailureFromThrown(new Error("timed out"))).toBe("timeout");
    expect(visionFailureFromThrown(new Error("fetch failed"))).toBe("network");
    expect(visionFailureFromThrown("ECONNRESET")).toBe("network");
  });

  it("only transient failures are retryable", () => {
    // The retry policy IS this set. A rejected key or a safety block cannot
    // succeed on a second attempt, and retrying it only burns the turn's budget
    // while a shop waits for a reply.
    expect(RETRYABLE_VISION.has("rate-limit")).toBe(true);
    expect(RETRYABLE_VISION.has("timeout")).toBe(true);
    expect(RETRYABLE_VISION.has("network")).toBe(true);
    expect(RETRYABLE_VISION.has("upstream")).toBe(true);
    expect(RETRYABLE_VISION.has("auth")).toBe(false);
    expect(RETRYABLE_VISION.has("blocked")).toBe(false);
    expect(RETRYABLE_VISION.has("bad-model")).toBe(false);
    expect(RETRYABLE_VISION.has("unconfigured")).toBe(false);
  });
});

describe("a ladder of attempts summarises to the most actionable cause", () => {
  const a = (failure: VisionAttempt["failure"], error = "x"): VisionAttempt => ({
    provider: "gemini",
    model: "m",
    ok: false,
    failure,
    error,
  });

  it("a rejected key outranks the model drift it also caused", () => {
    expect(summariseVisionFailure([a("bad-model"), a("auth"), a("upstream")])).toBe("auth");
  });

  it("quota outranks a timeout", () => {
    expect(summariseVisionFailure([a("timeout"), a("rate-limit")])).toBe("rate-limit");
  });

  it("nothing configured is the honest answer when nothing was tried", () => {
    expect(summariseVisionFailure([a("unconfigured"), a("unconfigured")])).toBe("unconfigured");
    expect(summariseVisionFailure([])).toBe("unconfigured");
  });

  it("successful attempts never contribute a failure", () => {
    expect(
      summariseVisionFailure([a("rate-limit"), { provider: "groq", model: "m", ok: true }])
    ).toBe("rate-limit");
  });

  it("the detail carries the verbatim upstream errors, newest last", () => {
    const d = visionFailureDetail([a("auth", "gemini 401 - bad key"), a("rate-limit", "groq 429")]);
    expect(d).toBe("gemini 401 - bad key | groq 429");
    expect(visionFailureDetail([])).toMatch(/no vision provider/i);
  });
});

describe("the caller can tell an outage from a blank photo", () => {
  it("readImages returns a discriminated result, not a nullable string", () => {
    const ai = readCode("src/lib/ai.ts");
    expect(ai).toMatch(/export async function readImages\([\s\S]{0,200}Promise<VisionRead>/);
    // The ok:false branch carries WHY and WHETHER IT CAN BE RETRIED.
    expect(ai).toMatch(/retryable: RETRYABLE_VISION\.has\(failure\)/);
    expect(ai).toMatch(/detail: visionFailureDetail\(attempts\)/);
  });

  it("chatVision survives only as a declared-lossy wrapper", () => {
    // Transcription and the admin bench genuinely only want text; they keep
    // working. Nothing that REPORTS to a traveller may use it.
    const ai = readCode("src/lib/ai.ts");
    expect(ai).toMatch(/export async function chatVision\([\s\S]{0,300}readImages\(/);
    expect(ai).toMatch(/return read\.ok \? read\.text : null;/);
  });

  it("a 200 with no content is a refusal, not a reading", () => {
    const ai = readCode("src/lib/ai.ts");
    // Both providers classify their empty-body case as `blocked` - the safety
    // filter case that used to be indistinguishable from an unreadable board.
    expect(ai.match(/failure: "blocked"/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("vision has its own time budget, not the text-completion one", () => {
    // 14s is a text budget. A vision call ships megabytes of base64 and was
    // being aborted mid-read, then reported as an unreadable image.
    const ai = readCode("src/lib/ai.ts");
    expect(ai).toMatch(/VISION_CALL_TIMEOUT_MS = 22_000/);
    expect(ai).toMatch(/VISION_TOTAL_BUDGET_MS = 45_000/);
    // ...and the whole ladder stops before it can blow the route's 60s.
    expect(ai).toMatch(/Date\.now\(\) > deadline/);
  });

  it("one bounded retry, gated on the retryable set", () => {
    const ai = readCode("src/lib/ai.ts");
    expect(ai).toMatch(/RETRYABLE_VISION\.has\(firstFailure\)/);
    expect(ai).toMatch(/\(retry\)/);
  });
});

describe("the provenance reaches the extraction", () => {
  it("every image exit stamps imageRead", () => {
    const agents = readCode("src/lib/agents.ts");
    expect(agents).toMatch(/imageRead\?: \{/);
    expect(agents).toMatch(/const imageRead: ExtractedOffer\["imageRead"\] = read\.ok/);
    // The three ways out of the image branch: parsed model output, the caption
    // fallback, and the give-up. All three must carry it, because the give-up is
    // the one that used to be indistinguishable from a real negative read.
    expect(agents).toMatch(/normalizeExtraction\(parsed, spec\), imageRead/);
    expect(agents).toMatch(/\.\.\.capHit, imageRead/);
    expect(agents).toMatch(/clarifyMessage: `Thanks for the photo![\s\S]{0,200}imageRead,/);
  });

  it("the extractor reads images through readImages, not the lossy wrapper", () => {
    const agents = readCode("src/lib/agents.ts");
    expect(agents).toMatch(/const \{ readImages \} = await import\("\.\/ai"\)/);
    expect(agents).not.toMatch(/const \{ chatVision \} = await import\("\.\/ai"\)/);
  });

  it("an outage is reported to Ops by name", () => {
    const loop = readCode("src/lib/agent-loop.ts");
    expect(loop).toMatch(/kind: "vision-unavailable"/);
    expect(loop).toMatch(/extraction\.imageRead\?\.seen === false/);
  });
});

describe("the engine never claims to have read a photo it did not open", () => {
  it("the unread flag reaches the turn context", () => {
    const types = readCode("src/lib/spte/types.ts");
    expect(types).toMatch(/imageUnread\?: boolean;/);
    const live = readCode("src/lib/spte/live.ts");
    expect(live).toMatch(/imageUnread:[\s\S]{0,160}imageRead\?\.seen === false/);
  });

  it("the prompt tells the model plainly that we have not seen it", () => {
    const p = readCode("src/lib/spte/pass.ts");
    expect(p).toMatch(/verified\.imageUnread/);
    expect(p).toMatch(/we have NOT seen it/);
    expect(p).toMatch(/never ask which line is yours/i);
  });

  it("the deterministic clarify asks for text ONLY when the read failed", () => {
    const p = readCode("src/lib/spte/pass.ts");
    // Order matters: the unread branch must come FIRST, or the "which line is
    // the one for me?" template - which asserts a read - wins.
    const clarify = p.slice(p.indexOf('case "clarify":'));
    const unread = clarify.indexOf("v.imageUnread");
    const whichLine = clarify.indexOf("Which line is the one for me");
    expect(unread).toBeGreaterThan(-1);
    expect(whichLine).toBeGreaterThan(-1);
    expect(unread).toBeLessThan(whichLine);
    expect(clarify).toMatch(/didn't open properly/);
  });
});
