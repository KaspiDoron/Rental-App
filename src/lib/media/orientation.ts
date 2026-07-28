// WHICH WAY IS UP - the one place that looks at an image's actual bytes.
//
// A traveller photographs a shop's price board with a phone held upright. The
// phone's sensor is mounted sideways, so the JPEG it writes is a LANDSCAPE
// image plus an EXIF tag that says "turn me 90 degrees". Every consumer is then
// on its own: a browser applies the tag, a vision model may or may not, and a
// canvas re-encode silently throws it away. The same board is therefore read
// three different ways by three different consumers, and nobody can tell which
// one is wrong.
//
// This module is the missing declaration layer. It measures the tag ONCE at
// ingest and hands every consumer the same small, honest answer. It deliberately
// does NOT rotate pixels: rotating a JPEG needs a codec (sharp / libvips), which
// is ~40MB of native binary traced into three runtimes, on a 1GB VM whose vision
// worker already pins concurrency at 2 because media buffers are the RAM spike.
// The payoff would be rotating bytes the browser already rotates correctly. So
// the rule here is DETECT AND DECLARE:
//   - the browser gets `image-orientation: from-image` plus a data-attribute
//     fallback (see globals.css),
//   - the vision model gets a sentence in its prompt (`orientationNote`),
//   - the client gets to normalize pixels for free before upload
//     (see lib/client/normalize-image.ts),
//   - and the STORED BYTES ARE NEVER TOUCHED, so no correction is ever lost.
//
// Patching the EXIF tag to 1 in place would be a tempting two-byte write and is
// exactly wrong: it stops EXIF-honouring consumers correcting an image whose
// pixels are still sideways, i.e. it breaks the one consumer that works today.
//
// HOSTILE INPUT. These bytes arrive from a stranger's WhatsApp. Every parse here
// is bounded (segment counts, IFD entry counts, forward-progress checks) and the
// whole surface is wrapped so that NOTHING in this file can throw or loop. A
// throw here would abort processVendorReply before the reply is stored - the
// "one bad photo eats the conversation" failure class this codebase already
// documents elsewhere.
//
// Pure and dependency-free on purpose: no `server-only`, no Buffer requirement,
// no fetch, no pixel decode. It runs identically in a Next route, in the vision
// worker, and in the browser bundle.

/** The eight values EXIF tag 0x0112 is allowed to take. */
export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface OrientationInfo {
  /** The raw EXIF value. 1 whenever the tag is absent, unreadable or nonsense. */
  orientation: ExifOrientation;
  /** Clockwise degrees to apply to the stored pixels to see them upright. */
  rotateDeg: 0 | 90 | 180 | 270;
  /** True for 2, 4, 5, 7 - the image is also flipped horizontally. */
  mirrored: boolean;
  /** True for 5, 6, 7, 8 - upright width/height are the stored ones transposed. */
  swapsAxes: boolean;
  /**
   * Where the answer came from. "none" means NO orientation tag was found, which
   * is materially different from "a tag was found and it said upright": the
   * client normalizer uses that distinction to decide whether a re-encode could
   * possibly double-apply a correction.
   */
  source: "exif-jpeg" | "exif-webp" | "none";
}

/**
 * The image tuple that travels from ingest to the vision providers. `orientation`
 * is OPTIONAL so that every existing `{ mime, base64 }` call site keeps compiling
 * while the field is threaded through; treat a missing value as "not measured",
 * not as "upright".
 */
export interface InboundImage {
  mime: string;
  base64: string;
  orientation?: OrientationInfo;
}

/** The answer for "nothing said otherwise". Frozen: it is handed out by reference. */
export const UPRIGHT: OrientationInfo = Object.freeze({
  orientation: 1,
  rotateDeg: 0,
  mirrored: false,
  swapsAxes: false,
  source: "none",
});

// The EXIF table, written out rather than computed, because every arithmetic
// shortcut anyone reaches for here (deg = (value >> 1) * 90 and friends) gets
// the mirrored pairs wrong in a way that only shows up on a real phone.
const TABLE: Record<ExifOrientation, { rotateDeg: 0 | 90 | 180 | 270; mirrored: boolean }> = {
  1: { rotateDeg: 0, mirrored: false },
  2: { rotateDeg: 0, mirrored: true },
  3: { rotateDeg: 180, mirrored: false },
  4: { rotateDeg: 180, mirrored: true },
  5: { rotateDeg: 90, mirrored: true },
  6: { rotateDeg: 90, mirrored: false },
  7: { rotateDeg: 270, mirrored: true },
  8: { rotateDeg: 270, mirrored: false },
};

