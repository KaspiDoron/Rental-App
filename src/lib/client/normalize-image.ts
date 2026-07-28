"use client";

// UPRIGHT PIXELS BEFORE THEY EVER LEAVE THE PHONE.
//
// The single highest-risk EXIF path in this app is a traveller standing in front
// of a shop, photographing a price board with an iPhone held vertically, and
// attaching it in PasteReplyModal. That file is Orientation=6 nine times out of
// ten. Every downstream reader then has to guess, and the vision model reading a
// sideways board turns its columns into rows - which is how a "250/day" row gets
// attached to the wrong vehicle, or dropped.
//
// The browser is the one place in the whole system where rotating pixels is FREE:
// `createImageBitmap(file, { imageOrientation: "from-image" })` is spec-guaranteed
// to hand back an already-corrected bitmap, and the canvas re-encode we were
// doing anyway (to stay under the JSON body limit) then produces an upright JPEG
// that needs no EXIF at all. So the correction happens here, at the source, and
// the server never has to own a codec.
//
// This replaces three near-identical hand-rolled `new Image()` + `drawImage()`
// helpers (PasteReplyModal, FeedbackModal, MediaStudio). All three destroyed EXIF
// irreversibly - `canvas.toDataURL` writes no metadata - while relying on the
// engine having silently auto-applied orientation during decode. Where that
// assumption held, the output was upright by luck; where it did not, the photo
// was permanently sideways with no tag left to recover it from.
//
// THE FALLBACK IS DELIBERATELY CONSERVATIVE. On an engine with no
// `createImageBitmap` (iOS Safari below 15) we cannot tell whether `drawImage`
// already applied the tag. Guessing has an unrecoverable failure mode: guess
// wrong and we ship doubly-rotated pixels with the EXIF stripped off, and nobody
// downstream can ever undo it. So when the bytes carry an orientation tag we
// hand back the ORIGINAL file untouched - larger, but every correction in the
// system (image-orientation in CSS, the model's orientation note) still works.
// We only re-encode on that path when the parser proves there is no tag to lose.
//
// Nothing here throws. A modal that cannot attach a photo must still be a modal.

import { readOrientation, type OrientationInfo } from "../media/orientation";

/** How the pixels were produced. Also the unit of the pure decision below. */
export type NormalizeStrategy =
  /** createImageBitmap corrected the orientation; output is upright JPEG, no EXIF. */
  | "bitmap-upright"
  /** No orientation tag exists, so a plain canvas downscale cannot lose one. */
  | "downscale-no-exif"
  /** Handed through unchanged, EXIF intact, because re-encoding could not be proven safe. */
  | "original";

export interface NormalizedImage {
  /** A data URL ready to POST. "" only when the file could not be read at all. */
  dataUrl: string;
  /** The mime of `dataUrl` - "image/jpeg" when re-encoded, the source type otherwise. */
  mime: string;
  /** Decoded byte length of `dataUrl`, so callers can enforce their own budget. */
  bytes: number;
  /** Output pixel size. 0 when the file was passed through without decoding. */
  width: number;
  height: number;
  /** True only when the pixels are known to be upright and carry no EXIF. */
  upright: boolean;
  strategy: NormalizeStrategy;
}

export interface NormalizeOptions {
  /** Longest output edge in pixels. Text on a price board needs room to survive. */
  maxDim?: number;
  /** Initial JPEG quality. Lowered first when the size cap is exceeded. */
  quality?: number;
  /** Hard ceiling on the encoded bytes. The cap PasteReplyModal never had. */
  maxBytes?: number;
}

const DEFAULT_MAX_DIM = 1280;
const DEFAULT_QUALITY = 0.82;
const DEFAULT_MAX_BYTES = 1_400_000;
/** Bounded because a shrink loop over a user file must never be unbounded. */
const MAX_SHRINK_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// The pure decision layer - everything that can be wrong lives here, where it
// can be tested without a canvas.
// ---------------------------------------------------------------------------

