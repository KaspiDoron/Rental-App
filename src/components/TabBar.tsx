"use client";

import { Icon } from "./icons";

type Tab = "home" | "map" | "account";

export function TabBar({
  active,
  onSelect,
  onFeedback,
}: {
  active: Tab;
  onSelect: (t: Tab) => void;
  onFeedback: () => void;
}) {
  const item = (tab: Tab, icon: string, label: string) => {
    const on = active === tab;
    return (
      <button
        onClick={() => onSelect(tab)}
        className={`flex w-16 flex-col items-center gap-0.5 py-1 transition ${
          on ? "text-savings-bright" : "text-slate-500"
        }`}
      >
        <Icon name={icon} className="h-[22px] w-[22px]" />
        <span className="text-[10px] font-medium">{label}</span>
      </button>
    );
  };

  return (
    <nav className="tabbar fixed inset-x-0 bottom-0 z-40 pb-safe">
      <div className="mx-auto flex max-w-md items-center justify-between px-6 pt-2">
        {item("home", "home", "Search")}
        {item("map", "map", "Map")}
        <button
          onClick={onFeedback}
          aria-label="Send feedback"
          className="btn-primary -mt-7 flex h-14 w-14 items-center justify-center rounded-full brand-ring"
        >
          <Icon name="chat" className="h-6 w-6" />
        </button>
        {item("account", "user", "Account")}
        <div className="w-16 text-center">
          <button
            onClick={onFeedback}
            className="flex w-16 flex-col items-center gap-0.5 py-1 text-slate-500"
          >
            <Icon name="spark" className="h-[22px] w-[22px]" />
            <span className="text-[10px] font-medium">Feedback</span>
          </button>
        </div>
      </div>
    </nav>
  );
}
