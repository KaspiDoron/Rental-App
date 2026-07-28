// Structured deposit parsing - turns a shop's free-text deposit label (e.g.
// "3,000 THB cash", "Passport only", "Passport or 2000 baht", "No deposit")
// into a normalized { type, amount, currency } so the app can show a precise
// tag next to the price and filter by deposit kind. Pure + dependency-free, so
// it is fully unit-testable and safe to import anywhere (no server-only).

export type DepositType = "cash" | "passport" | "id" | "license" | "other" | "none";

/**
 * A DEPOSIT IS A SET OF ALTERNATIVES, EACH A BUNDLE.
 *
 * The single `type` enum below could only ever say one thing, so a real shop
 * line - "Deposits (2 options): 1) Original passport  2) Copy of passport +
 * 3000 THB" - collapsed to `passport` and rendered as "Passport or ฿3,000",
 * which is a DIFFERENT and cheaper-sounding offer than the one the shop made.
 * Two structures were missing:
 *
 *   - OR between options   ("original passport" OR "copy + cash")
 *   - AND inside an option ("copy of passport" AND "3000 THB")
 *
 * and one distinction: handing over your ORIGINAL passport (the shop keeps your
 * only travel document) is a materially different risk from leaving a PHOTOCOPY
 * plus cash. Flattening those into one word is what made the app unable to tell
 * a traveller what they were actually agreeing to.
 */
export type DepositPartKind =
  | "cash"
  | "passport_original"
  | "passport_copy"
  | "id"
  | "license";

export interface DepositPart {
  kind: DepositPartKind;
  amount?: number;
  currency?: string;
}

/** One way to satisfy the deposit. All parts are required together. */
export interface DepositOption {
  parts: DepositPart[];
}

