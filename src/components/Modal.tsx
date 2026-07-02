"use client";

import { useEffect } from "react";

// Shared popup shell: blurred backdrop, tap-outside-to-close (every popup in
// the app must close on backdrop tap), Escape support, body scroll lock.
export function Modal({
  onClose,
  children,
  center = false,
}: {
  onClose: () => void;
  children: React.ReactNode;
  center?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      className={`fixed inset-0 z-[1200] flex justify-center bg-black/45 backdrop-blur-sm ${
        center ? "items-center px-4" : "items-end sm:items-center sm:px-4"
      }`}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`surface-strong max-h-[92dvh] w-full max-w-md overflow-y-auto p-5 pb-safe animate-slide-up ${
          center ? "rounded-blob" : "rounded-t-3xl sm:rounded-blob"
        }`}
      >
        {children}
      </div>
    </div>
  );
}
