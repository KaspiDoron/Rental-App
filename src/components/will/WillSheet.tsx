"use client";

// Will's full conversation sheet: transcript, quick-command chips, composer
// (with voice input where the browser supports it). Opened from the Will
// companion on the screen edge - this is THE conversational surface.

import { useEffect, useRef, useState } from "react";
import { Modal } from "../Modal";
import { Icon } from "../icons";
import { LoadingDots } from "../LoadingDots";
import { OrbitDots } from "../OrbitDots";
import { WillMessage } from "./WillMessage";
import { WillAvatar } from "./WillAvatar";
import { getRecognizer, type SpeechRecognitionLike } from "@/lib/speech";
import type { WillMsg } from "@/lib/useWill";
import { useI18n } from "@/lib/i18n";

const QUICK = [
  "What can you do?",
  "What's happening right now?",
  "Compare the top 3",
  "Why is this the best option?",
  "Try negotiating harder",
  "Open my trips",
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
  const [listening, setListening] = useState(false);
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setVoiceAvailable(Boolean(getRecognizer()));
  }, []);

  const toggleVoice = () => {
    if (listening) {
      recRef.current?.stop();
      setListening(false);
      return;
    }
    const rec = getRecognizer();
    if (!rec) return;
    recRef.current = rec;
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      const said = e.results[0]?.[0]?.transcript ?? "";
      if (said.trim()) onSend(said);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    setListening(true);
    rec.start();
  };

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
          <WillAvatar size={38} />
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
          disabled={busy}
          placeholder={
            busy ? t("Sending...") : listening ? t("Listening...") : t("Ask Will anything...")
          }
          // transition-colors: the focus border eases in instead of snapping
          // (the "flashes blue for no reason" report was a hard border swap on
          // every focus/blur/re-render). disabled:opacity while a reply is in
          // flight so the composer reads as busy, matching the send spinner.
          className="h-11 min-w-0 flex-1 rounded-2xl border-2 border-line bg-card px-3 text-sm text-strong placeholder:text-faint transition-colors duration-200 focus:border-brandblue focus:outline-none disabled:opacity-60"
          style={{ fontSize: "16px" }}
        />
        {voiceAvailable && !draft.trim() && (
          <button
            onClick={toggleVoice}
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl ${
              listening ? "bg-brandred text-white soft-pulse" : "bg-card2 text-soft"
            }`}
            aria-label={t("Voice input")}
          >
            <Icon name="mic" className="h-4 w-4" />
          </button>
        )}
        <button
          onClick={submit}
          disabled={busy || !draft.trim()}
          className="btn btn-primary h-11 shrink-0 rounded-2xl px-4 disabled:opacity-50"
          aria-label={busy ? t("Sending...") : t("Send")}
          aria-busy={busy}
        >
          {busy ? (
            <OrbitDots size={16} light label={t("Sending...")} />
          ) : (
            <Icon name="send" className="h-4.5 w-4.5" />
          )}
        </button>
      </div>
    </Modal>
  );
}
