// Structured deposit parsing - turns a shop's free-text deposit label (e.g.
// "3,000 THB cash", "Passport only", "Passport or 2000 baht", "No deposit")
// into a normalized { type, amount, currency } so the app can show a precise
// tag next to the price and filter by deposit kind. Pure + dependency-free, so
// it is fully unit-testable and safe to import anywhere (no server-only).

export type DepositType = "cash" | "passport" | "id" | "license" | "other" | "none";

export interface ParsedDeposit {
  type: DepositType;
  amount?: number; // cash figure when one was stated
  currency?: string; // currency of amount (from the label, else the fallback)
}

// A small map of currency words/symbols shops actually type in deposit lines.
const WORD_CURRENCY: [RegExp, string][] = [
  [/฿|\bthb\b|\bbaht\b/i, "THB"],
  [/\bidr\b|\brp\b|\brupiah\b/i, "IDR"],
  [/₫|\bvnd\b|\bdong\b/i, "VND"],
  [/₱|\bphp\b|\bpeso\b/i, "PHP"],
  [/₹|\binr\b|\brupee?s?\b/i, "INR"],
  [/\bmyr\b|\brm\b|\bringgit\b/i, "MYR"],
  [/€|\beur\b|\beuro?s?\b/i, "EUR"],
  [/£|\bgbp\b|\bpound?s?\b/i, "GBP"],
  [/\$|\busd\b|\bdollars?\b/i, "USD"],
];

function currencyInText(s: string): string | undefined {
  for (const [re, code] of WORD_CURRENCY) if (re.test(s)) return code;
  return undefined;
}

// Pull the first plausible money amount out of a label. Handles thousands
// separators ("3,000" / "3.000" / "3 000") and plain numbers ("2000").
function amountInText(s: string): number | undefined {
  const m = s.match(/\d[\d.,\s]*\d|\d/);
  if (!m) return undefined;
  let digits = m[0].replace(/[\s,]/g, "");
  // A single dot with exactly 2 trailing digits is a decimal; otherwise (e.g.
  // "3.000") it is a thousands separator - strip it.
  if (/^\d+\.\d{3}$/.test(digits)) digits = digits.replace(".", "");
  const n = Number(digits);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

/**
 * Parse a shop's deposit label. Returns null when the label is empty (the shop
 * never stated a deposit - we must not invent one). When both a document and a
 * cash amount are offered ("passport or 2000"), the primary type is the
 * document and the cash figure is kept so the tag can show "Passport or ...".
 */
export function parseDeposit(raw?: string | null, fallbackCurrency?: string): ParsedDeposit | null {
  const s = (raw ?? "").trim();
  if (!s) return null;

  if (/\b(no deposit|deposit[-\s]?free|without (a )?deposit|no need (for )?(a )?deposit|zero deposit)\b/i.test(s)) {
    return { type: "none" };
  }

  const passport = /passport/i.test(s);
  const idCard = /\bid card\b|national id|\bktp\b|identity card/i.test(s);
  const license = /licen[cs]e|driving licen|driver'?s? licen/i.test(s);
  const amount = amountInText(s);
  const currency = amount != null ? currencyInText(s) ?? fallbackCurrency : undefined;

  // Priority: a document requirement is the primary "type" (it is the harder
  // ask), with any cash figure kept alongside. Cash-only otherwise.
  let type: DepositType;
  if (passport) type = "passport";
  else if (idCard) type = "id";
  else if (license) type = "license";
  else if (amount != null) type = "cash";
  else type = "other";

  return { type, amount, currency };
}
