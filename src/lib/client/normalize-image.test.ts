import { describe, it, expect } from "vitest";
import {
  targetSize,
  uprightSize,
  shrinkStep,
  dataUrlBytes,
  chooseStrategy,
} from "./normalize-image";
import { orientationInfo, UPRIGHT } from "../media/orientation";

// The DOM half of normalize-image is four calls to createImageBitmap / canvas /
// toDataURL and there is no canvas in this environment. Every decision that can
// be WRONG was pulled out into the pure functions below, which is where the
// coverage belongs: a canvas mock would only assert that we call the API we
// obviously call, while these assert the rules that actually decide whether a
// price board arrives upright and small enough to post.

describe("targetSize: the axis swap and the no-upsample rule", () => {
  it("leaves a small image alone rather than scaling it up", () => {
    expect(targetSize(400, 300, false, 1280)).toEqual({ w: 400, h: 300 });
    expect(targetSize(1280, 960, false, 1280)).toEqual({ w: 1280, h: 960 });
  });

  it("caps the longest edge at maxDim", () => {
    expect(targetSize(4032, 3024, false, 1280)).toEqual({ w: 1280, h: 960 });
    expect(targetSize(3024, 4032, false, 1280)).toEqual({ w: 960, h: 1280 });
  });

  it("transposes the axes when EXIF says the picture is turned", () => {
    // A 4032x3024 sensor frame tagged "rotate 90" IS a 3024x4032 picture.
    expect(targetSize(4032, 3024, true, 1280)).toEqual({ w: 960, h: 1280 });
    expect(targetSize(4032, 3024, false, 1280)).toEqual({ w: 1280, h: 960 });
  });

  it("preserves the aspect ratio to within a pixel of rounding", () => {
    const cases: [number, number][] = [
      [4032, 3024],
      [3000, 4000],
      [1920, 1080],
      [1000, 333],
      [777, 1013],
    ];
    for (const [w, h] of cases) {
      for (const swaps of [false, true]) {
        const out = targetSize(w, h, swaps, 1280);
        const srcRatio = swaps ? h / w : w / h;
        expect(Math.abs(out.w / out.h - srcRatio)).toBeLessThan(0.01);
      }
    }
  });

  it("never returns a zero or negative dimension, whatever it is handed", () => {
    const junk: [number, number, number][] = [
      [0, 0, 1280],
      [-5, -5, 1280],
      [NaN, 100, 1280],
      [100, Infinity, 1280],
      [4000, 3000, 0],
      [4000, 3000, -1],
      [1, 40000, 1280],
    ];
    for (const [w, h, max] of junk) {
      const out = targetSize(w, h, false, max);
      expect(out.w).toBeGreaterThanOrEqual(1);
      expect(out.h).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(out.w)).toBe(true);
      expect(Number.isInteger(out.h)).toBe(true);
    }
  });
});

describe("uprightSize: targetSize driven by a parsed OrientationInfo", () => {
  it("swaps for 5-8 and does not for 1-4", () => {
    for (const v of [1, 2, 3, 4]) {
      expect(uprightSize(4032, 3024, orientationInfo(v, "exif-jpeg"), 1280)).toEqual({
        w: 1280,
        h: 960,
      });
    }
    for (const v of [5, 6, 7, 8]) {
      expect(uprightSize(4032, 3024, orientationInfo(v, "exif-jpeg"), 1280)).toEqual({
        w: 960,
        h: 1280,
      });
    }
  });

  it("treats an unmeasured image as unswapped", () => {
    expect(uprightSize(4032, 3024, undefined, 1280)).toEqual({ w: 1280, h: 960 });
    expect(uprightSize(4032, 3024, UPRIGHT, 1280)).toEqual({ w: 1280, h: 960 });
  });
});

