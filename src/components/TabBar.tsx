"use client";

import { Icon } from "./icons";
import { useI18n } from "@/lib/i18n";
import { startNav } from "./NavVeil";
import { FixedLayer } from "./FixedLayer";

type Tab = "home" | "deals" | "profile" | "feedback";
type NavTab = Exclude<Tab, "feedback">;

// Global bottom navigation: 4 centred slots (the map lives inside the results
// view, not here). Navigating shows a slick loading veil.
export function TabBar({
  active,
  onSelect,
  onFeedback,
  onUpgrade,
  showUpgrade,
}: {
  active: NavTab;
  onSelect: (t: NavTab) => void;
  onFeedback: () => void;
  onUpgrade: () => void;
  showUpgrade: boolean;
}) {
  const { t } = useI18n();
  // "My deals" is retired (V2-5): its slot is now "Trips" - your locked
  // bookings + hand-offs. The route path stays /deals so middleware, Will
  // commands and the privacy source-scan test keep working; only the identity
  // and framing change.
  const items: { id: Tab; icon: string; label: string }[] = [
    { id: "home", icon: "bolt", label: t("Find deals") },
    { id: "deals", icon: "card", label: t("Trips") },
    { id: "profile", icon: "user", label: t("Profile") },
    { id: "feedback", icon: "chat", label: t("Feedback") },
  ];

  return (
    // Portalled to <body> and given its own compositing layer - see FixedLayer.
    // As a plain fixed child of <main> this bar rendered halfway up the screen
    // on iOS after an overlay had toggled the body's overflow.
    // The safe-area gap sits OUTSIDE the capsule so the glass floats above the
    // home indicator instead of swallowing it in padding.
    <FixedLayer className="fixed inset-x-0 bottom-0 z-50 pb-safe">
      {showUpgrade && (
        <div className="pointer-events-none mb-2 flex justify-center px-4">
          <button
            onClick={onUpgrade}
            className="btn btn-sm chip cta-sheen fluid-press pointer-events-auto flex items-center gap-1.5 rounded-full bg-brandblue px-4 py-2 text-[12px] font-extrabold text-white shadow-lg"
          >
            <Icon name="sparkles" className="h-3.5 w-3.5" /> {t("See Pro features")}
          </button>
        </div>
      )}
      <nav className="tabbar glass-rim">
        <div className="mx-auto grid max-w-md grid-cols-4 px-2 py-1.5">
          {items.map((it) => {
            const on = active === it.id;
            const isFeedback = it.id === "feedback";
            return (
              <button
                key={it.id}
                data-tour={it.id === "profile" ? "tab-profile" : undefined}
                aria-current={on ? "page" : undefined}
                aria-label={it.label}
                onClick={() => {
                  if (isFeedback) {
                    onFeedback();
                    return;
                  }
                  // Instant feedback on EVERY page change (global veil).
                  if (it.id !== active) startNav();
                  onSelect(it.id as NavTab);
                }}
                className="btn btn-sm fluid-press flex flex-col items-center justify-center gap-1 rounded-2xl py-1.5"
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
    </FixedLayer>
  );
}
