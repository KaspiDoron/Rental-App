"use client";

import { Icon } from "./icons";

type Tab = "home" | "map" | "profile";

// Global bottom navigation. Primary destination is Search ("Looking for...");
// feedback is a single small side action, never primary. The upgrade chip
// floats just above the bar.
export function TabBar({
  active,
  onSelect,
  onFeedback,
  onUpgrade,
  showUpgrade,
}: {
  active: Tab;
  onSelect: (t: Tab) => void;
  onFeedback: () => void;
  onUpgrade: () => void;
  showUpgrade: boolean;
}) {
  const item = (tab: Tab, icon: string, label: string, primary = false) => {
    const on = active === tab;
    return (
      <button
        onClick={() => onSelect(tab)}
        className={`btn btn-sm flex flex-1 flex-col items-center gap-0.5 rounded-xl py-1.5 ${
          on ? "text-brandblue" : "text-faint hover:text-soft"
        }`}
      >
        <span
          className={`flex items-center justify-center rounded-2xl transition ${
            primary
              ? `${on ? "bg-brandblue text-white" : "bg-brandblue-soft text-brandblue"} h-9 w-14`
              : "h-9 w-9"
          }`}
        >
          <Icon name={icon} className="h-[22px] w-[22px]" />
        </span>
        <span className={`text-[10px] font-bold ${on ? "text-brandblue" : ""}`}>{label}</span>
      </button>
    );
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-50">
      {showUpgrade && (
        <div className="pointer-events-none mb-2 flex justify-center px-4">
          <button
            onClick={onUpgrade}
            className="btn btn-sm chip pointer-events-auto flex items-center gap-1.5 rounded-full bg-brandyellow px-4 py-2 text-[12px] font-extrabold text-[#4a3300] shadow-lg animate-wiggle"
          >
            🎉 80% OFF launch - Upgrade
          </button>
        </div>
      )}
      <nav className="tabbar pb-safe">
        <div className="mx-auto flex max-w-md items-center gap-1 px-4 pt-1.5">
          {item("home", "bolt", "Looking for...", true)}
          {item("map", "map", "Map")}
          {item("profile", "user", "Profile")}
          <button
            onClick={onFeedback}
            aria-label="Send feedback"
            className="btn btn-sm flex w-12 flex-col items-center gap-0.5 rounded-xl py-1.5 text-faint hover:text-soft"
          >
            <span className="flex h-9 w-9 items-center justify-center">
              <Icon name="chat" className="h-[19px] w-[19px]" />
            </span>
            <span className="text-[9px] font-bold">Feedback</span>
          </button>
        </div>
      </nav>
    </div>
  );
}
