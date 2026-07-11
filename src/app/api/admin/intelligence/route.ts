import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { sbSelect } from "@/lib/runtime-config";

// Shop-intelligence warehouse (New#18, owner only). Aggregates every REAL price
// a shop has given us, grouped by area and vehicle bucket, into a rich market
// picture: sample size, lowest / median / highest / average daily price, price
// spread, rental-duration range, delivery rate, verified count, distinct shops
// and freshness. This is the raw market truth we can later charge to expose.

interface OfferRow {
  vendor_id: string | null;
  vendor_name: string | null;
  price_per_day: number | null;
  list_price_per_day: number | null;
  currency: string | null;
  region_key: string | null;
  vehicle_key: string | null;
  duration_days: number | null;
  delivers: boolean | null;
  verified: boolean | null;
  created_at: string;
}

// scooter-125 -> "Scooter 125cc", car-suv -> "Car - SUV", etc.
function vehicleLabel(key: string): string {
  if (key === "unknown") return "Not tagged yet";
  const [cls, variant] = key.split("-");
  if (cls === "scooter" || cls === "motorbike") {
    const n = Number(variant);
    const name = cls === "scooter" ? "Scooter" : "Motorbike";
    if (variant === "big") return `${name} 650cc+`;
    return Number.isFinite(n) ? `${name} ${n}cc` : name;
  }
  if (cls === "car") {
    const v = variant ? variant.toUpperCase() : "";
    return v ? `Car - ${v.charAt(0) + v.slice(1).toLowerCase()}` : "Car";
  }
  return key;
}

// Currency -> country, so legacy offers with no region tag still land under a
// meaningful place ("Thailand") instead of a confusing "unknown".
const CURRENCY_COUNTRY: Record<string, string> = {
  THB: "Thailand", IDR: "Indonesia", VND: "Vietnam", INR: "India", JPY: "Japan",
  PHP: "Philippines", MYR: "Malaysia", SGD: "Singapore", TRY: "Turkey",
  MXN: "Mexico", BRL: "Brazil", AED: "UAE", SAR: "Saudi Arabia", EGP: "Egypt",
  MAD: "Morocco", ZAR: "South Africa", KES: "Kenya", LKR: "Sri Lanka",
  NPR: "Nepal", GBP: "United Kingdom", EUR: "Europe", USD: "United States",
  AUD: "Australia", NZD: "New Zealand", CAD: "Canada", ILS: "Israel",
};

// "koh phangan, thailand" -> "Koh Phangan, Thailand". When the region was never
// tagged we show the country implied by the quote's currency (clear + useful)
// instead of a cryptic "area pending".
function areaLabel(key: string, currencyHint?: string): string {
  if (!key || key === "unknown area") {
    const c = currencyHint ? CURRENCY_COUNTRY[currencyHint.toUpperCase()] : undefined;
    return c ? `${c} - area not tagged` : "Area not tagged yet";
  }
  return key.replace(/\b\w/g, (c) => c.toUpperCase());
}

// The display symbol for a currency ISO code (falls back to the code itself).
const CURRENCY_SYMBOL: Record<string, string> = {
  USD: "$", EUR: "€", GBP: "£", THB: "฿", ILS: "₪", JPY: "¥", INR: "₹",
  IDR: "Rp", VND: "₫", PHP: "₱", MYR: "RM", SGD: "S$", AUD: "A$", NZD: "NZ$",
  CAD: "C$", CHF: "CHF", CNY: "¥", HKD: "HK$", TWD: "NT$", KRW: "₩", TRY: "₺",
  MXN: "$", BRL: "R$", AED: "د.إ", SAR: "﷼", MAD: "DH", EGP: "E£", ZAR: "R",
  KES: "KSh", LKR: "Rs", NPR: "Rs", PLN: "zł", CZK: "Kč", HUF: "Ft",
  SEK: "kr", NOK: "kr", DKK: "kr", RUB: "₽",
};
function symbolFor(code: string): string {
  return CURRENCY_SYMBOL[(code || "").toUpperCase()] || code.toUpperCase();
}