describe("shrinkStep: the over-budget loop provably ends", () => {
  it("spends quality before it spends pixels", () => {
    const first = shrinkStep({ maxDim: 1280, quality: 0.82 });
    expect(first.maxDim).toBe(1280);
    expect(first.quality).toBeLessThan(0.82);
  });

  it("starts shrinking dimensions only once quality hits the legibility floor", () => {
    let step = { maxDim: 1280, quality: 0.82 };
    let sawDimensionDrop = false;
    for (let i = 0; i < 6; i++) {
      const next = shrinkStep(step);
      if (next.maxDim < step.maxDim) {
        sawDimensionDrop = true;
        expect(step.quality).toBeLessThanOrEqual(0.56 + 1e-9);
      }
      step = next;
    }
    expect(sawDimensionDrop).toBe(true);
  });

  it("reaches a fixed point, so any caller loop terminates", () => {
    let step = { maxDim: 1280, quality: 0.82 };
    for (let i = 0; i < 200; i++) step = shrinkStep(step);
    expect(shrinkStep(step)).toEqual(step);
    expect(step.maxDim).toBeGreaterThanOrEqual(640);
    expect(step.quality).toBeGreaterThan(0.5);
  });

  it("never lets quality run away to zero or negative", () => {
    let step = { maxDim: 1280, quality: 0.82 };
    for (let i = 0; i < 50; i++) {
      step = shrinkStep(step);
      expect(step.quality).toBeGreaterThan(0);
      expect(step.quality).toBeLessThanOrEqual(1);
    }
  });
});

describe("dataUrlBytes: the budget check, without allocating the bytes", () => {
  const b64 = (bytes: number[]) => Buffer.from(Uint8Array.from(bytes)).toString("base64");

  it("matches the real decoded length for every padding case", () => {
    for (let n = 0; n < 24; n++) {
      const bytes = Array.from({ length: n }, (_, i) => i % 256);
      expect(dataUrlBytes(`data:image/jpeg;base64,${b64(bytes)}`)).toBe(n);
    }
  });

  it("works on a bare base64 body with no data-URL header", () => {
    expect(dataUrlBytes(b64([1, 2, 3, 4, 5]))).toBe(5);
  });

  it("is zero for nothing at all", () => {
    expect(dataUrlBytes("")).toBe(0);
    expect(dataUrlBytes(null)).toBe(0);
    expect(dataUrlBytes(undefined)).toBe(0);
    expect(dataUrlBytes("data:image/jpeg;base64,")).toBe(0);
  });
});

describe("chooseStrategy: the conservative fallback is a rule, not a guess", () => {
  it("uses createImageBitmap whenever the engine has it", () => {
    expect(chooseStrategy(true, orientationInfo(6, "exif-jpeg"))).toBe("bitmap-upright");
    expect(chooseStrategy(true, UPRIGHT)).toBe("bitmap-upright");
    expect(chooseStrategy(true, undefined)).toBe("bitmap-upright");
  });

  it("re-encodes on a legacy engine only when there is no tag to lose", () => {
    expect(chooseStrategy(false, UPRIGHT)).toBe("downscale-no-exif");
    expect(chooseStrategy(false, undefined)).toBe("downscale-no-exif");
    expect(chooseStrategy(false, null)).toBe("downscale-no-exif");
  });

  it("hands back the original whenever an orientation tag exists it cannot honour", () => {
    // Including value 1: the tag being PRESENT is what makes a re-encode
    // ambiguous, because we cannot tell whether the engine already applied it.
    for (const v of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(chooseStrategy(false, orientationInfo(v, "exif-jpeg"))).toBe("original");
      expect(chooseStrategy(false, orientationInfo(v, "exif-webp"))).toBe("original");
    }
  });

  it("only ever answers with a known strategy", () => {
    const known = new Set(["bitmap-upright", "downscale-no-exif", "original"]);
    for (const has of [true, false]) {
      for (const info of [undefined, UPRIGHT, orientationInfo(6, "exif-jpeg")]) {
        expect(known.has(chooseStrategy(has, info))).toBe(true);
      }
    }
  });
});
