"use client";

// The sticky one-row composer that makes conversation the dominant interface:
// always reachable above the TabBar, one thumb, with voice input where the
// browser supports it (Web Speech API - progressive enhancement, no deps).

import { useEffect, useRef, useState } from "react";
import { Icon } from "../icons";
import { useI18n } from "@/lib/i18n";

// Minimal typing for the vendor-prefixed Web Speech API.
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
}

function getRecognizer(): SpeechRecognitionLike | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}

export function WillDock({
  busy,
  paused,
  lastSay,
  onSend,
  onOpen,
}: {
  busy: boolean;
  paused: boolean;
  lastSay?: string;
  onSend: (text: string) => void;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const [listening, setListening] = useState(false);
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);

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

  const submit = () => {
    if (!draft.trim() || busy) return;
    onSend(draft);
    setDraft("");
  };

  return (
    <div
      data-tour="will"
      className="fixed inset-x-0 z-40 px-4"
      style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 76px)" }}
    >
      <div className="mx-auto max-w-md sm:max-w-lg md:max-w-3xl">
        {lastSay && (
          <button
            onClick={onOpen}
            className="mb-1.5 block w-full truncate rounded-2xl bg-card2/95 px-3 py-1.5 text-left text-[11px] font-bold text-soft shadow-md backdrop-blur animate-slide-up"
          >
            🤝 {lastSay}
          </button>
        )}
        <div className="surface-strong flex items-center gap-1.5 rounded-full p-1.5 shadow-xl">
          <button
            onClick={onOpen}
            className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brandblue text-[15px] text-white"
            aria-label={t("Open Will")}
          >
            🤝
            {busy && (
              <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 animate-ping rounded-full bg-brandyellow" />
            )}
            {paused && !busy && (
              <span className="absolute -right-0.5 -top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-brandyellow text-[8px]">
                ⏸
              </span>
            )}
          </button>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            placeholder={listening ? t("Listening...") : t("Tell Will what to do...")}
            className="h-9 min-w-0 flex-1 bg-transparent px-1 text-sm text-strong placeholder:text-faint focus:outline-none"
            style={{ fontSize: "16px" }}
          />
          {voiceAvailable && !draft.trim() && (
            <button
              onClick={toggleVoice}
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
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
            className="btn btn-primary flex h-9 w-9 shrink-0 items-center justify-center rounded-full p-0 disabled:opacity-40"
            aria-label={t("Send")}
          >
            <Icon name="send" className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