/**
 * Build the descriptor for a raw tag value. Exported because the worker and the
 * admin surfaces persist the bare number and need to re-hydrate it later without
 * keeping the bytes around.
 */
export function orientationInfo(
  value: number,
  source: OrientationInfo["source"] = "none"
): OrientationInfo {
  if (!Number.isInteger(value) || value < 1 || value > 8) return UPRIGHT;
  const v = value as ExifOrientation;
  const row = TABLE[v];
  return {
    orientation: v,
    rotateDeg: row.rotateDeg,
    mirrored: row.mirrored,
    swapsAxes: v >= 5,
    source,
  };
}

/** True when the descriptor says the stored pixels can be shown as they are. */
export function isUpright(info: OrientationInfo | null | undefined): boolean {
  return !info || (info.rotateDeg === 0 && !info.mirrored);
}

// ---------------------------------------------------------------------------
// Byte parsing
// ---------------------------------------------------------------------------

// Bounds. A conformant JPEG has a handful of segments before SOS and an IFD0
// with a few dozen entries; a hostile one can claim 65535 of either. These caps
// are far above anything real and far below anything that costs us a request.
const MAX_SEGMENTS = 512;
const MAX_IFD_ENTRIES = 512;

const TAG_ORIENTATION = 0x0112;

/** "Exif\0\0" - the APP1 discriminator that separates EXIF from XMP. */
function isExifHeader(b: Uint8Array, o: number): boolean {
  return (
    o + 6 <= b.length &&
    b[o] === 0x45 &&
    b[o + 1] === 0x78 &&
    b[o + 2] === 0x69 &&
    b[o + 3] === 0x66 &&
    b[o + 4] === 0x00 &&
    b[o + 5] === 0x00
  );
}

function fourcc(b: Uint8Array, o: number, a: number, c: number, d: number, e: number): boolean {
  return o + 4 <= b.length && b[o] === a && b[o + 1] === c && b[o + 2] === d && b[o + 3] === e;
}

function u32le(b: Uint8Array, o: number): number {
  if (o + 4 > b.length) return -1;
  // Multiply rather than shift: `b[o+3] << 24` goes negative for sizes over 2GB
  // and a negative chunk size is how you walk a RIFF parser backwards forever.
  return b[o] + b[o + 1] * 0x100 + b[o + 2] * 0x10000 + b[o + 3] * 0x1000000;
}

/**
 * Read tag 0x0112 out of a TIFF header living in `b[start..end)`.
 *
 * Both byte orders are handled explicitly. Getting this wrong is not a crash,
 * it is a SILENT wrong answer - a big-endian 6 read little-endian is 1536, which
 * fails the 1..8 range check and looks exactly like "no tag", so a whole camera
 * vendor's photos would quietly stay sideways with no error anywhere.
 */
function tiffOrientation(b: Uint8Array, start: number, end: number): number | null {
  const stop = Math.min(end, b.length);
  if (start < 0 || start + 8 > stop) return null;

  const le = b[start] === 0x49 && b[start + 1] === 0x49; // "II"
  const be = b[start] === 0x4d && b[start + 1] === 0x4d; // "MM"
  if (!le && !be) return null;

  const u16 = (o: number): number =>
    o < 0 || o + 2 > stop ? -1 : le ? b[o] + b[o + 1] * 0x100 : b[o] * 0x100 + b[o + 1];
  const u32 = (o: number): number => {
    if (o < 0 || o + 4 > stop) return -1;
    return le
      ? b[o] + b[o + 1] * 0x100 + b[o + 2] * 0x10000 + b[o + 3] * 0x1000000
      : b[o] * 0x1000000 + b[o + 1] * 0x10000 + b[o + 2] * 0x100 + b[o + 3];
  };

  if (u16(start + 2) !== 42) return null; // TIFF magic
  const ifdOffset = u32(start + 4);
  // Offsets are relative to the TIFF header start and can point anywhere in a
  // crafted file; clamp to this segment rather than trusting them.
  if (ifdOffset < 8 || ifdOffset > stop - start) return null;

  const dir = start + ifdOffset;
  if (dir + 2 > stop) return null;
  const declared = u16(dir);
  if (declared < 1) return null;
  // A truncated APP1 (the classic result of a chat client re-cutting a file)
  // claims more entries than it carries. Read the ones that actually fit.
  const fits = Math.floor((stop - dir - 2) / 12);
  const count = Math.min(declared, MAX_IFD_ENTRIES, Math.max(0, fits));

  for (let e = 0; e < count; e++) {
    const p = dir + 2 + e * 12;
    if (u16(p) !== TAG_ORIENTATION) continue;
    const type = u16(p + 2);
    if (u32(p + 4) !== 1) return null; // orientation is a single value by spec
    // A SHORT occupies the FIRST two bytes of the 4-byte value field in BOTH
    // byte orders - reading it as a 4-byte LONG is the other classic silent bug.
    const value = type === 3 ? u16(p + 8) : type === 4 ? u32(p + 8) : -1;
    return value >= 1 && value <= 8 ? value : null;
  }
  return null;
}

