// Currency catalogue. Pricing is anchored in ILS (matches the Lemon Squeezy
// products exactly); everything else is a display conversion. USD is the
// professional default. A hidden 0.2% is applied to non-ILS conversions.

export interface Currency {
  code: string;
  symbol: string;
  flag: string;
  perIls: number; // 1 ILS = perIls units of this currency (approximate)
}

export const CURRENCIES: Currency[] = [
  { code: "USD", symbol: "$", flag: "🇺🇸", perIls: 0.27 },
  { code: "ILS", symbol: "₪", flag: "🇮🇱", perIls: 1 },
  { code: "EUR", symbol: "€", flag: "🇪🇺", perIls: 0.25 },
  { code: "GBP", symbol: "£", flag: "🇬🇧", perIls: 0.21 },
  { code: "AUD", symbol: "A$", flag: "🇦🇺", perIls: 0.41 },
  { code: "CAD", symbol: "C$", flag: "🇨🇦", perIls: 0.37 },
  { code: "CHF", symbol: "CHF", flag: "🇨🇭", perIls: 0.24 },
  { code: "JPY", symbol: "¥", flag: "🇯🇵", perIls: 42 },
  { code: "CNY", symbol: "¥", flag: "🇨🇳", perIls: 1.95 },
  { code: "INR", symbol: "₹", flag: "🇮🇳", perIls: 23 },
  { code: "THB", symbol: "฿", flag: "🇹🇭", perIls: 9.7 },
  { code: "IDR", symbol: "Rp", flag: "🇮🇩", perIls: 4400 },
  { code: "VND", symbol: "₫", flag: "🇻🇳", perIls: 6900 },
  { code: "SGD", symbol: "S$", flag: "🇸🇬", perIls: 0.36 },
  { code: "AED", symbol: "د.إ", flag: "🇦🇪", perIls: 0.99 },
  { code: "TRY", symbol: "₺", flag: "🇹🇷", perIls: 9.2 },
  { code: "MXN", symbol: "$", flag: "🇲🇽", perIls: 5.1 },
  { code: "BRL", symbol: "R$", flag: "🇧🇷", perIls: 1.5 },
  { code: "ZAR", symbol: "R", flag: "🇿🇦", perIls: 5.0 },
  { code: "RUB", symbol: "₽", flag: "🇷🇺", perIls: 25 },
  { code: "PLN", symbol: "zł", flag: "🇵🇱", perIls: 1.08 },
  { code: "PHP", symbol: "₱", flag: "🇵🇭", perIls: 15.5 },
  { code: "MYR", symbol: "RM", flag: "🇲🇾", perIls: 1.24 },
  { code: "NZD", symbol: "NZ$", flag: "🇳🇿", perIls: 0.45 },
  { code: "HKD", symbol: "HK$", flag: "🇭🇰", perIls: 2.1 },
  { code: "TWD", symbol: "NT$", flag: "🇹🇼", perIls: 8.7 },
  { code: "KRW", symbol: "₩", flag: "🇰🇷", perIls: 370 },
  { code: "SAR", symbol: "﷼", flag: "🇸🇦", perIls: 1.01 },
  { code: "MAD", symbol: "DH", flag: "🇲🇦", perIls: 2.7 },
  { code: "EGP", symbol: "E£", flag: "🇪🇬", perIls: 13.3 },
  { code: "LKR", symbol: "Rs", flag: "🇱🇰", perIls: 82 },
  { code: "NPR", symbol: "Rs", flag: "🇳🇵", perIls: 37 },
  { code: "CZK", symbol: "Kč", flag: "🇨🇿", perIls: 6.2 },
  { code: "HUF", symbol: "Ft", flag: "🇭🇺", perIls: 98 },
  { code: "SEK", symbol: "kr", flag: "🇸🇪", perIls: 2.9 },
  { code: "NOK", symbol: "kr", flag: "🇳🇴", perIls: 3.0 },
  { code: "DKK", symbol: "kr", flag: "🇩🇰", perIls: 1.9 },
];

export function currency(code: string): Currency {
  return CURRENCIES.find((c) => c.code === code) ?? CURRENCIES[0];
}

/** Convert an ILS amount to a display string in the given currency. */
export function fromIls(ils: number, code: string): string {
  const c = currency(code);
  const adj = code === "ILS" ? 1 : 1.002; // silent 0.2% FX handling fee
  const n = ils * c.perIls * adj;
  const rounded =
    n >= 1000 ? Math.round(n).toLocaleString() : n.toFixed(2).replace(/\.00$/, "");
  return c.symbol.length > 1 ? `${c.symbol} ${rounded}` : `${c.symbol}${rounded}`;
}

/**
 * Format an amount that is ALREADY in the shop's local currency (offers come
 * from vendor replies in their own money - never convert, never force "$").
 */
export function moneyLocal(amount: number, code?: string): string {
  const c = CURRENCIES.find((x) => x.code === (code ?? "").toUpperCase());
  const n =
    amount >= 1000
      ? Math.round(amount).toLocaleString()
      : `${Math.round(amount * 100) / 100}`;
  if (!c) return code ? `${n} ${code.toUpperCase()}` : `$${n}`;
  return c.symbol.length > 1 ? `${c.symbol} ${n}` : `${c.symbol}${n}`;
}

export function savedCurrency(): string {
  try {
    return localStorage.getItem("wd_currency") || "USD";
  } catch {
    return "USD";
  }
}

export function setSavedCurrency(code: string) {
  try {
    localStorage.setItem("wd_currency", code);
  } catch {}
}
