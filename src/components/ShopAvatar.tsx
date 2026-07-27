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

/** Numbers we have already learned have no picture - so a re-render is free. */
const missing = new Set<string>();

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
            // A shop with no photo answers 404. Remember it, so every later
            // render of this shop skips the request entirely.
            missing.add(digits);
            setBroken(true);
          }}
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
    </span>
  );
}
