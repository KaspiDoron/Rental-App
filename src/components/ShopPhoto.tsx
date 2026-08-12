"use client";

// A shop photo that fails HONESTLY.
//
// Google Place Photos is a separately-billed SKU that can stop serving while
// search keeps working. When it did, every card rendered the browser's broken
// image glyph - a grey "?" box that reads as "this app is broken" rather than
// "this photo did not load". The rest of the card was fine and the shop was
// perfectly bookable.
//
// So: keep the exact same footprint, and on failure show a calm branded panel
// instead. The photo is decoration; nothing about finding or negotiating a
// rental depends on it, and the layout must not shift when it is missing.

import { useState } from "react";

export function ShopPhoto({
  src,
  className = "",
  /** Shown inside the fallback panel - keeps the card feeling authored. */
  label,
}: {
  src?: string | null;
  className?: string;
  label?: string;
}) {
  const [broken, setBroken] = useState(false);
  // NOTHING WAS ON SCREEN UNTIL THE LAST BYTE ARRIVED (W-8).
  //
  // A bare lazy <img> paints nothing while it loads, so a results page showed a
  // grid of empty holes that filled in at random - which reads as slower than
  // it is, and shifts attention every time one lands. The card keeps its exact
  // footprint and holds a calm shimmer until the image decodes.
  const [loaded, setLoaded] = useState(false);

  if (!src || broken) {
    return (
      <div
        aria-hidden
        className={`flex flex-col items-center justify-center gap-1 bg-card2 text-faint ${className}`}
      >
        <span className="text-[18px] opacity-40">🖼</span>
        {label ? <span className="px-3 text-center text-[10px] font-bold">{label}</span> : null}
      </div>
    );
  }
  return (
    <span className={`relative block overflow-hidden ${className}`}>
      {!loaded && (
        <span
          aria-hidden
          className="absolute inset-0 animate-pulse bg-card2"
          data-testid="shop-photo-placeholder"
        />
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setBroken(true)}
        onLoad={() => setLoaded(true)}
        className={`h-full w-full object-cover transition-opacity duration-300 ${
          loaded ? "opacity-100" : "opacity-0"
        }`}
      />
    </span>
  );
}
