"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";

interface FaqItem {
  id: string;
  q: string;
  a: string;
}

// Popular questions, shown to travellers as an expandable accordion. Content is
// managed (and AI-written) by the owner in Admin; this just reads it.
export function FaqSection() {
  const { t } = useI18n();
  const [items, setItems] = useState<FaqItem[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/faq")
      .then((r) => r.json())
      .then((d) => setItems(d.items ?? []))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  if (!loaded || items.length === 0) return null;

  return (
    <section className="mt-4">
      <h2 className="mb-2 px-1 text-[14px] font-extrabold text-strong">
        💬 {t("Popular questions")}
      </h2>
      <div className="space-y-1.5">
        {items.map((it) => {
          const isOpen = open === it.id;
          return (
            <div key={it.id} className="surface overflow-hidden rounded-2xl">
              <button
                onClick={() => setOpen(isOpen ? null : it.id)}
                className="flex w-full items-center gap-2 p-3 text-left"
                aria-expanded={isOpen}
              >
                <span className="text-[11px] text-faint">{isOpen ? "▼" : "▶"}</span>
                <span className="flex-1 text-[13px] font-bold text-strong">{t(it.q)}</span>
              </button>
              {isOpen && (
                <p className="border-t border-line px-3 py-2.5 text-[12px] leading-relaxed text-soft">
                  {t(it.a)}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
