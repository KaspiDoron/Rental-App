"use client";

// The WhatsApp trust story, told honestly: what actually protects the user's
// number and their privacy. Reused on the public landing page, the login
// screen (compact) and inside WaConnect - one component so the promises never
// drift from each other.

import { useState } from "react";
import { Icon } from "../icons";
import { useI18n } from "@/lib/i18n";

const MECHANICS = [
  "A trust score per number: sending capacity grows slowly as your number proves healthy - brand-new numbers are warmed up gently.",
  "Human pacing: randomised gaps between messages, typing indicators, and a hard hourly + daily send budget.",
  "Business-hours queueing: shops are messaged when they are open, never at 3am.",
  "Every message is uniquely worded - no two shops ever receive the same text.",
  "Automatic safety pause: at the first sign of risk (failed sends, low reply rates) all sending stops on its own.",
  "One conversation per shop per day - your agents never spam a thread.",
];

export function TrustPanel({
  compact = false,
  frame = true,
}: {
  compact?: boolean;
  /** false = render bare (for embedding inside an existing card) */
  frame?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  const rows: { icon: string; title: string; body: string }[] = [
    {
      icon: "lock",
      title: t("Messages come from YOUR phone"),
      body: t("Shops see you, not a bot - conversations stay in your own WhatsApp, end to end."),
    },
    {
      icon: "shieldCheck",
      title: t("Your number is treated with care"),
      body: t("Human rhythm, sensible daily amounts, and automatic breaks whenever caution is wise."),
    },
    {
      icon: "eyeOff",
      title: t("We never read your personal chats"),
      body: t("Only the shop threads WheelDeal opens are processed - nothing else, ever."),
    },
  ];

  return (
    <div className={compact || !frame ? "" : "surface rounded-blob p-4"}>
      <div className="space-y-3">
        {rows.map((r) => (
          <div key={r.icon} className="flex items-start gap-2.5">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brandblue-soft text-brandblue">
              <Icon name={r.icon} className="h-4 w-4" />
            </span>
            <div>
              <div className="text-[13px] font-extrabold text-strong">{r.title}</div>
              {!compact && <p className="text-[12px] leading-relaxed text-soft">{r.body}</p>}
            </div>
          </div>
        ))}
      </div>
      {!compact && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="chip flex items-center gap-1 text-[12px] font-extrabold text-brandblue"
          >
            {t("How we look after your number")}
            <Icon name="chevron" className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
          </button>
          {open && (
            <ul className="mt-2 space-y-1.5 rounded-2xl bg-card2 p-3">
              {MECHANICS.map((m) => (
                <li key={m.slice(0, 24)} className="flex items-start gap-1.5 text-[11px] leading-relaxed text-soft">
                  <Icon name="check" className="mt-0.5 h-3 w-3 shrink-0 text-savings" />
                  {t(m)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
