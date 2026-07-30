"use client";

// The shop's WhatsApp profile picture - for the length of ONE search, and no
// longer.
//
// Deliberately not persisted anywhere: no table, no column, no database write.
// It belongs to a shop owner who never signed up for this app.
//
// WHY THIS IS AN <img> AND NOTHING ELSE.
//
// It used to be a two-phase negotiation: fetch JSON to learn the picture's URL,
// wait, put that URL in an <img>, wait again. Two sequential round-trips per
// shop, fifteen shops on a board, none of them started until React had mounted
// and run an effect - and the answer was `no-store`, so scrolling a card out and
// back did the whole dance again. That is the entire "the pictures never load"
// report: not a lookup that failed, a lookup that was too slow and too repeated
// to ever be seen.
//
// The route already proxies the bytes (`?img=1`), so the URL is knowable without
// asking. Pointing the tag straight at it collapses two hops into one, starts
// every avatar on the board in parallel the instant it renders, and hands the
// caching to the browser, which is much better at it than we are.
//
// The initial sits UNDERNEATH as the box's own background rather than as a
// separate state. There is no empty frame, no flash and no layout shift: the
// picture simply covers the letter when it arrives, and if it never arrives the
// letter was already the right answer.

import { useState } from "react";

// A FAILED FETCH IS NOT "THIS SHOP HAS NO LOGO" - AND NEITHER IS "ASKED TOO
// EARLY".
//
// Qui Motorbike Rental had a photo in WhatsApp and a grey initial in the app,
// permanently, because three verdicts compounded:
//
//   1. The card asked BEFORE the shop was messaged, the route answered
//      "unowned", and the <img> onError latched a `broken` React state with no
//      reset path - the memoized card never remounted, so the ONE ask happened
//      at the one moment it could not succeed.
//   2. Two strikes pushed the number into a module-level `missing` set with no
//      expiry, shared by every mount site: a bad minute became a
//      session-permanent verdict.
//   3. Nothing ever changed the <img> identity, so even a re-render reused the
//      browser's cached failure.
//
// The fix is a RETRY TOKEN + EXPIRING MEMORY: the caller passes `retryKey`
// (derived from the vendor's stage), so the img identity - and the latched
// `broken` state - change exactly when ownership becomes provable (queued ->
// messaged -> replied). Negative memory expires (MISSING_TTL_MS) instead of
// lasting the session. And when WhatsApp has nothing, the shop's own Google
// Places photo (already public, already fetched for the card) fills the box.
const MISSING_TTL_MS = 90_000;

/** number -> when it answered "no picture"; entries expire, they never latch. */
const missing = new Map<string, number>();

function isMissing(digits: string): boolean {
  const at = missing.get(digits);
  if (at == null) return false;
  if (Date.now() - at > MISSING_TTL_MS) {
    missing.delete(digits);
    return false;
  }
  return true;
}

/** Purge every cached avatar. Called on new-search and on session reset. */
export function clearShopAvatars(): void {
  missing.clear();
}

const SIZES: Record<"sm" | "md", string> = {
  sm: "h-6 w-6 text-[10px]",
  md: "h-8 w-8 text-[12px]",
};

export function ShopAvatar({
  name,
  phone,
  size = "md",
  retryKey,
  photoUrl,
}: {
  name: string;
  /** Only a shop we have actually messaged resolves - the route enforces it. */
  phone?: string | null;
  size?: "sm" | "md";
  /** Changes when the shop's thread state changes (e.g. the vendor stage) -
   * each change is one natural re-ask, timed to when ownership becomes
   * provable. Optional: without it behavior matches the old single-ask. */
  retryKey?: string | number;
  /** The shop's public Google Places photo (already proxied for the card) -
   * shown when WhatsApp has no picture for us. Memory-only, like the rest. */
  photoUrl?: string | null;
}) {
  const digits = (phone ?? "").replace(/\D/g, "");
  const askKey = `${digits}|${retryKey ?? ""}`;
  // `broken` is keyed: a failure latches THIS askKey only, so a stage change
  // (new retryKey) automatically un-latches without any effect or remount.
  const [brokenKey, setBrokenKey] = useState<string | null>(null);

  const initial = (name || "?").trim().charAt(0).toUpperCase() || "?";
  const showWa = Boolean(digits) && brokenKey !== askKey && !isMissing(digits);
  const showPlaces = !showWa && Boolean(photoUrl);

  return (
    <span
      aria-hidden
      className={`${SIZES[size]} relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-brandblue-soft font-extrabold text-brandblue`}
    >
      {initial}
      {showPlaces && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={photoUrl as string}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
      {showWa && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          // The retry token rides the URL, so a stage change is a NEW image
          // identity: the browser re-asks instead of replaying a cached miss.
          src={`/api/wa/avatar?img=1&number=${encodeURIComponent(digits)}${
            retryKey != null ? `&r=${encodeURIComponent(String(retryKey))}` : ""
          }`}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => {
            // Remember the miss BRIEFLY - long enough that a board of cards
            // stops hammering, short enough that a shop whose photo exists is
            // re-asked within a couple of minutes. Never a permanent verdict.
            missing.set(digits, Date.now());
            setBrokenKey(askKey);
          }}
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
    </span>
  );
}
