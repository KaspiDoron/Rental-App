// Region resolution for opener copy (pure). The bug this fixes: region came
// from the origin/stay LABEL (a Google Places hotel string), never from the
// shop's phone country - so a Filipino sign-off ("Salamat!") reached a +84
// Vietnam shop, and Vietnamese "cam on" was glued onto the greeting. Here the
// SHOP's phone country prefix decides the region; the label is only a fallback.

export type ShopRegion = "philippines" | "thailand" | "vietnam" | "indonesia";

// Country calling code -> region. Only the SE-Asia markets we localise for.
const PREFIX_REGION: { prefix: string; region: ShopRegion }[] = [
  { prefix: "63", region: "philippines" },
  { prefix: "66", region: "thailand" },
  { prefix: "84", region: "vietnam" },
  { prefix: "62", region: "indonesia" },
];

/** The region implied by a shop's phone number (digits, with or without +).
 * Returns null for anything outside the localised markets. */
export function regionFromPhone(phoneOrDigits: string): ShopRegion | null {
  const digits = (phoneOrDigits || "").replace(/\D/g, "").replace(/^0+/, "");
  for (const { prefix, region } of PREFIX_REGION) {
    if (digits.startsWith(prefix)) return region;
  }
  return null;
}

/** The region key for a shop: the phone country WINS (authoritative), falling
 * back to a country name found in the origin/stay label. Undefined when neither
 * resolves - the compiler then uses neutral English (no regional flavor). */
export function regionForShop(shopDigits: string, fallbackLabel?: string): ShopRegion | undefined {
  const byPhone = regionFromPhone(shopDigits);
  if (byPhone) return byPhone;
  const label = (fallbackLabel ?? "").toLowerCase();
  const named = (["philippines", "thailand", "vietnam", "indonesia"] as ShopRegion[]).find((r) =>
    label.includes(r)
  );
  return named;
}
