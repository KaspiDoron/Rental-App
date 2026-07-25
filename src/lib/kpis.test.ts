import { describe, it, expect, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { avgDiscountPct, percentile } from "./kpis";

describe("percentile - response-latency p50/p95", () => {
  it("nearest-rank percentiles over a sample", () => {
    const xs = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    expect(percentile(xs, 50)).toBe(500);
    expect(percentile(xs, 95)).toBe(1000);
    expect(percentile(xs, 100)).toBe(1000);
  });
  it("handles unsorted input and a single value", () => {
    expect(percentile([900, 100, 500], 50)).toBe(500);
    expect(percentile([42], 95)).toBe(42);
  });
  it("returns null for an empty sample", () => {
    expect(percentile([], 50)).toBeNull();
  });
});

describe("avgDiscountPct - durable discount margin from offers", () => {
  it("averages the realized (list -> paid) discount as a percentage", () => {
    // 300->240 = 20%, 500->450 = 10%  => avg 15%
    const r = avgDiscountPct([
      { list_price_per_day: 300, price_per_day: 240 },
      { list_price_per_day: 500, price_per_day: 450 },
    ]);
    expect(r.pct).toBe(15);
    expect(r.sampled).toBe(2);
  });

  it("ignores rows with no list price, non-positive, or paid>list (bad data)", () => {
    const r = avgDiscountPct([
      { list_price_per_day: null, price_per_day: 200 }, // no list -> skip
      { list_price_per_day: 0, price_per_day: 0 }, // zero -> skip
      { list_price_per_day: 200, price_per_day: 250 }, // paid>list -> skip
      { list_price_per_day: 400, price_per_day: 300 }, // 25% -> counts
    ]);
    expect(r.sampled).toBe(1);
    expect(r.pct).toBe(25);
  });

  it("coerces numeric strings (PostgREST numeric columns arrive as strings)", () => {
    const r = avgDiscountPct([{ list_price_per_day: "1000", price_per_day: "800" }]);
    expect(r.pct).toBe(20);
  });

  it("returns null pct when there is no usable sample", () => {
    expect(avgDiscountPct([]).pct).toBeNull();
    expect(avgDiscountPct([{ list_price_per_day: null, price_per_day: null }]).pct).toBeNull();
  });
});
