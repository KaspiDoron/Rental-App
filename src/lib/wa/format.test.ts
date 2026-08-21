import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { waPlain } from "./format";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const readCode = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

// The live transcript rendered the shop's own price list as:
//   *Motorbikes:* 🛵 **PROMO PRICES* Honda Click 125cc - 250 Baht ...
// WhatsApp shows that as styled text. We were printing the delimiters.
//
// `waPlain` shares the parser with the renderer, so asserting on its output
// asserts the grammar the React version applies.

describe("WhatsApp formatting is read, not printed", () => {
  it("strips the four delimiters WhatsApp actually uses", () => {
    expect(waPlain("*Motorbikes:*")).toBe("Motorbikes:");
    expect(waPlain("_note_")).toBe("note");
    expect(waPlain("~old price~")).toBe("old price");
    expect(waPlain("`code`")).toBe("code");
  });

  it("handles the real price-list line from the incident", () => {
    const line = "*Motorbikes:* 🛵 *PROMO PRICES* Honda Click 125cc - 250 Baht Per 24hr";
    expect(waPlain(line)).toBe("Motorbikes: 🛵 PROMO PRICES Honda Click 125cc - 250 Baht Per 24hr");
  });

  it("a delimiter must WRAP something - arithmetic and stray marks survive", () => {
    // A naive replace turns the rest of a price list bold from one stray "*".
    expect(waPlain("3 * 4 = 12")).toBe("3 * 4 = 12");
    expect(waPlain("price*")).toBe("price*");
    expect(waPlain("* not a list")).toBe("* not a list");
  });

  it("an unclosed delimiter is left exactly as typed", () => {
    expect(waPlain("*unclosed bold")).toBe("*unclosed bold");
  });

  it("formatting does not run across a line break", () => {
    // WhatsApp does not either; letting it would style the whole message from
    // one asterisk on the first line.
    expect(waPlain("*start\nend*")).toBe("*start\nend*");
  });

  it("nests, so bold-inside-italic still reads cleanly", () => {
    expect(waPlain("_hello *there*_")).toBe("hello there");
  });

  it("is not markdown - no links, no HTML, nothing executable", () => {
    const src = readCode("src/lib/wa/format.ts");
    expect(src).not.toMatch(/dangerouslySetInnerHTML/);
    expect(src).not.toMatch(/from "(react-)?markdown/);
  });
});

describe("every surface that shows a shop's words uses it", () => {
  it("chat bubbles render formatted text", () => {
    const b = readCode("src/components/MessageBubble.tsx");
    // displayText = m.text minus the "(quoting: ...)" engine marker - the
    // quote block renders the referent itself (owner report 6 A1).
    expect(b).toMatch(/<WaText text=\{displayText\}/);
    expect(b).toMatch(/<WaText text=\{m\.english\}/);
  });

  it("the card's thread peek does too, and its one-line preview is plain", () => {
    const p = readCode("src/components/ThreadPeek.tsx");
    expect(p).toMatch(/<WaText text=\{msg\.text\}/);
    // The preview is gloss-first since W1.5 (English when a gloss exists, the
    // raw local text otherwise) - either way it goes through waPlain, which is
    // this test's invariant: the collapsed one-liner never shows raw asterisks.
    expect(p).toMatch(/summarize\(waPlain\(preview\)\)/);
    expect(p).toMatch(/\? gloss : msg\.text/);
  });
});
