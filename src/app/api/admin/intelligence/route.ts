import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { sbSelect } from "@/lib/runtime-config";

// Shop-intelligence warehouse (New#18, owner only). Aggregates every REAL
// price a shop has given us, grouped by area and vehicle bucket, into: sample
// size, lowest / highest / average daily price, typical rental duration, and a
// delivery signal. This is the raw market truth we can later charge to expose.

interface OfferRow {
  vendor_id: string | null;
  vendor_name: string | null;
  price_per_day: number | null;
  currency: string | null;
  region_key: string | null;
  vehicle_key: string | null;
  duration_days: number | null;
  delivers: boolean | null;
  created_at: string;
}

export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const rows = await sbSelect<OfferRow>(
    "offers",
    "select=vendor_id,vendor_name,price_per_day,currency,region_key,vehicle_key,duration_days,delivers,created_at&simulated=eq.false&order=created_at.desc&limit=4000"
  );

  // Group by area -> vehicle bucket.
  type Bucket = {
    prices: number[];
    currency: string;
    durations: number[];
    delivers: number;
    total: number;
    vendors: Set<string>;
    last: string;
  };
  const areas = new Map<string, Map<string, Bucket>>();

  for (const r of rows) {
    const area = r.region_key || "unknown area";
    const vk = r.vehicle_key || "unknown";
    if (!r.price_per_day || r.price_per_day <= 0) continue;
    if (!areas.has(area)) areas.set(area, new Map());
    const byV = areas.get(area)!;
    if (!byV.has(vk)) {
      byV.set(vk, {
        prices: [],
        currency: r.currency || "USD",
        durations: [],
        delivers: 0,
        total: 0,
        vendors: new Set(),
        last: r.created_at,
      });
    }
    const b = byV.get(vk)!;
    b.prices.push(Number(r.price_per_day));
    if (r.duration_days) b.durations.push(r.duration_days);
    if (r.delivers) b.delivers += 1;
    b.total += 1;
    if (r.vendor_id) b.vendors.add(r.vendor_id);
    if (r.created_at > b.last) b.last = r.created_at;
  }

  const result = [...areas.entries()]
    .map(([area, byV]) => ({
      area,
      vehicles: [...byV.entries()]
        .map(([vehicle, b]) => {
          const sorted = [...b.prices].sort((x, y) => x - y);
          const avg = Math.round(b.prices.reduce((s, x) => s + x, 0) / b.prices.length);
          return {
            vehicle,
            currency: b.currency,
            samples: b.total,
            shops: b.vendors.size,
            low: sorted[0],
            high: sorted[sorted.length - 1],
            avg,
            typicalDays: b.durations.length
              ? Math.round(b.durations.reduce((s, x) => s + x, 0) / b.durations.length)
              : null,
            deliverRate: b.total ? Math.round((b.delivers / b.total) * 100) : 0,
            lastSeen: b.last,
          };
        })
        .sort((a, b) => a.vehicle.localeCompare(b.vehicle)),
    }))
    .sort((a, b) => a.area.localeCompare(b.area));

  return NextResponse.json({ areas: result, totalOffers: rows.length });
}
