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

// A FAILED FETCH IS NOT "THIS SHOP HAS NO LOGO".
//
// This Set used to be filled by ANY <img> error, and it is module-level, so one
// transient failure - an Evolution timeout, a 429 while ten cards mounted at
// once, a 401 in the instant before the session cookie settled - retired that
// shop to a grey initial for the rest of the session, permanently and
// invisibly. That is exactly the reported split: some shops show a logo, some
// never do, and which is which is decided by whichever request happened to lose
// a race.
//
// The route now says WHICH it was (see api/wa/avatar): a shop with genuinely no
// picture answers 404 with `x-avatar: none`, and everything else is a transient
// failure that must be retried. `onError` cannot read headers, so the component
// asks once - a HEAD-shaped probe is not worth it - and instead treats an error
// as retryable up to a small cap, which converges on the truth without ever
// making a permanent negative out of a bad minute.
const RETRY_LIMIT = 2;

/** Numbers that answered "no picture" - a re-render for these is free. */
const missing = new Set<string>();
/** Transient failures per number, so a bad minute is not a permanent verdict. */
const failures = new Map<string, number>();

/** Purge every cached avatar. Called on new-search and on session reset. */
export function clearShopAvatars(): void {
  missing.clear();
  failures.clear();
}

const SIZES: Record<"sm" | "md", string> = {
  sm: "h-6 w-6 text-[10px]",
  md: "h-8 w-8 text-[12px]",
};

export function ShopAvatar({
  name,
  phone,
  size = "md",
}: {
  name: string;
  /** Only a shop we have actually messaged resolves - the route enforces it. */
  phone?: string | null;
  size?: "sm" | "md";
}) {
  const digits = (phone ?? "").replace(/\D/g, "");
  const [broken, setBroken] = useState(false);

  const initial = (name || "?").trim().charAt(0).toUpperCase() || "?";
  const showImage = Boolean(digits) && !broken && !missing.has(digits);

  return (
    <span
      aria-hidden
      className={`${SIZES[size]} relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-brandblue-soft font-extrabold text-brandblue`}
    >
      {initial}
      {showImage && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/wa/avatar?img=1&number=${encodeURIComponent(digits)}`}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => {
            // Count it. Only a shop that fails repeatedly is written off; a
            // single failure leaves the next render free to try again, which is
            // what turns a timeout back into a logo instead of into an initial
            // that never recovers.
            const seen = (failures.get(digits) ?? 0) + 1;
            failures.set(digits, seen);
            if (seen >= RETRY_LIMIT) missing.add(digits);
            setBroken(true);
          }}
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
    </span>
  );
}
