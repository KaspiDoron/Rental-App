"use client";

// Will's full conversation sheet: transcript, quick-command chips, composer.
// The dock opens this; both share the same useWill state via props.

import { useEffect, useRef, useState } from "react";
import { Modal } from "../Modal";
import { Icon } from "../icons";
import { LoadingDots } from "../LoadingDots";
import { WillMessage } from "./WillMessage";
import type { WillMsg } from "@/lib/useWill";
import { useI18n } from "@/lib/i18n";

const QUICK = [
  "What's happening right now?",
  "Compare the top 3",
  "Why is this the best option?",
  "Try negotiating harder",
  "Pause this search",
];

export function WillSheet({
  messages,
  notes,
  busy,
  onSend,
  onClose,
}: {
  messages: WillMsg[];
  notes: string[];
  busy: boolean;
  onSend: (text: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages, busy]);

  const submit = () => {
    if (!draft.trim()) return;
    onSend(draft);
    setDraft("");
  };

  return (
    <Modal onClose={onClose}>
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-brandblue text-[16px] text-white">
            🤝
          </span>
          <div>
            <h2 className="text-[16px] font-extrabold text-strong">Will</h2>
            <p className="text-[11px] text-faint">{t("Your rental specialist - steer everything by chat")}</p>
          </div>
        </div>
        <button onClick={onClose} className="btn btn-sm btn-ghost rounded-xl px-3" aria-label={t("Close")}>
          ✕
        </button>
      </div>

      {notes.length > 0 && (
        <div className="mb-2 rounded-2xl bg-brandyellow-soft p-2.5">
          <div className="text-[10px] font-extrabold uppercase tracking-wide text-[#8a6100] dark:text-brandyellow">
            {t("Standing instructions")}
          </div>
          <ul className="mt-0.5 space-y-0.5 text-[11px] font-bold text-[#8a6100] dark:text-brandyellow">
            {notes.map((n) => (
              <li key={n}>· {n}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="no-scrollbar max-h-[45vh] min-h-[160px] space-y-2 overflow-y-auto rounded-2xl bg-card p-3">
        {messages.length === 0 && (
          <div className="py-6 text-center">
            <p className="text-[13px] font-extrabold text-strong">
              {t("Tell me what you need - in your own words")}
            </p>
            <p className="mx-auto mt-1 max-w-[280px] text-[11px] text-soft">
              {t("\"Expand the radius to 10km\", \"only scooters under 150 a day\", \"what are you doing right now?\" - I handle it.")}
            </p>
          </div>
        )}
        {messages.map((m) => (
          <WillMessage key={m.at + m.role} msg={m} />
        ))}
        {busy && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-md bg-card2 px-3 py-2">
              <LoadingDots label={t("Will is thinking")} />
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="no-scrollbar mt-2 flex gap-1.5 overflow-x-auto">
        {QUICK.map((q) => (
          <button
            key={q}
            onClick={() => onSend(q)}
            disabled={busy}
            className="chip whitespace-nowrap rounded-full border border-line px-2.5 py-1 text-[11px] font-bold text-soft disabled:opacity-50"
          >
            {t(q)}
          </button>
        ))}
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder={t("Ask Will anything...")}
          className="h-11 flex-1 rounded-2xl border-2 border-line bg-card px-3 text-sm text-strong placeholder:text-faint focus:border-brandblue focus:outline-none"
        />
        <button
          onClick={submit}
          disabled={busy || !draft.trim()}
          className="btn btn-primary h-11 rounded-2xl px-4 disabled:opacity-50"
          aria-label={t("Send")}
        >
          <Icon name="send" className="h-4.5 w-4.5" />
        </button>
      </div>
    </Modal>
  );
}
