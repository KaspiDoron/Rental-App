import { describe, it, expect } from "vitest";
import {
  readOrientation,
  readOrientationFromBase64,
  orientationInfo,
  orientationNote,
  orientationNotes,
  orientationAttrValue,
  isUpright,
  base64Prefix,
  BASE64_PREFIX_CHARS,
  UPRIGHT,
  type ExifOrientation,
} from "./orientation";

// ---------------------------------------------------------------------------
// Real byte fixtures. These are built here rather than checked in as blobs so
// that a reader can see EXACTLY which bytes the parser is being held to - the
// endianness, the tag id, the SHORT-in-the-first-two-bytes rule. A fixture you
// cannot read is a test you cannot trust.
// ---------------------------------------------------------------------------

type Endian = "II" | "MM";

/** A TIFF block with a single IFD0 entry: tag 0x0112, type SHORT, count 1. */
function tiffBlock(value: number, endian: Endian, type = 3): Uint8Array {
  const le = endian === "II";
  const b = new Uint8Array(8 + 2 + 12 + 4);
  const put16 = (o: number, v: number) => {
    if (le) {
      b[o] = v & 0xff;
      b[o + 1] = (v >> 8) & 0xff;
    } else {
      b[o] = (v >> 8) & 0xff;
      b[o + 1] = v & 0xff;
    }
  };
  const put32 = (o: number, v: number) => {
    if (le) {
      b[o] = v & 0xff;
      b[o + 1] = (v >>> 8) & 0xff;
      b[o + 2] = (v >>> 16) & 0xff;
      b[o + 3] = (v >>> 24) & 0xff;
    } else {
      b[o] = (v >>> 24) & 0xff;
      b[o + 1] = (v >>> 16) & 0xff;
      b[o + 2] = (v >>> 8) & 0xff;
      b[o + 3] = v & 0xff;
    }
  };
  b[0] = le ? 0x49 : 0x4d;
  b[1] = le ? 0x49 : 0x4d;
  put16(2, 42); // TIFF magic
  put32(4, 8); // IFD0 sits immediately after the header
  put16(8, 1); // one entry
  put16(10, 0x0112); // Orientation
  put16(12, type);
  put32(14, 1); // count
  if (type === 3) {
    // A SHORT lives in the FIRST two bytes of the 4-byte value field, in BOTH
    // byte orders. Reading it as a LONG is the classic silent failure.
    put16(18, value);
  } else {
    put32(18, value);
  }
  put32(22, 0); // next IFD: none
  return b;
}

function concat(...parts: (Uint8Array | number[])[]): Uint8Array {
  const arrays = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)));
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}

const ASCII = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

/** SOI + an APP1 segment carrying `payload` + EOI. */
function jpegWithApp1(payload: Uint8Array): Uint8Array {
  const len = payload.length + 2; // the length field counts itself
  return concat([0xff, 0xd8, 0xff, 0xe1, (len >> 8) & 0xff, len & 0xff], payload, [0xff, 0xd9]);
}

function exifJpeg(value: number, endian: Endian = "II", type = 3): Uint8Array {
  return jpegWithApp1(concat(ASCII("Exif"), [0, 0], tiffBlock(value, endian, type)));
}

/** A JPEG with quantisation-table and frame segments but no APP1 at all. */
function plainJpeg(): Uint8Array {
  return concat(
    [0xff, 0xd8],
    [0xff, 0xdb, 0x00, 0x06, 0x00, 0x11, 0x22, 0x33], // DQT
    [0xff, 0xc0, 0x00, 0x08, 0x08, 0x00, 0x10, 0x00, 0x10, 0x01], // SOF0
    [0xff, 0xda, 0x00, 0x04, 0x00, 0x00], // SOS - scan data follows
    [0x12, 0x34, 0x56, 0x78],
    [0xff, 0xd9]
  );
}

