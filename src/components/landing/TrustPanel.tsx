"use client";

// The WhatsApp trust story, told honestly: what actually protects the user's
// number and their privacy. Reused on the public landing page, the login
// screen (compact) and inside WaConnect - one component so the promises never
// drift from each other.

import { useState } from "react";
import { Icon } from "../icons";
import { useI18n } from "@/lib/i18n";

// EVERY LINE HERE MUST BE TRUE OF THE CODE AS IT SHIPS TODAY.
//
// Six of these described a system nobody had built. "Warmed up gently" while
// effectiveNewContactCap discards its age arguments by design; "never at 3am"
// while FAST_DISPATCH defaults ON and lifts the clock gate; "at the first sign
// of risk all sending stops" while the restriction detector matched words
// against a numeric status code and had never fired; "one conversation per shop
// per day" while a blue tick unlocked a follow-up.
//
// A disclaimer elsewhere does not cure an affirmative misstatement of present
// fact made on the screen that induces the user to link their personal number.
// So the rule for this array is narrow and absolute: if the code does not do it
// today, it does not go here - and nothing in it may promise an outcome that
// WhatsApp, not us, decides.
const MECHANICS = [
  "Human pacing: randomised gaps between messages, a per-shop send lock, and a hard hourly and daily budget.",
  "Business-hours awareness: we know each shop's local hours and message the open ones first. A closed shop still gets your message - it simply waits unread until they open.",
  "Every message is uniquely worded - no two shops receive the same text, and your dates are always included so a shop can actually answer.",
  "One introduction per shop. After that your agent only writes again once the shop has actually written back.",
  "If WhatsApp pushes back on a new conversation, your agent stops opening new ones and keeps answering the shops already talking to you.",
];

/**
 * The line that is NOT a feature. It sits apart from the mechanics because it
 * is the one thing on this panel we do not control, and burying it in a list of
 * reassurances is how it stops being read.
 */
const CANNOT_PROMISE =
  "What we cannot promise: WhatsApp decides what happens to your number. Messaging many new shops who never reply is what gets personal numbers restricted, and no amount of pacing rules that out. Link a number you could manage without.";

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
      // "automatic breaks whenever caution is wise" implied a system that knew
      // when caution was wise. Safeguards, stated as safeguards - not as a
      // guarantee of an outcome WhatsApp controls.
      body: t("Human rhythm, sensible daily amounts, and one introduction per shop. Safeguards, not a guarantee."),
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
              {/* Deliberately last, deliberately not a check mark, deliberately
                  not phrased as another reassurance. */}
              <li className="mt-2 flex items-start gap-1.5 border-t border-line pt-2 text-[11px] font-bold leading-relaxed text-soft">
                {t(CANNOT_PROMISE)}
              </li>
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
