"use client";

// The shop's WhatsApp profile picture - for the length of ONE search, and no
// longer.
//
// Deliberately not persisted anywhere: the URL is fetched on demand, held in a
// module-level Map that `clearShopAvatars()` empties on every new search or
// reset, and never written to a database. It belongs to a shop owner who never
// signed up for this app.
//
// Falls back to the shop's initial the moment anything is missing - no picture,
// a dead URL, an image that fails to load. The avatar is a nicety; the card
// must never wait on it or shift when it arrives.

import { useEffect, useState } from "react";

const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

/** Purge every cached avatar. Called on new-search and on session reset. */
export function clearShopAvatars(): void {
  cache.clear();
  inflight.clear();
}

async function load(digits: string): Promise<string | null> {
  if (cache.has(digits)) return cache.get(digits) ?? null;
  const existing = inflight.get(digits);
  if (existing) return existing;
  const p = (async () => {
    try {
      const res = await fetch(`/api/wa/avatar?number=${encodeURIComponent(digits)}`, {
        cache: "no-store",
      });
      const d = await res.json();
      const url = typeof d?.url === "string" ? d.url : null;
      cache.set(digits, url);
      return url;
    } catch {
      cache.set(digits, null);
      return null;
    } finally {
      inflight.delete(digits);
    }
  })();
  inflight.set(digits, p);
  return p;
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
  const [url, setUrl] = useState<string | null>(() => cache.get(digits) ?? null);
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    if (!digits) return;
    let alive = true;
    load(digits).then((u) => {
      if (alive) setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, [digits]);

  const initial = (name || "?").trim().charAt(0).toUpperCase() || "?";
  const box = `${SIZES[size]} shrink-0 overflow-hidden rounded-full`;

  if (!url || broken) {
    return (
      <span
        aria-hidden
        className={`${box} flex items-center justify-center bg-brandblue-soft font-extrabold text-brandblue`}
      >
        {initial}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt=""
      aria-hidden
      onError={() => setBroken(true)}
      className={`${box} object-cover`}
      referrerPolicy="no-referrer"
    />
  );
}