export interface ParsedDeposit {
  /** Legacy single-value view, derived from the first option. Kept because
   *  offers store it as JSON and every existing filter/tag reads it. */
  type: DepositType;
  amount?: number; // cash figure when one was stated
  currency?: string; // currency of amount (from the label, else the fallback)
  /** The full structure. Empty for `none`. */
  options: DepositOption[];
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

const NUM = String.raw`\d[\d.,\s]*\d|\d`;
// A currency token on either side of the number is what makes it MONEY. Without
// this, "(2 Options)" parsed as a 2-baht deposit: the old rule took the first
// number in the label, whatever it was counting.
const CUR_TOKEN = String.raw`฿|₫|₱|₹|€|£|\$|thb|baht|idr|rp|rupiah|vnd|dong|php|peso|inr|rupees?|myr|rm|ringgit|eur|euros?|gbp|pounds?|usd|dollars?`;
const MONEY = new RegExp(
  `(?:(?:${CUR_TOKEN})\\s*(${NUM}))|(?:(${NUM})\\s*(?:${CUR_TOKEN}))`,
  "i"
);

function digitsToNumber(raw: string): number | undefined {
  let digits = raw.replace(/[\s,]/g, "");
  // A single dot with exactly 3 trailing digits is a thousands separator
  // ("3.000"); anything else stays as typed.
  if (/^\d+\.\d{3}$/.test(digits)) digits = digits.replace(".", "");
  const n = Number(digits);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

// Pull a plausible money amount out of a label. Handles thousands separators
// ("3,000" / "3.000" / "3 000") and plain numbers ("2000").
//
// A number that carries a currency token always wins. A bare number is accepted
// only as a fallback AND only when it is big enough to be a deposit - a shop
// never holds "2" of anything, but it does write "2 options" and "2 days".
function amountInText(s: string): number | undefined {
  const money = s.match(MONEY);
  if (money) {
    const n = digitsToNumber(money[1] ?? money[2] ?? "");
    if (n != null) return n;
  }
  const MIN_BARE_DEPOSIT = 100;
  for (const m of s.matchAll(new RegExp(NUM, "g"))) {
    const n = digitsToNumber(m[0]);
    if (n != null && n >= MIN_BARE_DEPOSIT) return n;
  }
  return undefined;
}

/** "A or B", "1) A 2) B", "A / B" -> the alternatives. Numbered lists win when
 *  present, because a shop that numbers its options often also writes "or"
 *  INSIDE one of them ("2) Or Copy Passport + 3000"). */
function splitAlternatives(s: string): string[] {
  const numbered = s.split(/(?:^|[\s(])\d\s*[).]\s*/).filter((p) => p.trim());
  if (numbered.length > 1) return numbered;
  const ored = s.split(/\s*(?:\bor\b|\/)\s*/i).filter((p) => p.trim());
  return ored.length > 1 ? ored : [s];
}

/** Parts required TOGETHER within one option: "copy of passport + 3000 THB". */
function splitConjuncts(s: string): string[] {
  return s.split(/\s*(?:\+|&|\band\b|\bplus\b|\bwith\b)\s*/i).filter((p) => p.trim());
}

const PASSPORT_COPY =
  /\b(copy|photocopy|photo|picture|scan|xerox)\b[^.!?]{0,20}\bpassports?\b|\bpassports?\b[^.!?]{0,20}\b(copy|photocopy|photo|picture|scan)\b/i;

function partsIn(clause: string, fallbackCurrency?: string): DepositPart[] {
  const parts: DepositPart[] = [];
  if (/passport/i.test(clause)) {
    parts.push({ kind: PASSPORT_COPY.test(clause) ? "passport_copy" : "passport_original" });
  }
  if (/\bid card\b|national id|\bktp\b|identity card/i.test(clause)) parts.push({ kind: "id" });
  if (/licen[cs]e|driving licen|driver'?s? licen/i.test(clause)) parts.push({ kind: "license" });
  const amount = amountInText(clause);
  if (amount != null) {
    parts.push({ kind: "cash", amount, currency: currencyInText(clause) ?? fallbackCurrency });
  } else if (/\bcash\b|\bmoney\b/i.test(clause)) {
    parts.push({ kind: "cash" });
  }
  return parts;
}

/** The legacy single-value view, so every existing filter, tag and stored offer
 *  keeps working unchanged. A document outranks cash because it is the harder
 *  ask - that was the old rule and it stays the old rule. */
function legacyType(parts: DepositPart[]): DepositType {
  if (parts.some((p) => p.kind === "passport_original" || p.kind === "passport_copy"))
    return "passport";
  if (parts.some((p) => p.kind === "id")) return "id";
  if (parts.some((p) => p.kind === "license")) return "license";
  if (parts.some((p) => p.kind === "cash")) return "cash";
  return "other";
}

/**
 * Parse a shop's deposit label. Returns null when the label is empty (the shop
 * never stated a deposit - we must not invent one).
 *
 * The result carries the FULL structure (`options`, each with its `parts`) plus
 * the flattened legacy fields taken from the first option.
 */
export function parseDeposit(raw?: string | null, fallbackCurrency?: string): ParsedDeposit | null {
  const s = (raw ?? "").trim();
  if (!s) return null;

  if (/\b(no deposit|deposit[-\s]?free|without (a )?deposit|no need (for )?(a )?deposit|zero deposit)\b/i.test(s)) {
    return { type: "none", options: [] };
  }

  const options: DepositOption[] = [];
  for (const alt of splitAlternatives(s)) {
    const parts: DepositPart[] = [];
    for (const conjunct of splitConjuncts(alt)) parts.push(...partsIn(conjunct, fallbackCurrency));
    // A conjunct split can strand a bare amount ("passport + 3000" where 3000
    // has no currency word of its own) - re-read the whole alternative if the
    // pieces found nothing.
    if (!parts.length) parts.push(...partsIn(alt, fallbackCurrency));
    if (parts.length) options.push({ parts: dedupeParts(parts) });
  }

  if (!options.length) {
    const amount = amountInText(s);
    return {
      type: amount != null ? "cash" : "other",
      amount,
      currency: amount != null ? currencyInText(s) ?? fallbackCurrency : undefined,
      options: amount != null ? [{ parts: [{ kind: "cash", amount, currency: currencyInText(s) ?? fallbackCurrency }] }] : [],
    };
  }

  const first = options[0].parts;
  const cash = first.find((p) => p.kind === "cash");
  // The legacy `amount` is what a filter compares against, so it must be the
  // cheapest cash figure the traveller could actually pay - not whichever
  // option happened to be written first.
  const cheapest = options
    .map((o) => o.parts.find((p) => p.kind === "cash")?.amount)
    .filter((n): n is number => typeof n === "number")
    .sort((a, b) => a - b)[0];

  return {
    type: legacyType(first),
    amount: cheapest ?? cash?.amount,
    currency: cash?.currency ?? currencyInText(s) ?? (cheapest != null ? fallbackCurrency : undefined),
    options,
  };
}

function dedupeParts(parts: DepositPart[]): DepositPart[] {
  const seen = new Set<string>();
  const out: DepositPart[] = [];
  for (const p of parts) {
    // An amount-bearing cash part supersedes a bare "cash" mention.
    const key = p.kind;
    const prior = out.findIndex((q) => q.kind === key);
    if (prior >= 0) {
      if (p.kind === "cash" && p.amount != null && out[prior].amount == null) out[prior] = p;
      continue;
    }
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** Human-readable label for one part, in the app's own voice. */
export function describePart(part: DepositPart, money?: (amount: number, currency?: string) => string): string {
  switch (part.kind) {
    case "passport_original":
      return "Original passport";
    case "passport_copy":
      return "Passport copy";
    case "id":
      return "ID card";
    case "license":
      return "Licence";
    case "cash":
      return part.amount != null
        ? money
          ? money(part.amount, part.currency)
          : `${part.amount}${part.currency ? " " + part.currency : ""}`
        : "Cash";
  }
}
