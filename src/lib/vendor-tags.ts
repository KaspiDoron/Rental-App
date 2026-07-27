// Verified reply-based shop tags (item #13). When a shop replies, the
// extraction agent also reads FACTS the shop explicitly stated (delivery,
// deposit policy, helmets, insurance, ...). Each fact is stored as a SIGNAL
// tied to that exact reply; a tag is only shown to travellers once the same
// shop confirmed it in AT LEAST TWO different replies - one message is never
// enough to promote a claim into a badge.

import "server-only";
import { createHash } from "crypto";
import { sbSelect, sbInsert } from "./runtime-config";
import { claimsIn } from "./thread/claims";
import { CLASS_PROFILES, mentionsClass } from "./vehicle/class-profile";
import type { ExtractedOffer } from "./agents";

// The full vocabulary. Anything outside it is dropped - the AI can never
// invent a new badge.
export const VENDOR_TAG_VOCAB = [
  "delivery",
  "pickup-only",
  "airport-delivery",
  "no-deposit",
  "passport-deposit",
  "cash-deposit",
  "helmets-included",
  "insurance-included",
  "cards-accepted",
  "flexible-dates",
  // "This place definitely rents cars." Earned from what the shop actually
  // says - a car quoted, a car named, a car board - never from the fact that we
  // ran a car search. Discovery stamps `vehicleClasses` from the QUERY, so a
  // filter built on that would just re-show every result.
  "rents-cars",
] as const;
export type VendorTag = (typeof VENDOR_TAG_VOCAB)[number];

const CONFIRMATIONS_NEEDED = 2; // distinct replies before a tag is shown

/**
 * Derive tag signals from one extraction + raw reply. Only explicit facts:
 * structured fields first (language-independent - the LLM read the reply),
 * then the constrained tags array the extractor returned.
 */
export function tagsFromExtraction(extraction: ExtractedOffer, replyText: string): VendorTag[] {
  const tags = new Set<VendorTag>();
  for (const raw of extraction.tags ?? []) {
    const t = String(raw).toLowerCase().trim() as VendorTag;
    if ((VENDOR_TAG_VOCAB as readonly string[]).includes(t)) tags.add(t);
  }
  if (extraction.delivers === true) tags.add("delivery");
  if (extraction.delivers === false) tags.add("pickup-only");

  // DEPOSIT TERMS COME FROM A TYPED CLAIM, WITH POLARITY.
  //
  // This used to be a cue match with an `else`: if the text did not literally
  // contain "no deposit", any mention of "passport" fell through to
  // `passport-deposit`. So "we don't take a deposit, just your passport at
  // pickup" - the friendliest terms in the thread - was badged as REQUIRING a
  // passport deposit. The opposite of what the shop said.
  //
  // A claim carries whether it was affirmed or denied, and the negation is
  // scoped to its clause, so the denial attaches to the deposit and the passport
  // stands on its own instead of being swallowed by an else.
  //
  // A DEPOSIT CAN HAVE MORE THAN ONE COMPONENT. "3,000 baht cash and a copy of
  // your passport" is two requirements, and reading only the first one badged
  // the shop as cash-only - so a traveller filtering for "cash deposit"
  // (meaning "I would rather pay than hand over my passport") was shown shops
  // that want both. Every component the claim carries earns its own tag.
  //
  // A shop QUESTION is not terms: "how much deposit can you leave?" states
  // nothing and must never become a badge.
  const depositText = [extraction.deposit ?? "", replyText].filter(Boolean).join(". ");
  const depositClaims = claimsIn(depositText, "shop", 0).filter(
    (c) => c.subject === "deposit" && c.force !== "ask"
  );
  const denied = depositClaims.some((c) => c.polarity === "denied");
  const affirmed = depositClaims.filter((c) => c.polarity === "affirmed");
  if (denied && affirmed.length === 0) tags.add("no-deposit");
  for (const c of affirmed) {
    for (const detail of c.details) {
      if (detail === "passport" || detail === "id" || detail === "licence") {
        tags.add("passport-deposit");
      }
      if (detail === "cash") tags.add("cash-deposit");
    }
  }
  // DOES THIS SHOP ACTUALLY RENT CARS? Evidence from the shop's own words: it
  // named a car or a car nameplate in a reply. Like every other tag here it
  // needs two distinct replies before it is shown, so one ambiguous "car" does
  // not earn a badge.
  const carEvidence = [replyText, String(extraction.vehicleDescription ?? "")].some((t) =>
    mentionsClass(t, CLASS_PROFILES.car)
  );
  if (carEvidence) tags.add("rents-cars");

  // English-only safety net for the most common freebie mentions.
  if (/\b(helmets? (are |is )?(free|included)|free helmets?|includes? helmets?|2 helmets)\b/i.test(replyText)) {
    tags.add("helmets-included");
  }
  // Contradictions within ONE reply cancel each other - never trust either.
  if (tags.has("delivery") && tags.has("pickup-only")) {
    tags.delete("delivery");
    tags.delete("pickup-only");
  }
  if (tags.has("no-deposit") && (tags.has("passport-deposit") || tags.has("cash-deposit"))) {
    tags.delete("no-deposit");
  }
  return [...tags];
}