/**
 * Output size for an image whose STORED dimensions are w x h.
 *
 * `swapsAxes` is the EXIF 5-8 transpose: a 4032x3024 sensor frame tagged
 * "rotate 90" is a 3024x4032 picture, and sizing the canvas from the stored
 * numbers is how a portrait board ends up squashed into a landscape box. Never
 * upsamples - scaling a phone photo up costs bytes and adds no readable text.
 */
export function targetSize(
  w: number,
  h: number,
  swapsAxes: boolean,
  maxDim: number
): { w: number; h: number } {
  const sw = Number.isFinite(w) && w > 0 ? w : 1;
  const sh = Number.isFinite(h) && h > 0 ? h : 1;
  const outW = swapsAxes ? sh : sw;
  const outH = swapsAxes ? sw : sh;
  const cap = Number.isFinite(maxDim) && maxDim > 0 ? maxDim : DEFAULT_MAX_DIM;
  const scale = Math.min(1, cap / Math.max(outW, outH));
  return {
    w: Math.max(1, Math.round(outW * scale)),
    h: Math.max(1, Math.round(outH * scale)),
  };
}

/** The upright output size implied by an OrientationInfo. Convenience over targetSize. */
export function uprightSize(
  w: number,
  h: number,
  info: OrientationInfo | null | undefined,
  maxDim: number
): { w: number; h: number } {
  return targetSize(w, h, Boolean(info?.swapsAxes), maxDim);
}

/**
 * One step down when the encode came out over budget. Quality goes first because
 * it is nearly free for photographs of text; only once it hits the legibility
 * floor do we start throwing pixels away. Both knobs clamp, so repeated
 * application reaches a fixed point and the caller's loop provably terminates.
 */
export function shrinkStep(step: { maxDim: number; quality: number }): {
  maxDim: number;
  quality: number;
} {
  if (step.quality > 0.56) {
    return { maxDim: step.maxDim, quality: Math.round((step.quality - 0.12) * 100) / 100 };
  }
  return { maxDim: Math.max(640, Math.round(step.maxDim * 0.75)), quality: 0.56 };
}

/** Decoded byte length of a data URL, without allocating the bytes. */
export function dataUrlBytes(dataUrl: string | null | undefined): number {
  if (typeof dataUrl !== "string") return 0;
  const comma = dataUrl.indexOf(",");
  const body = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  if (!body) return 0;
  let pad = 0;
  if (body.endsWith("==")) pad = 2;
  else if (body.endsWith("=")) pad = 1;
  return Math.max(0, Math.floor((body.length * 3) / 4) - pad);
}

/**
 * Which path to take. Pure so the conservative fallback rule is pinned by test
 * rather than living inside a branch nobody can reach in jsdom.
 */
export function chooseStrategy(
  hasCreateImageBitmap: boolean,
  info: OrientationInfo | null | undefined
): NormalizeStrategy {
  if (hasCreateImageBitmap) return "bitmap-upright";
  // No tag means no correction can be lost by re-encoding.
  if (!info || info.source === "none") return "downscale-no-exif";
  return "original";
}

// ---------------------------------------------------------------------------
// The thin DOM layer
// ---------------------------------------------------------------------------

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve) => {
    try {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
      reader.onerror = () => resolve("");
      reader.readAsDataURL(file);
    } catch {
      resolve("");
    }
  });
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    try {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => resolve(null);
      im.src = url;
    } catch {
      resolve(null);
    }
  });
}

