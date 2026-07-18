import { describe, it, expect } from "vitest";
import { isRecipientSendFailure, isTransientSendFailure } from "./send-classify";

describe("send failure classification (batch-stall fix)", () => {
  it("treats host/infra errors as TRANSIENT (fast retry, no attempt burn)", () => {
    for (const e of [
      "reconnecting",
      "not-connected",
      "Evolution API 502",
      "Evolution API 503",
      "request timed out",
      "ECONNRESET",
      "EAI_AGAIN",
      "",
      undefined,
      null,
    ]) {
      expect(isTransientSendFailure(e)).toBe(true);
      expect(isRecipientSendFailure(e)).toBe(false);
    }
  });

  it("treats recipient errors as terminal (counts toward the give-up cap)", () => {
    for (const e of [
      "number is not on WhatsApp",
      "invalid number",
      "recipient blocked us",
      "forbidden",
      "no-phone",
    ]) {
      expect(isRecipientSendFailure(e)).toBe(true);
      expect(isTransientSendFailure(e)).toBe(false);
    }
  });
});