function le32(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

/** RIFF/WEBP with a VP8 chunk and, optionally, an EXIF chunk. */
function webp(opts: { exif?: Uint8Array; withExifHeader?: boolean } = {}): Uint8Array {
  const vp8Data = Uint8Array.from([1, 2, 3, 4]);
  const chunks: Uint8Array[] = [
    concat(ASCII("VP8 "), le32(vp8Data.length), vp8Data),
  ];
  if (opts.exif) {
    const payload = opts.withExifHeader
      ? concat(ASCII("Exif"), [0, 0], opts.exif)
      : opts.exif;
    const padded = payload.length % 2 === 1 ? concat(payload, [0]) : payload;
    chunks.push(concat(ASCII("EXIF"), le32(payload.length), padded));
  }
  const body = concat(ASCII("WEBP"), ...chunks);
  return concat(ASCII("RIFF"), le32(body.length), body);
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

// ---------------------------------------------------------------------------

describe("readOrientation: the eight EXIF values, both byte orders", () => {
  const EXPECTED: Record<
    ExifOrientation,
    { rotateDeg: number; mirrored: boolean; swapsAxes: boolean }
  > = {
    1: { rotateDeg: 0, mirrored: false, swapsAxes: false },
    2: { rotateDeg: 0, mirrored: true, swapsAxes: false },
    3: { rotateDeg: 180, mirrored: false, swapsAxes: false },
    4: { rotateDeg: 180, mirrored: true, swapsAxes: false },
    5: { rotateDeg: 90, mirrored: true, swapsAxes: true },
    6: { rotateDeg: 90, mirrored: false, swapsAxes: true },
    7: { rotateDeg: 270, mirrored: true, swapsAxes: true },
    8: { rotateDeg: 270, mirrored: false, swapsAxes: true },
  };

  for (const endian of ["II", "MM"] as const) {
    for (const value of [1, 2, 3, 4, 5, 6, 7, 8] as ExifOrientation[]) {
      it(`reads ${value} from a ${endian} JPEG and maps it to the right transform`, () => {
        const info = readOrientation(exifJpeg(value, endian));
        expect(info.orientation).toBe(value);
        expect(info.source).toBe("exif-jpeg");
        expect(info.rotateDeg).toBe(EXPECTED[value].rotateDeg);
        expect(info.mirrored).toBe(EXPECTED[value].mirrored);
        expect(info.swapsAxes).toBe(EXPECTED[value].swapsAxes);
      });
    }
  }

  it("does not confuse the byte orders - a big-endian 6 is 6, not 1536", () => {
    // The whole point of the MM cases: a naive little-endian read of the big
    // endian bytes yields 1536, which fails the range check and looks exactly
    // like "no tag", so a whole camera vendor would silently stay sideways.
    expect(readOrientation(exifJpeg(6, "MM")).orientation).toBe(6);
    expect(readOrientation(exifJpeg(6, "II")).orientation).toBe(6);
  });

  it("accepts a LONG-typed orientation as well as the usual SHORT", () => {
    expect(readOrientation(exifJpeg(8, "II", 4)).orientation).toBe(8);
    expect(readOrientation(exifJpeg(8, "MM", 4)).orientation).toBe(8);
  });

  it("rejects an out-of-range value rather than propagating it", () => {
    for (const bad of [0, 9, 1536, 65535]) {
      const info = readOrientation(exifJpeg(bad));
      expect(info.orientation).toBe(1);
      expect(info.source).toBe("none");
    }
  });
});

describe("readOrientation: never throws, never loops, on anything at all", () => {
  const hostile: [string, Uint8Array][] = [
    ["a zero-length buffer", new Uint8Array(0)],
    ["two bytes", Uint8Array.from([0xff, 0xd8])],
    ["a JPEG with no APP1", plainJpeg()],
    ["a JPEG whose APP1 is XMP, not Exif", jpegWithApp1(concat(ASCII("http://ns.adobe.com/xap/1.0/"), [0]))],
    ["an APP1 truncated before the IFD", jpegWithApp1(concat(ASCII("Exif"), [0, 0], tiffBlock(6, "II").slice(0, 9)))],
    ["an APP1 truncated mid-entry", jpegWithApp1(concat(ASCII("Exif"), [0, 0], tiffBlock(6, "II").slice(0, 14)))],
    ["a PNG", concat([0x89], ASCII("PNG"), [0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])],
    ["plain text", Uint8Array.from(ASCII("this is not an image at all, sorry"))],
    ["a JPEG whose segment length is 0", concat([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x00], ASCII("Exif"))],
    ["a JPEG whose segment length overruns the buffer", concat([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff], ASCII("Exif\0\0"))],
    ["a run of 0xff fill bytes", Uint8Array.from(new Array(400).fill(0xff))],
    ["random bytes", Uint8Array.from(new Array(600), (_, i) => (i * 37 + 11) % 256)],
  ];

  for (const [name, bytes] of hostile) {
    it(`answers upright for ${name} without throwing`, () => {
      const started = Date.now();
      let info = UPRIGHT;
      expect(() => {
        info = readOrientation(bytes);
      }).not.toThrow();
      expect(info.orientation).toBe(1);
      expect(info.source).toBe("none");
      expect(isUpright(info)).toBe(true);
      // A bounded parser, not an assertion about the machine: any unbounded
      // loop over these inputs blows straight past a whole second.
      expect(Date.now() - started).toBeLessThan(1000);
    });
  }

  it("survives null and undefined", () => {
    expect(readOrientation(null).orientation).toBe(1);
    expect(readOrientation(undefined).orientation).toBe(1);
    expect(readOrientationFromBase64(null).orientation).toBe(1);
    expect(readOrientationFromBase64("").orientation).toBe(1);
    expect(readOrientationFromBase64("not base64 !!!").orientation).toBe(1);
  });

  it("terminates on a RIFF chunk table that points at itself", () => {
    // A zero-length chunk must still advance the cursor past its own header,
    // or the walk never ends.
    const body = concat(ASCII("WEBP"), ASCII("ABCD"), le32(0), ASCII("EFGH"), le32(0));
    const bytes = concat(ASCII("RIFF"), le32(body.length), body);
    const started = Date.now();
    expect(readOrientation(bytes).orientation).toBe(1);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("terminates on a WebP whose chunk size overruns the file", () => {
    const body = concat(ASCII("WEBP"), ASCII("EXIF"), le32(0x7fffffff));
    const bytes = concat(ASCII("RIFF"), le32(body.length), body);
    expect(readOrientation(bytes).orientation).toBe(1);
  });
});

describe("readOrientation: WebP RIFF EXIF chunks", () => {
  it("reads the orientation out of a bare TIFF EXIF chunk", () => {
    const info = readOrientation(webp({ exif: tiffBlock(6, "II") }));
    expect(info.orientation).toBe(6);
    expect(info.source).toBe("exif-webp");
    expect(info.swapsAxes).toBe(true);
  });

  it("also accepts the Exif\\0\\0-prefixed variant some encoders write", () => {
    const info = readOrientation(webp({ exif: tiffBlock(3, "MM"), withExifHeader: true }));
    expect(info.orientation).toBe(3);
    expect(info.source).toBe("exif-webp");
    expect(info.rotateDeg).toBe(180);
  });

  it("returns none for a WebP with no EXIF chunk", () => {
    const info = readOrientation(webp());
    expect(info.orientation).toBe(1);
    expect(info.source).toBe("none");
  });

  it("finds the EXIF chunk after an odd-length chunk that needed RIFF padding", () => {
    const odd = concat(ASCII("VP8X"), le32(3), [1, 2, 3, 0]);
    const exif = tiffBlock(8, "II");
    const chunk = concat(ASCII("EXIF"), le32(exif.length), exif);
    const body = concat(ASCII("WEBP"), odd, chunk);
    const bytes = concat(ASCII("RIFF"), le32(body.length), body);
    expect(readOrientation(bytes).orientation).toBe(8);
  });
});

describe("readOrientationFromBase64: the same answer, a bounded amount of work", () => {
  it("agrees with readOrientation on the full buffer", () => {
    for (const value of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const bytes = exifJpeg(value);
      expect(readOrientationFromBase64(toBase64(bytes))).toEqual(readOrientation(bytes));
    }
  });

  it("tolerates a data-URL prefix, which is how the client sends images", () => {
    const b64 = toBase64(exifJpeg(6));
    expect(readOrientationFromBase64(`data:image/jpeg;base64,${b64}`).orientation).toBe(6);
  });

  it("reads a multi-megabyte payload without decoding more than the prefix", () => {
    // APP1 in the first few hundred bytes, then ~1.5MB of scan data behind it.
    const filler = Uint8Array.from(new Array(1_500_000), (_, i) => (i * 7) % 251);
    const big = concat(exifJpeg(6).slice(0, -2), filler, [0xff, 0xd9]);
    const b64 = toBase64(big);
    expect(b64.length).toBeGreaterThan(BASE64_PREFIX_CHARS);

    const prefix = base64Prefix(b64);
    expect(prefix.length).toBeLessThanOrEqual(BASE64_PREFIX_CHARS);
    // A partial 4-character group would decode to garbage, so the cut is aligned.
    expect(prefix.length % 4).toBe(0);
    expect(readOrientationFromBase64(b64).orientation).toBe(6);
  });

  it("leaves a short payload whole", () => {
    const b64 = toBase64(exifJpeg(2));
    expect(base64Prefix(b64).length).toBeLessThanOrEqual(b64.length);
    expect(readOrientationFromBase64(b64).orientation).toBe(2);
  });

  it("strips whitespace and stray characters before decoding", () => {
    const b64 = toBase64(exifJpeg(5));
    const wrapped = b64.replace(/(.{40})/g, "$1\n");
    expect(readOrientationFromBase64(wrapped).orientation).toBe(5);
  });
});

describe("orientationNote: prompt surface, pinned word for word", () => {
  const noteFor = (value: number, index?: number) =>
    orientationNote(orientationInfo(value, "exif-jpeg"), index);

  it("says nothing at all for an upright image", () => {
    expect(noteFor(1, 1)).toBe("");
    expect(orientationNote(undefined, 1)).toBe("");
    expect(orientationNote(null)).toBe("");
    expect(orientationNote(UPRIGHT, 2)).toBe("");
  });

  it("pins the 90-degree sentence", () => {
    expect(noteFor(6, 2)).toBe(
      "Image 2 is stored rotated: rotate it 90 degrees clockwise to view it upright. Read all text in that upright frame."
    );
  });

  it("pins the 180-degree sentence", () => {
    expect(noteFor(3, 1)).toBe(
      "Image 1 is stored rotated: rotate it 180 degrees clockwise to view it upright. Read all text in that upright frame."
    );
  });

  it("pins the 270-degree sentence", () => {
    expect(noteFor(8, 3)).toBe(
      "Image 3 is stored rotated: rotate it 270 degrees clockwise to view it upright. Read all text in that upright frame."
    );
  });

  it("pins the mirror-only sentence", () => {
    expect(noteFor(2, 1)).toBe(
      "Image 1 is stored mirrored: flip it horizontally to view it upright. Read all text in that upright frame."
    );
  });

  it("states the mirrored diagonal cases in the order the fix is applied", () => {
    expect(noteFor(5, 1)).toBe(
      "Image 1 is stored mirrored and rotated: rotate it 90 degrees clockwise, then flip it horizontally to view it upright. Read all text in that upright frame."
    );
    expect(noteFor(7, 1)).toBe(
      "Image 1 is stored mirrored and rotated: rotate it 270 degrees clockwise, then flip it horizontally to view it upright. Read all text in that upright frame."
    );
  });

  it("names the image generically when there is only one", () => {
    expect(noteFor(6)).toBe(
      "The image is stored rotated: rotate it 90 degrees clockwise to view it upright. Read all text in that upright frame."
    );
  });

  it("uses only the plain ASCII hyphen and no unicode punctuation", () => {
    for (const v of [2, 3, 4, 5, 6, 7, 8]) {
      expect(noteFor(v, 1)).toMatch(/^[\x20-\x7e]+$/);
    }
  });
});

describe("orientationNotes: the block prepended to a whole turn's vision text", () => {
  const rotated = orientationInfo(6, "exif-jpeg");
  const upright = orientationInfo(1, "exif-jpeg");

  it("is empty when every image is upright, so the prompt is unchanged", () => {
    expect(orientationNotes([{ orientation: upright }, { orientation: upright }])).toBe("");
    expect(orientationNotes([{}, {}])).toBe("");
    expect(orientationNotes([])).toBe("");
    expect(orientationNotes(null)).toBe("");
    expect(orientationNotes(undefined)).toBe("");
  });

  it("numbers the images it does mention by their position in the turn", () => {
    const block = orientationNotes([{ orientation: upright }, { orientation: rotated }]);
    expect(block).toBe(orientationNote(rotated, 2));
    expect(block).not.toContain("Image 1");
  });

  it("joins one line per rotated image", () => {
    const block = orientationNotes([{ orientation: rotated }, { orientation: rotated }]);
    expect(block.split("\n")).toHaveLength(2);
    expect(block.split("\n")[0]).toContain("Image 1");
    expect(block.split("\n")[1]).toContain("Image 2");
  });
});

describe("orientationAttrValue: the render hook", () => {
  it("is absent for upright and unmeasured images, so the DOM stays clean", () => {
    expect(orientationAttrValue(undefined)).toBeUndefined();
    expect(orientationAttrValue(null)).toBeUndefined();
    expect(orientationAttrValue(UPRIGHT)).toBeUndefined();
    expect(orientationAttrValue(orientationInfo(1, "exif-jpeg"))).toBeUndefined();
  });

  it("is the raw EXIF value for anything that needs correcting", () => {
    for (const v of [2, 3, 4, 5, 6, 7, 8]) {
      expect(orientationAttrValue(orientationInfo(v, "exif-jpeg"))).toBe(String(v));
    }
  });
});

describe("orientationInfo: hydrating a persisted value", () => {
  it("round-trips every legal value", () => {
    for (const v of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(orientationInfo(v, "exif-jpeg").orientation).toBe(v);
    }
  });

  it("falls back to upright for anything illegal", () => {
    for (const bad of [0, 9, -1, 1.5, NaN, Infinity]) {
      expect(orientationInfo(bad, "exif-jpeg")).toEqual(UPRIGHT);
    }
  });

  it("keeps the distinction between 'no tag' and 'a tag that said upright'", () => {
    // The client normalizer relies on this: no tag means a re-encode cannot
    // lose a correction, a tag means it might.
    expect(readOrientation(plainJpeg()).source).toBe("none");
    expect(readOrientation(exifJpeg(1)).source).toBe("exif-jpeg");
    expect(readOrientation(exifJpeg(1)).orientation).toBe(1);
  });
});