function encode(
  source: CanvasImageSource,
  w: number,
  h: number,
  quality: number
): string {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.drawImage(source, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", quality);
}

/**
 * Encode, and keep shrinking until the result fits the byte budget. Returns the
 * last attempt even if it is still over - an oversized photo is worth more to a
 * negotiation than no photo, and the caller decides.
 */
function encodeWithinBudget(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  swapsAxes: boolean,
  opts: Required<NormalizeOptions>
): { dataUrl: string; w: number; h: number } {
  let step = { maxDim: opts.maxDim, quality: opts.quality };
  let best = { dataUrl: "", w: 0, h: 0 };
  for (let attempt = 0; attempt < MAX_SHRINK_ATTEMPTS; attempt++) {
    const size = targetSize(srcW, srcH, swapsAxes, step.maxDim);
    const dataUrl = encode(source, size.w, size.h, step.quality);
    if (!dataUrl) return best;
    best = { dataUrl, w: size.w, h: size.h };
    if (dataUrlBytes(dataUrl) <= opts.maxBytes) return best;
    const next = shrinkStep(step);
    if (next.maxDim === step.maxDim && next.quality === step.quality) return best;
    step = next;
  }
  return best;
}

function passthrough(dataUrl: string, mime: string): NormalizedImage {
  return {
    dataUrl,
    mime,
    bytes: dataUrlBytes(dataUrl),
    width: 0,
    height: 0,
    upright: false,
    strategy: "original",
  };
}

/**
 * Turn a camera-roll File into an upload-ready data URL whose pixels are upright.
 *
 * Never rejects. The worst outcome is the original file handed back unchanged
 * with `upright: false`, which every downstream correction still copes with.
 */
export async function normalizeImageFile(
  file: File,
  opts?: NormalizeOptions
): Promise<NormalizedImage> {
  const settings: Required<NormalizeOptions> = {
    maxDim: opts?.maxDim ?? DEFAULT_MAX_DIM,
    quality: opts?.quality ?? DEFAULT_QUALITY,
    maxBytes: opts?.maxBytes ?? DEFAULT_MAX_BYTES,
  };
  const sourceMime = file?.type || "image/jpeg";

  // Anything that is not an image (a PDF price list, a stray .heic the engine
  // cannot decode) is not ours to re-encode.
  if (!file || !sourceMime.startsWith("image/")) {
    return passthrough(await readAsDataUrl(file), sourceMime);
  }

  const hasBitmap = typeof (globalThis as { createImageBitmap?: unknown }).createImageBitmap === "function";

  // The tag is read from the bytes we hold, not inferred from the engine - it is
  // what makes the no-createImageBitmap branch a decision instead of a guess.
  let info: OrientationInfo | undefined;
  if (!hasBitmap) {
    try {
      info = readOrientation(new Uint8Array(await file.arrayBuffer()));
    } catch {
      info = undefined;
    }
  }

  const strategy = chooseStrategy(hasBitmap, info);

  if (strategy === "bitmap-upright") {
    try {
      // The option is what does the work. An engine that ignores it hands back
      // the stored pixels, which is exactly the "original" outcome anyway.
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      try {
        // The bitmap is already upright, so its own dimensions are the upright
        // ones - no axis swap to apply on top.
        const out = encodeWithinBudget(bitmap, bitmap.width, bitmap.height, false, settings);
        if (out.dataUrl) {
          return {
            dataUrl: out.dataUrl,
            mime: "image/jpeg",
            bytes: dataUrlBytes(out.dataUrl),
            width: out.w,
            height: out.h,
            upright: true,
            strategy: "bitmap-upright",
          };
        }
      } finally {
        bitmap.close?.();
      }
    } catch {
      /* fall through to the untouched original */
    }
    return passthrough(await readAsDataUrl(file), sourceMime);
  }

  if (strategy === "downscale-no-exif") {
    // Reached through globalThis rather than the bare identifier: an engine
    // without URL would make a plain reference throw a ReferenceError that no
    // optional-chaining guard catches.
    const objectUrls = (globalThis as { URL?: typeof URL }).URL;
    const url = typeof objectUrls?.createObjectURL === "function" ? objectUrls.createObjectURL(file) : "";
    try {
      const img = url ? await loadImage(url) : null;
      if (img) {
        const out = encodeWithinBudget(img, img.naturalWidth, img.naturalHeight, false, settings);
        if (out.dataUrl) {
          return {
            dataUrl: out.dataUrl,
            mime: "image/jpeg",
            bytes: dataUrlBytes(out.dataUrl),
            width: out.w,
            height: out.h,
            upright: true,
            strategy: "downscale-no-exif",
          };
        }
      }
    } catch {
      /* fall through */
    } finally {
      if (url) objectUrls?.revokeObjectURL(url);
    }
  }

  return passthrough(await readAsDataUrl(file), sourceMime);
}
