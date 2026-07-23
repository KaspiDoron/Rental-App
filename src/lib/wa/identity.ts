// OUTREACH IDENTITY RESOLUTION (privacy keystone).
//
// A stored outbound row is what later makes an inbound reply attribute to a
// shop, so a phone number may ONLY wear a real shop's name+rfq if it is
// POSITIVELY the shop's own Google-listed phone. This pure decision is the
// single choke point that keeps a spoofed / unverifiable number from
// impersonating a real vendor (which once leaked a private chat onto a real
// Bali shop's card).
//
// The rule is deliberately narrow. Only a POSITIVE contradiction - we have the
// shop's Google phone AND the supplied number provably differs from it - (or an
// explicit owner test) re-keys to a test identity. The mere ABSENCE of a
// reference phone (Google Details 5xx/quota, a shop with no listed phone, or a
// trusted seed/partner vendor with no placeId) must NOT re-key a legit shop:
// doing so orphaned every real reply (it never bound back to the card).

export type OutreachIdentity =
  | { action: "keep" } // keep the real identity, send to the supplied number
  | { action: "send-to-shop"; toPhone: string } // real shop wins; send to its own number
  | { action: "rekey-test"; vendorId: string; vendorName: string }; // windowed test identity

export function resolveOutreachIdentity(opts: {
  claimsRealShop: boolean;
  resolvedPhone: string; // digits only, "" when unknown
  supplied: string; // digits only, "" when none
  // TRUE only when the OWNER is running a TEST/drill (global TEST_MODE on).
  // BUG 1B: this used to be a plain `isOwner`, so in PRODUCTION every real shop
  // the owner contacted was blanket-re-keyed to a "(unverified)" test identity -
  // the "(unverified)" suffix that appeared on every shop name + push. In
  // production (TEST_MODE off) the owner is a normal user and their real shops
  // keep their real identity; only an ACTUAL number mismatch re-keys.
  ownerTestMode: boolean;
  vendorName?: string;
}): OutreachIdentity {
  const { claimsRealShop, resolvedPhone, supplied, ownerTestMode } = opts;
  if (!claimsRealShop || !supplied) return { action: "keep" };

  const mismatch = Boolean(resolvedPhone && supplied && supplied !== resolvedPhone);
  if (mismatch && !ownerTestMode) {
    // Real shop, known Google phone, non-matching supplied number: the real
    // shop always wins - send to the shop's own number, keep its identity.
    return { action: "send-to-shop", toPhone: resolvedPhone };
  }
  if (mismatch || ownerTestMode) {
    // A contradiction we cannot override, or the owner explicitly TESTING (drill
    // mode) an arbitrary number: re-key to an explicit, WINDOWED test identity so
    // a spoofed / unverifiable number can never wear the real shop's name/rfq.
    return {
      action: "rekey-test",
      vendorId: `test-${supplied}`,
      vendorName: `${String(opts.vendorName ?? "Shop").slice(0, 56)} (unverified)`,
    };
  }
  // No reference phone to contradict the number - keep the real identity (the
  // number came from this shop's own discovery record).
  return { action: "keep" };
}
