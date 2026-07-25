"use client";

// Tier-1 stat tiles for the Engine section: a big number with a label and an
// InfoTip that explains it. `helpId` looks the copy up in ENGINE_HELP so every
// tile is self-documenting. Kept tiny and presentational.

import { InfoTip } from "@/components/InfoTip";
import { ENGINE_HELP } from "./help";

export function StatTile({
  helpId,
  label,
  value,
  tone,
}: {
  helpId: keyof typeof ENGINE_HELP | string;
  label?: string;
  value: string | number;
  tone?: string;
}) {
  const h = ENGINE_HELP[helpId as string];
  return (
    <div className="surface rounded-2xl p-3 text-center">
      <div className="flex items-center justify-center gap-1 text-[10px] font-extrabold uppercase tracking-wide text-faint">
        <span>{label ?? h?.label ?? helpId}</span>
        {h && <InfoTip id={`tip-${helpId}`} label={h.label} what={h.what} drift={h.drift} />}
      </div>
      <div className={`mt-0.5 text-lg font-extrabold ${tone ?? "text-strong"}`}>{value}</div>
    </div>
  );
}