/**
 * Store this reply's tag signals. The reply hash makes re-processing the same
 * message idempotent: one reply can confirm each tag at most once.
 */
export async function recordTagSignals(
  vendorId: string,
  userEmail: string | undefined,
  replyText: string,
  tags: VendorTag[]
): Promise<void> {
  if (!vendorId || tags.length === 0) return;
  const hash = createHash("sha1").update(replyText.trim()).digest("hex").slice(0, 16);
  const existing = await sbSelect<{ tag: string }>(
    "vendor_tag_signals",
    `select=tag&vendor_id=eq.${encodeURIComponent(vendorId)}&reply_hash=eq.${hash}&limit=${
      VENDOR_TAG_VOCAB.length
    }`
  ).catch(() => []);
  const seen = new Set(existing.map((r) => r.tag));
  const rows = tags
    .filter((t) => !seen.has(t))
    .map((tag) => ({
      vendor_id: vendorId,
      tag,
      user_email: userEmail ?? null,
      reply_hash: hash,
    }));
  if (rows.length) await sbInsert("vendor_tag_signals", rows).catch(() => {});
}

/**
 * The VERIFIED tags per shop: confirmed in >= 2 distinct replies. Conflicting
 * verified claims (delivery vs pickup-only, no-deposit vs a deposit) resolve
 * by majority; a tie shows neither - honesty beats decoration.
 */
export async function verifiedTagsFor(
  vendorIds: string[]
): Promise<Record<string, VendorTag[]>> {
  const ids = vendorIds.filter(Boolean).slice(0, 40);
  if (!ids.length) return {};
  const rows = await sbSelect<{ vendor_id: string; tag: string; reply_hash: string | null }>(
    "vendor_tag_signals",
    `select=vendor_id,tag,reply_hash&vendor_id=in.(${ids
      .map((i) => `"${i.replace(/"/g, "")}"`)
      .join(",")})&limit=1000`
  ).catch(() => []);

  // (vendor, tag) -> distinct reply hashes
  const counts = new Map<string, Map<string, Set<string>>>();
  for (const r of rows) {
    if (!(VENDOR_TAG_VOCAB as readonly string[]).includes(r.tag)) continue;
    const byTag = counts.get(r.vendor_id) ?? new Map<string, Set<string>>();
    const hashes = byTag.get(r.tag) ?? new Set<string>();
    hashes.add(r.reply_hash ?? `row-${Math.random()}`);
    byTag.set(r.tag, hashes);
    counts.set(r.vendor_id, byTag);
  }

  const out: Record<string, VendorTag[]> = {};
  for (const [vendorId, byTag] of counts) {
    const n = (t: string) => byTag.get(t)?.size ?? 0;
    const verified = new Set<VendorTag>();
    for (const [tag, hashes] of byTag) {
      if (hashes.size >= CONFIRMATIONS_NEEDED) verified.add(tag as VendorTag);
    }
    // Majority wins between contradicting verified claims; ties show neither.
    if (verified.has("delivery") && verified.has("pickup-only")) {
      if (n("delivery") > n("pickup-only")) verified.delete("pickup-only");
      else if (n("pickup-only") > n("delivery")) verified.delete("delivery");
      else {
        verified.delete("delivery");
        verified.delete("pickup-only");
      }
    }
    if (verified.has("no-deposit") && (verified.has("passport-deposit") || verified.has("cash-deposit"))) {
      const depositN = Math.max(n("passport-deposit"), n("cash-deposit"));
      if (n("no-deposit") > depositN) {
        verified.delete("passport-deposit");
        verified.delete("cash-deposit");
      } else if (depositN > n("no-deposit")) verified.delete("no-deposit");
      else {
        verified.delete("no-deposit");
        verified.delete("passport-deposit");
        verified.delete("cash-deposit");
      }
    }
    if (verified.size) out[vendorId] = [...verified];
  }
  return out;
}
