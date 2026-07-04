"use client";

import { useState } from "react";
import { Icon } from "./icons";
import { useI18n } from "@/lib/i18n";

type Tab = "home" | "profile" | "feedback";

// Global bottom navigation: 3 perfectly centred slots (the map lives inside
// the results view, not here). Navigating shows a slick loading veil.
export function TabBar({
  active,
  onSelect,
  onFeedback,
  onUpgrade,
  showUpgrade,
}: {
  active: Exclude<Tab, "feedback">;
  onSelect: (t: Exclude<Tab, "feedback">) => void;
  onFeedback: () => void;
  onUpgrade: () => void;
  showUpgrade: boolean;
}) {
  const { t } = useI18n();
  const [navving, setNavving] = useState(false);
  const items: { id: Tab; icon: string; label: string }[] = [
    { id: "home", icon: "bolt", label: t("Find deals") },
    { id: "profile", icon: "user", label: t("Profile") },
    { id: "feedback", icon: "chat", label: t("Feedback") },
  ];

  return (
    <div className="fixed inset-x-0 bottom-0 z-50">
      {/* Page-navigation veil: gray backdrop + high-tech spinner */}
      {navving && (
        <div className="fixed inset-0 z-[1400] flex items-center justify-center bg-black/35 backdrop-blur-[2px]">
          <span className="relative flex h-12 w-12 items-center justify-center">
            <span className="absolute inset-0 animate-spin rounded-full border-[3px] border-white/20 border-t-brandblue" />
            <span className="absolute inset-2 animate-spin rounded-full border-2 border-white/10 border-b-brandyellow [animation-direction:reverse]" />
          </span>
        </div>
      )}
      {showUpgrade && (
        <div className="pointer-events-none mb-2 flex justify-center px-4">
          <button
            onClick={onUpgrade}
            className="btn btn-sm chip pointer-events-auto flex items-center gap-1.5 rounded-full bg-brandyellow px-4 py-2 text-[12px] font-extrabold text-[#4a3300] shadow-lg animate-wiggle"
          >
            🎉 {t("80% OFF launch - Upgrade")}
          </button>
        </div>
      )}
      <nav className="tabbar pb-safe">
        <div className="mx-auto grid max-w-md grid-cols-3 px-2 pt-1.5">
          {items.map((it) => {
            const on = active === it.id;
            const isFeedback = it.id === "feedback";
            return (
              <button
                key={it.id}
                onClick={() => {
                  if (isFeedback) {
                    onFeedback();
                    return;
                  }
                  if (it.id === "profile" && active !== "profile") setNavving(true);
                  onSelect(it.id as Exclude<Tab, "feedback">);
                }}
                className="btn btn-sm flex flex-col items-center justify-center gap-1 rounded-2xl py-1.5"
              >
                <span
                  className={`flex h-8 w-14 items-center justify-center rounded-full transition-all duration-200 ${
                    on
                      ? "bg-brandblue text-white shadow-md"
                      : "text-faint hover:bg-card2 hover:text-soft"
                  }`}
                >
                  <Icon name={it.icon} className="h-[20px] w-[20px]" />
                </span>
                <span
                  className={`max-w-full truncate text-[10px] font-extrabold ${
                    on ? "text-brandblue" : "text-faint"
                  }`}
                >
                  {it.label}
                </span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