/** Walk JPEG marker segments to the Exif APP1. EXIF always precedes the scan. */
function jpegOrientation(b: Uint8Array): number | null {
  let i = 2; // past SOI
  for (let seg = 0; seg < MAX_SEGMENTS; seg++) {
    // 0xFF fill bytes are legal padding before a marker.
    while (i + 1 < b.length && b[i] === 0xff && b[i + 1] === 0xff) i++;
    if (i + 3 >= b.length || b[i] !== 0xff) return null;

    const marker = b[i + 1];
    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    // SOS starts entropy-coded data and EOI ends the file: no metadata beyond.
    if (marker === 0xda || marker === 0xd9) return null;

    const len = b[i + 2] * 0x100 + b[i + 3];
    if (len < 2) return null; // malformed; a zero length would not advance `i`
    const body = i + 4;
    const segEnd = Math.min(b.length, i + 2 + len);

    if (marker === 0xe1 && isExifHeader(b, body)) {
      const v = tiffOrientation(b, body + 6, segEnd);
      if (v) return v;
    }
    i += 2 + len;
  }
  return null;
}

function isRiffWebp(b: Uint8Array): boolean {
  // "RIFF" .... "WEBP"
  return fourcc(b, 0, 0x52, 0x49, 0x46, 0x46) && fourcc(b, 8, 0x57, 0x45, 0x42, 0x50);
}

/** Walk RIFF chunks to the "EXIF" chunk, then reuse the TIFF reader. */
function webpOrientation(b: Uint8Array): number | null {
  const declared = u32le(b, 4);
  const end = declared > 0 ? Math.min(b.length, 8 + declared) : b.length;
  let p = 12; // past "RIFF" + size + "WEBP"
  for (let n = 0; n < MAX_SEGMENTS && p + 8 <= end; n++) {
    const size = u32le(b, p + 4);
    if (size < 0) return null;
    const dataStart = p + 8;
    const dataEnd = Math.min(end, dataStart + size);
    if (fourcc(b, p, 0x45, 0x58, 0x49, 0x46)) {
      // Some encoders write the bare TIFF block, others prefix the JPEG-style
      // "Exif\0\0". Accept both rather than guessing by encoder.
      const t = isExifHeader(b, dataStart) ? dataStart + 6 : dataStart;
      const v = tiffOrientation(b, t, dataEnd);
      if (v) return v;
    }
    // RIFF chunks are padded to an even length. `next > p` always holds because
    // size is non-negative, which is what makes this loop provably finite.
    const next = dataStart + size + (size % 2);
    if (next <= p) return null;
    p = next;
  }
  return null;
}

/**
 * The whole capability, in one call. NEVER throws, for any input, ever - an
 * empty buffer, a PNG, a truncated JPEG, a text file or a deliberately hostile
 * one all answer UPRIGHT.
 */
export function readOrientation(bytes: Uint8Array | null | undefined): OrientationInfo {
  if (!bytes || bytes.length < 12) return UPRIGHT;
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      const v = jpegOrientation(bytes);
      return v ? orientationInfo(v, "exif-jpeg") : UPRIGHT;
    }
    if (isRiffWebp(bytes)) {
      const v = webpOrientation(bytes);
      return v ? orientationInfo(v, "exif-webp") : UPRIGHT;
    }
  } catch {
    // Defence in depth. Nothing above should be able to throw, and if a future
    // edit makes it able to, a sideways photo must still not lose a reply.
  }
  return UPRIGHT;
}

