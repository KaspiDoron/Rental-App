// Pure VAPID key helpers (no "server-only" so vitest can import them).
//
// The owner operates without a terminal, so the app must be able to mint its
// own Web Push keypair instead of requiring `npx web-push generate-vapid-keys`.
// push.ts calls generateVapidPair() on first use and persists the pair into the
// encrypted Key Vault; vapidPairMatches() proves a stored public/private pair
// actually belong together (the private scalar re-derives the public point), so
// a lost write race between two serverless instances can never leave the app
// handing browsers a public key whose private key is different.

import webpush from "web-push";
import { createECDH } from "crypto";

export interface VapidPair {
  publicKey: string;
  privateKey: string;
}

/** Mint a fresh P-256 VAPID keypair (base64url, the wire format browsers use). */
export function generateVapidPair(): VapidPair {
  const { publicKey, privateKey } = webpush.generateVAPIDKeys();
  return { publicKey, privateKey };
}

/**
 * True only when `priv` is the private scalar for `pub`: re-derive the
 * uncompressed public point from the scalar and compare. Malformed or
 * mismatched input -> false, never a throw.
 */
export function vapidPairMatches(pub: string, priv: string): boolean {
  if (!pub || !priv) return false;
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(priv, "base64url"));
    return ecdh.getPublicKey("base64url") === pub;
  } catch {
    return false;
  }
}
