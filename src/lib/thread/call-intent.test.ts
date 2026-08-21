import { describe, it, expect, vi, beforeEach } from "vitest";
import { mergeShopTone } from "../agents";
import { callIntentHint } from "../semantic/classifiers";

// OWNER REPORT 6 K6/K7 - the last two "meaning" seams of the doctrine wave.
//
// K6: the tone merge was a one-way ratchet - ANNOYED_RX could force "annoyed"
// over a model that read the whole glossed message as warm, and nothing could
// ever force "warm". K7: readCallIntent was exported, zod-validated, and had
// ZERO callers - "can you call me?" scrolled past every surface.

describe("K6: the model's tone verdict wins BOTH ways", () => {
  it("model 'warm' beats a regex 'annoyed' (the ratchet is dead)", () => {
    // "no more than 300 and it's yours" trips ANNOYED_RX ("no more") in a
    // perfectly friendly sentence. The model read the whole message.
    expect(mergeShopTone("warm", "annoyed")).toBe("warm");
  });
  it("model 'neutral' also beats the regex", () => {
    expect(mergeShopTone("neutral", "annoyed")).toBe("neutral");
  });
  it("the regex still answers when the model was silent", () => {
    expect(mergeShopTone(null, "annoyed")).toBe("annoyed");
    expect(mergeShopTone(undefined, "annoyed")).toBe("annoyed");
  });
  it("an off-vocabulary model value never leaks through", () => {
    expect(mergeShopTone("furious", null)).toBeNull();
    expect(mergeShopTone("furious", "annoyed")).toBe("annoyed");
  });
  it("nothing said, nothing decided", () => {
    expect(mergeShopTone(null, null)).toBeNull();
  });
});

describe("K7: the call-intent hint is a SKIP-ONLY gate", () => {
  it("passes the asks a shop actually sends", () => {
    expect(callIntentHint("Can you call me?")).toBe(true);
    expect(callIntentHint("please ring us when you arrive")).toBe(true);
    expect(callIntentHint("โทรหาผมได้ไหม")).toBe(true); // Thai: "can you call me?"
  });
  it("skips a turn with nothing phone-shaped (saving the model call)", () => {
    expect(callIntentHint("Special price 900 baht for 4 days")).toBe(false);
    expect(callIntentHint("we have Fazzio 125cc available")).toBe(false);
  });
});

describe("K7: persistCallIntent stores the model's verdict on the thread", () => {
  beforeEach(() => vi.resetModules());

  it("merges wantsCall into fields, newest reading winning", async () => {
    const updates: Array<{ filter: string; patch: Record<string, unknown> }> = [];
    vi.doMock("../runtime-config", () => ({
      sbSelectStrict: vi.fn(async () => ({
        rows: [
          {
            thread_key: "t-1",
            fields: {
              round: 2,
              wantsCall: { quote: "old", urgency: "whenever", at: "2026-08-01T00:00:00Z" },
            },
          },
        ],
      })),
      sbUpdate: vi.fn(async (_t: string, filter: string, patch: Record<string, unknown>) => {
        updates.push({ filter, patch });
      }),
    }));
    const { persistCallIntent } = await import("./call-intent");
    const ok = await persistCallIntent({
      email: "u@x.com",
      vendorId: "v1",
      intent: { quote: "call me now please", urgency: "now", at: "2026-08-21T10:00:00Z" },
    });
    expect(ok).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0].filter).toContain("thread_key=eq.t-1");
    const fields = updates[0].patch.fields as Record<string, unknown>;
    // A call ask is a STATE: the newest reading overwrites (unlike the
    // ask-once substitution choice), and every sibling field survives.
    expect(fields.round).toBe(2);
    expect(fields.wantsCall).toEqual({
      quote: "call me now please",
      urgency: "now",
      at: "2026-08-21T10:00:00Z",
    });
  });

  it("an unreadable schema is 'unavailable', never 'no such thread'", async () => {
    const sbUpdate = vi.fn();
    vi.doMock("../runtime-config", () => ({
      sbSelectStrict: vi.fn(async () => ({ error: "unavailable" as const })),
      sbUpdate,
    }));
    const { persistCallIntent } = await import("./call-intent");
    const ok = await persistCallIntent({
      email: "u@x.com",
      vendorId: "v1",
      intent: { quote: null, urgency: "soon", at: "2026-08-21T10:00:00Z" },
    });
    expect(ok).toBe(false);
    expect(sbUpdate).not.toHaveBeenCalled();
  });
});
