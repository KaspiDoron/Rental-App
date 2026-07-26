"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { lockBodyScroll } from "@/lib/scroll-lock";

// Full-screen swipeable photo carousel (Google Maps place photos). Snap
// scrolling + arrows + a live counter, and it silently drops any photo that
// fails to load so the user never gets stuck on a broken first image.
export function PhotoGallery({
  name,
  photos,
  onClose,
}: {
  name: string;
  photos: string[];
  onClose: () => void;
}) {
  const [ok, setOk] = useState<boolean[]>(() => photos.map(() => true));
  const [idx, setIdx] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const unlock = lockBodyScroll();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      unlock();
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = photos.filter((_, i) => ok[i]);

  function go(dir: number) {
    const track = trackRef.current;
    if (!track) return;
    const next = Math.max(0, Math.min(visible.length - 1, idx + dir));
    setIdx(next);
    track.scrollTo({ left: next * track.clientWidth, behavior: "smooth" });
  }

  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[1300] flex flex-col bg-black/90 backdrop-blur-sm pop-in">
      <div className="flex items-center justify-between px-4 pt-safe">
        <span className="truncate py-3 text-[13px] font-extrabold text-white">
          {name} · {visible.length} photos
        </span>
        <button
          onClick={onClose}
          aria-label="Close"
          className="btn btn-sm rounded-xl bg-white/15 px-3 text-white"
        >
          ✕
        </button>
      </div>

      {/* EVERY photo failed. Google Place Photos is its own billed SKU and can
          stop serving while search keeps working, and a black void with no
          words reads as a broken app rather than a missing decoration. */}
      {visible.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
          <span className="text-3xl opacity-50">🖼</span>
          <p className="text-[13px] font-extrabold text-white/90">
            Photos are not loading right now
          </p>
          <p className="max-w-[16rem] text-[11px] text-white/60">
            This is only the pictures - the shop, its rating and your negotiation
            are all unaffected.
          </p>
        </div>
      ) : (
      <div className="relative flex flex-1 items-center">
        <div
          ref={trackRef}
          onScroll={(e) => {
            const w = e.currentTarget.clientWidth || 1;
            setIdx(Math.round(e.currentTarget.scrollLeft / w));
          }}
          className="no-scrollbar flex h-full w-full snap-x snap-mandatory overflow-x-auto"
        >
          {photos.map((u, i) =>
            ok[i] ? (
              <div key={i} className="flex h-full w-full shrink-0 snap-center items-center justify-center p-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={u}
                  alt=""
                  loading={i === 0 ? "eager" : "lazy"}
                  decoding="async"
                  className="max-h-full max-w-full rounded-2xl object-contain"
                  onError={() => setOk((prev) => prev.map((v, j) => (j === i ? false : v)))}
                />
              </div>
            ) : null
          )}
        </div>

        {visible.length > 1 && (
          <>
            <button
              onClick={() => go(-1)}
              aria-label="Previous"
              className="btn absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-white/20 px-3 py-2 text-lg font-extrabold text-white"
            >
              ‹
            </button>
            <button
              onClick={() => go(1)}
              aria-label="Next"
              className="btn absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-white/20 px-3 py-2 text-lg font-extrabold text-white"
            >
              ›
            </button>
          </>
        )}
      </div>
      )}

      {visible.length > 1 && (
        <div className="flex items-center justify-center gap-1.5 pb-safe pt-2">
          {visible.map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full transition-all ${
                i === idx ? "w-5 bg-white" : "w-1.5 bg-white/40"
              }`}
            />
          ))}
        </div>
      )}
    </div>,
    document.body
  );
}
