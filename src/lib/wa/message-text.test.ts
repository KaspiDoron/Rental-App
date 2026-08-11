import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { waMessageText, waUnwrap, waMediaKind } from "./message-text";

// A MESSAGE THAT ARRIVED IS NEVER NOTHING.
//
// There were two extractors in this repo and the LIVE webhook used the weaker
// one. The complete reader was private to evolution.ts and wired only to the
// wa-sync RECOVERY sweep - so the sweep could read a message the live path had
// already thrown away.
//
// The owner hit this for real: a shop sent an "I'M SORRY" sticker alongside
// "sorry tomorrow we closed and open again on 20th". The text arrived; the
// sticker became nothing.

describe("every frame WhatsApp can send reaches the agent as something", () => {
  const wrap = (message: Record<string, unknown>) => ({ message });

  it("REPRODUCTION: a sticker is a real turn, not silence", () => {
    expect(waMessageText(wrap({ stickerMessage: { url: "x" } }))).toBe("[sticker]");
    expect(waMediaKind(wrap({ stickerMessage: { url: "x" } }))).toBe("sticker");
  });

  it("interactive replies are answers - a tapped button is not silence", () => {
    // A shop tapping a button IS answering us. Reading that as nothing is how a
    // live thread looked abandoned.
    expect(
      waMessageText(wrap({ buttonsResponseMessage: { selectedDisplayText: "Yes, available" } }))
    ).toBe("Yes, available");
    expect(
      waMessageText(wrap({ templateButtonReplyMessage: { selectedDisplayText: "200 baht" } }))
    ).toBe("200 baht");
    expect(waMessageText(wrap({ listResponseMessage: { title: "Click 125" } }))).toBe("Click 125");
    expect(waMessageText(wrap({ reactionMessage: { text: "👍" } }))).toBe("👍");
  });

  it("every envelope is peeled, not just ephemeralMessage", () => {
    // The live path's `unwrap` knew ONE wrapper. A view-once photo or an edited
    // message was therefore not merely unreadable - it was UNDETECTABLE:
    // hasImageMessage said false and the vision job never ran.
    const inner = { conversation: "200 per day" };
    expect(waMessageText(wrap({ ephemeralMessage: { message: inner } }))).toBe("200 per day");
    expect(waMessageText(wrap({ viewOnceMessage: { message: inner } }))).toBe("200 per day");
    expect(waMessageText(wrap({ viewOnceMessageV2: { message: inner } }))).toBe("200 per day");
    expect(waMessageText(wrap({ documentWithCaptionMessage: { message: inner } }))).toBe("200 per day");
    expect(
      waMessageText(wrap({ editedMessage: { message: { protocolMessage: { editedMessage: inner } } } }))
    ).toBe("200 per day");
  });

  it("a view-once PHOTO is still detectable as an image", () => {
    // This is the half that matters beyond text: the detectors read waUnwrap,
    // so peeling the envelope is what makes the vision job fire at all.
    const m = waUnwrap(wrap({ viewOnceMessageV2: { message: { imageMessage: { url: "x" } } } }));
    expect(Boolean(m.imageMessage)).toBe(true);
    expect(waMediaKind(wrap({ viewOnceMessageV2: { message: { imageMessage: {} } } }))).toBe("image");
  });

  it("a caption still wins over the placeholder", () => {
    expect(waMessageText(wrap({ imageMessage: { caption: "our rates" } }))).toBe("our rates");
    expect(waMessageText(wrap({ imageMessage: {} }))).toBe("[photo]");
  });

  it("nested envelopes terminate rather than looping", () => {
    // Bounded on purpose: an unbounded peel on attacker-shaped input is not a
    // risk worth taking for a webhook that accepts arbitrary JSON.
    let deep: Record<string, unknown> = { conversation: "hi" };
    for (let i = 0; i < 20; i += 1) deep = { ephemeralMessage: { message: deep } };
    expect(() => waMessageText(wrap(deep))).not.toThrow();
  });

  it("junk in, empty string out - never a throw", () => {
    for (const junk of [null, undefined, 0, "", [], { message: null }]) {
      expect(waMessageText(junk)).toBe("");
    }
  });
});

describe("the live path and the recovery sweep now share one reader", () => {
  const ingest = readFileSync(join(process.cwd(), "src/lib/wa/ingest.ts"), "utf8");
  const evolution = readFileSync(join(process.cwd(), "src/lib/evolution.ts"), "utf8");

  it("ingest no longer carries its own extractor", () => {
    expect(ingest).toMatch(/from "@\/lib\/wa\/message-text"/);
    // The private copies are gone - these are the shapes that dropped frames.
    expect(ingest).not.toMatch(/function extractText\(/);
    expect(ingest).not.toMatch(/data\?\.message\?\.ephemeralMessage\?\.message \?\? data\?\.message/);
  });

  it("evolution imports it rather than defining it", () => {
    expect(evolution).toMatch(/import \{ waMessageText \} from "\.\/wa\/message-text"/);
    expect(evolution).not.toMatch(/function waMessageText\(/);
  });

  it("an unreadable frame becomes an honest placeholder instead of a drop", () => {
    // The drop was `empty-media`: no text, no image, no audio, no doc -> continue.
    // A sticker/reaction/poll hit that branch and vanished.
    expect(ingest).toMatch(/const kind = waMediaKind\(data\);/);
    expect(ingest).toMatch(/syntheticText = `\[\$\{kind\}\]`/);
  });
});