/**
 * How much base64 we bother decoding. EXIF lives in the FIRST APP1 segment, so
 * it is always within the first few KB; decoding a 4MB base64 payload into a
 * second full buffer just to read two bytes is precisely the RAM spike the
 * vision worker's concurrency cap exists to protect. ~176k chars is ~132KB of
 * bytes - three orders of magnitude of headroom over any real APP1.
 */
export const BASE64_PREFIX_CHARS = 176_000;

/**
 * The bounded, decodable head of a base64 payload: data-URL prefix stripped,
 * non-alphabet characters dropped, and cut to a whole 4-character group so the
 * decoder never sees a partial one. Exported so the bound itself is testable.
 */
export function base64Prefix(b64: string | null | undefined): string {
  if (typeof b64 !== "string" || !b64) return "";
  const body = b64.replace(/^data:[^,]*,/, "");
  const head = body.length > BASE64_PREFIX_CHARS ? body.slice(0, BASE64_PREFIX_CHARS) : body;
  const clean = head.replace(/[^A-Za-z0-9+/]/g, "");
  return clean.slice(0, clean.length - (clean.length % 4));
}

function decodeBase64(b64: string): Uint8Array | null {
  if (!b64) return null;
  try {
    const g = globalThis as unknown as {
      Buffer?: { from(input: string, enc: string): Uint8Array };
      atob?: (s: string) => string;
    };
    if (g.Buffer) return new Uint8Array(g.Buffer.from(b64, "base64"));
    if (g.atob) {
      const bin = g.atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
  } catch {
    /* an undecodable payload is simply not an image we can measure */
  }
  return null;
}

/** `readOrientation` for the base64 form ingest actually holds. Never throws. */
export function readOrientationFromBase64(b64: string | null | undefined): OrientationInfo {
  const bytes = decodeBase64(base64Prefix(b64));
  return readOrientation(bytes);
}

// ---------------------------------------------------------------------------
// Declaring the answer
// ---------------------------------------------------------------------------

/**
 * PROMPT SURFACE. This sentence goes into the vision model's user text, so its
 * wording is behaviour: a silent drift here changes what the model reads off a
 * price board with no other signal anywhere. It is pinned by test on purpose.
 *
 * Returns "" for an upright (or unmeasured) image so callers can join freely
 * without producing an empty line.
 *
 * @param index 1-based image number, when several images are sent in one turn.
 */
export function orientationNote(
  info: OrientationInfo | null | undefined,
  index?: number
): string {
  if (!info || isUpright(info)) return "";
  const subject =
    typeof index === "number" && Number.isFinite(index) ? `Image ${Math.trunc(index)}` : "The image";
  const rotated = info.rotateDeg !== 0;
  const how = rotated && info.mirrored ? "mirrored and rotated" : rotated ? "rotated" : "mirrored";
  // Stated in the order the correction is applied - rotate, then flip - so the
  // instruction is unambiguous for the mirrored diagonal cases (5 and 7).
  const fix =
    rotated && info.mirrored
      ? `rotate it ${info.rotateDeg} degrees clockwise, then flip it horizontally`
      : rotated
        ? `rotate it ${info.rotateDeg} degrees clockwise`
        : "flip it horizontally";
  return `${subject} is stored ${how}: ${fix} to view it upright. Read all text in that upright frame.`;
}

/**
 * The note block for a whole turn's worth of images, ready to prepend to the
 * vision user text. Returns "" when every image is upright, so the prompt is
 * byte-identical to today's for the common case.
 */
export function orientationNotes(
  images: readonly { orientation?: OrientationInfo | null }[] | null | undefined
): string {
  if (!images || images.length === 0) return "";
  const lines: string[] = [];
  for (let i = 0; i < images.length; i++) {
    const line = orientationNote(images[i]?.orientation, i + 1);
    if (line) lines.push(line);
  }
  return lines.join("\n");
}

/**
 * RENDER SURFACE. The value for `data-exif-orientation`, which is the single
 * CSS hook every image surface uses (see globals.css). Undefined for an upright
 * or unmeasured image so the attribute is simply absent and the DOM stays clean.
 *
 * The paired CSS is gated behind `@supports not (image-orientation: from-image)`
 * - on every engine that honours the property natively the correction is already
 * done and a transform on top would rotate the board TWICE.
 */
export function orientationAttrValue(
  info: OrientationInfo | null | undefined
): string | undefined {
  return !info || isUpright(info) ? undefined : String(info.orientation);
}
