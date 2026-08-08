"use client";

// Honest anti-ban visibility: a compact pill that tells the traveller what
// the safety engine is doing with their number RIGHT NOW - healthy, pacing,
// paused, recovering, disconnected or needs-attention. Ends the "connected
// but silently held" confusion - and, since the incident, the reverse lie
// too: this badge said "All good" while the connection was down and replies
// were bouncing, because health used to be "reputation OK + queue empty".

import { useState } from "react";
import { Icon } from "./icons";
import { useI18n } from "@/lib/i18n";

export interface WaSafety {
  state: "healthy" | "pacing" | "paused" | "recovering" | "disconnected" | "attention";
  reason?: string;
  publicReason?: string;
  pausedUntil?: string;
  trustScore: number;
  riskScore: number;
  queued: number;
  queueReasons: string[];
  publicQueueReasons?: string[];
}

export function WaSafetyBadge({ safety }: { safety: WaSafety | null }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!safety) return null;

  const cfg =
    safety.state === "healthy"
      ? {
          cls: "bg-savings-soft text-savings",
          icon: "shieldCheck",
          label: t("All good"),
        }
      : safety.state === "pacing"
      ? {
          cls: "bg-brandyellow-soft text-[#8a6100] dark:text-brandyellow",
          icon: "clock",
          label: `${safety.queued} ${t("in line - sending automatically")}`,
        }
      : safety.state === "disconnected"
      ? {
          cls: "bg-brandred-soft text-brandred",
          icon: "shield",
          label: t("WhatsApp disconnected - replies can't reach the app"),
        }
      : safety.state === "attention"
      ? {
          cls: "bg-brandyellow-soft text-[#8a6100] dark:text-brandyellow",
          icon: "shield",
          label: t("Some messages need a look"),
        }
      : {
          cls: "bg-brandred-soft text-brandred",
          icon: "shield",
          label: t("Taking a short break"),
        };

  return (
    <div className="mt-2">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`chip flex w-full items-center gap-1.5 rounded-2xl px-3 py-2 text-[11px] font-extrabold ${cfg.cls}`}
      >
        <Icon name={cfg.icon} className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">
          {t("Messaging")}: {cfg.label}
        </span>
        <Icon name="chevron" className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open && (
        <div className="mt-1.5 rounded-2xl bg-card2 p-3 text-[11px] leading-relaxed text-soft animate-slide-up">
          {safety.state === "healthy" && (
            <p>{t("All clear - your number is healthy and messages send at a natural, human pace.")}</p>
          )}
          {safety.publicReason && safety.state !== "healthy" && <p>{t(safety.publicReason)}</p>}
          {safety.pausedUntil && (
            <p className="mt-1 font-bold">
              {t("Sending resumes")}:{" "}
              {new Date(safety.pausedUntil).toLocaleString([], {
                hour: "2-digit",
                minute: "2-digit",
                day: "numeric",
                month: "short",
              })}
            </p>
          )}
          {safety.queued > 0 && (
            <p className="mt-1">
              {safety.queued} {t("message(s) held")}
              {(safety.publicQueueReasons ?? []).length > 0 ? ` - ${(safety.publicQueueReasons ?? []).join(" · ")}` : ""}
            </p>
          )}
          <p className="mt-1.5 text-[10px] text-faint">
            {t("Short waits are deliberate - they keep each message personal and give shops time to answer.")}
          </p>
        </div>
      )}
    </div>
  );
}
