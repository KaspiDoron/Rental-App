// WHATSAPP TEXT IS FORMATTED TEXT.
//
// Shops write price lists the way WhatsApp renders them - `*Motorbikes:*` bold,
// `_note_` italic, `~old price~` struck through. WhatsApp shows those as
// styling; the app was printing the delimiters, so a real transcript came out
// as "*Motorbikes:* 🛵 **PROMO PRICES* Honda Click 125cc - 250 Baht ...",
// which reads like a bug in the shop's message rather than a gap in our render.
// The app already STRIPS this markup on the way OUT (our own sends never carry
// stray asterisks); it simply had no reader for the way in.
//
// The grammar lives here, pure and React-free, so the same parse backs the
// chat bubbles, the one-line previews, and anything that needs plain text.
// Deliberately a closed grammar rather than a markdown library: WhatsApp's set
// is four delimiters, it is not markdown, and running arbitrary markdown over
// text a stranger sent us is a way to render things we never intended.

export type WaStyle = "bold" | "italic" | "strike" | "code";

export type WaToken =
  | { kind: "text"; text: string }
  | { kind: "styled"; style: WaStyle; children: WaToken[] };

const DELIMS: Array<{ char: string; style: WaStyle }> = [
  { char: "*", style: "bold" },
  { char: "_", style: "italic" },
  { char: "~", style: "strike" },
  { char: "`", style: "code" },
];

const CHARS = DELIMS.map((d) => d.char).join("");
const MAX_DEPTH = 4; // shop text, not a document

/**
 * WhatsApp only treats a delimiter as formatting when it WRAPS something: the
 * opener is followed by a non-space, and the closer is preceded by one. That is
 * what keeps "3 * 4" and a trailing "*" from turning the rest of a price list
 * bold - the failure mode of a naive replace, and the reason "**PROMO PRICES*"
 * must render as "*PROMO PRICES" instead of swallowing the line.
 */
export function tokenizeWa(input: string, depth = 0): WaToken[] {
  const text = String(input ?? "");
  if (depth > MAX_DEPTH) return text ? [{ kind: "text", text }] : [];

  const out: WaToken[] = [];
  let buf = "";
  const flush = () => {
    if (buf) {
      out.push({ kind: "text", text: buf });
      buf = "";
    }
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const delim = CHARS.includes(ch) ? DELIMS.find((d) => d.char === ch) : undefined;
    // An opener needs content immediately after it.
    if (!delim || !text[i + 1] || /\s/.test(text[i + 1])) {
      buf += ch;
      continue;
    }
    // A closer, preceded by a non-space, on the same line.
    let close = -1;
    for (let j = i + 1; j < text.length; j++) {
      if (text[j] === "\n") break;
      if (text[j] === ch && !/\s/.test(text[j - 1])) {
        close = j;
        break;
      }
    }
    if (close === -1) {
      buf += ch;
      continue;
    }
    flush();
    out.push({
      kind: "styled",
      style: delim.style,
      children: tokenizeWa(text.slice(i + 1, close), depth + 1),
    });
    i = close;
  }
  flush();
  return out;
}

/** The same grammar, flattened - for previews, captions and comparisons. */
export function waPlain(input: string): string {
  const walk = (tokens: WaToken[]): string =>
    tokens.map((t) => (t.kind === "text" ? t.text : walk(t.children))).join("");
  return walk(tokenizeWa(input));
}