function median(sorted: number[]): number {
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const rows = await sbSelect<OfferRow>(
    "offers",
    "select=vendor_id,vendor_name,price_per_day,list_price_per_day,currency,region_key,vehicle_key,duration_days,delivers,verified,created_at&simulated=eq.false&order=created_at.desc&limit=6000"
  );

  type Bucket = {
    prices: number[];
    listPrices: number[];
    currency: string;
    durations: number[];
    delivers: number;
    deliversKnown: number;
    verified: number;
    total: number;
    vendors: Set<string>;
    vendorNames: Set<string>;
    first: string;
    last: string;
  };
  const areas = new Map<string, Map<string, Bucket>>();

  for (const r of rows) {
    if (!r.price_per_day || r.price_per_day <= 0) continue;
    const area = r.region_key || "unknown area";
    const vk = r.vehicle_key || "unknown";
    if (!areas.has(area)) areas.set(area, new Map());
    const byV = areas.get(area)!;
    if (!byV.has(vk)) {
      byV.set(vk, {
        prices: [],
        listPrices: [],
        currency: r.currency || "USD",
        durations: [],
        delivers: 0,
        deliversKnown: 0,
        verified: 0,
        total: 0,
        vendors: new Set(),
        vendorNames: new Set(),
        first: r.created_at,
        last: r.created_at,
      });
    }
    const b = byV.get(vk)!;
    b.prices.push(Number(r.price_per_day));
    if (r.list_price_per_day) b.listPrices.push(Number(r.list_price_per_day));
    if (r.duration_days) b.durations.push(r.duration_days);
    if (r.delivers !== null) {
      b.deliversKnown += 1;
      if (r.delivers) b.delivers += 1;
    }
    if (r.verified) b.verified += 1;
    b.total += 1;
    if (r.vendor_id) b.vendors.add(r.vendor_id);
    if (r.vendor_name) b.vendorNames.add(r.vendor_name);
    if (r.created_at > b.last) b.last = r.created_at;
    if (r.created_at < b.first) b.first = r.created_at;
  }

  const result = [...areas.entries()]
    .map(([area, byV]) => {
      const vehicles = [...byV.entries()]
        .map(([vehicle, b]) => {
          const sorted = [...b.prices].sort((x, y) => x - y);
          const avg = Math.round(b.prices.reduce((s, x) => s + x, 0) / b.prices.length);
          const durs = [...b.durations].sort((x, y) => x - y);
          return {
            vehicle,
            vehicleLabel: vehicleLabel(vehicle),
            currency: b.currency,
            currencySymbol: symbolFor(b.currency),
            samples: b.total,
            shops: b.vendors.size,
            shopNames: [...b.vendorNames].slice(0, 8),
            low: sorted[0],
            median: median(sorted),
            high: sorted[sorted.length - 1],
            avg,
            spreadPct: sorted[0] ? Math.round(((sorted[sorted.length - 1] - sorted[0]) / sorted[0]) * 100) : 0,
            typicalDays: durs.length ? median(durs) : null,
            minDays: durs.length ? durs[0] : null,
            maxDays: durs.length ? durs[durs.length - 1] : null,
            delivers: b.delivers,
            deliverRate: b.deliversKnown ? Math.round((b.delivers / b.deliversKnown) * 100) : null,
            verified: b.verified,
            firstSeen: b.first,
            lastSeen: b.last,
          };
        })
        .sort((a, b) => b.samples - a.samples);
      const areaSamples = vehicles.reduce((s, v) => s + v.samples, 0);
      const areaShops = new Set<string>();
      for (const b of byV.values()) for (const v of b.vendors) areaShops.add(v);
      const currencyHint = vehicles[0]?.currency;
      return {
        area,
        areaLabel: areaLabel(area, currencyHint),
        tagged: area !== "unknown area",
        samples: areaSamples,
        shops: areaShops.size,
        vehicles,
      };
    })
    // Tagged, data-rich areas first.
    .sort((a, b) => Number(b.tagged) - Number(a.tagged) || b.samples - a.samples);

  return NextResponse.json({
    areas: result,
    totalOffers: rows.length,
    areasCount: result.length,
  });
}
