"use client";

// One consistent way to gate a feature by plan. Entitled -> children render
// untouched. Not entitled -> children render dimmed and inert under a lock
// chip that explains the feature and opens the upgrade sheet. This replaces
// the scattered inline `plan === "free"` checks so every locked feature
// looks, reads and upsells the same way.

import { can, FEATURE_META, planFor, type Feature } from "@/lib/entitlements";
import { Icon } from "./icons";
import { useI18n } from "@/lib/i18n";

export function PlanGate({
  plan,
  feature,
  onUpgrade,
  children,
  className = "",
}: {
  plan: string | undefined;
  feature: Feature;
  onUpgrade: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  const { t } = useI18n();
  if (can(plan, feature)) return <>{children}</>;

  const meta = FEATURE_META[feature];
  const target = planFor(feature);
  return (
    <div className={`relative ${className}`}>
      <div className="pointer-events-none select-none opacity-45" aria-hidden>
        {children}
      </div>
      <button
        type="button"
        onClick={onUpgrade}
        className="absolute inset-0 flex items-center justify-center rounded-blob"
        aria-label={`${t(meta.label)} - ${t(target === "ultra" ? "Ultra feature" : "Pro feature")}`}
      >
        <span className="surface-strong flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-extrabold text-strong shadow-lg">
          <Icon name="lock" className="h-3.5 w-3.5 text-brandblue" />
          {t(meta.label)}
          <span
            className={`rounded-full px-1.5 py-0.5 text-[9px] font-extrabold text-white ${
              target === "ultra" ? "badge-ultra" : "bg-brandblue"
            }`}
          >
            {target === "ultra" ? "Ultra" : "Pro"}
          </span>
        </span>
      </button>
    </div>
  );
}

/** Small inline lock chip for places where dimming a whole block is too much. */
export function PlanChip({
  feature,
  onUpgrade,
}: {
  feature: Feature;
  onUpgrade: () => void;
}) {
  const { t } = useI18n();
  const target = planFor(feature);
  return (
    <button
      type="button"
      onClick={onUpgrade}
      className="chip inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[10px] font-extrabold text-brandblue"
    >
      <Icon name="lock" className="h-3 w-3" />
      {t(target === "ultra" ? "Ultra" : "Pro")}
    </button>
  );
}
