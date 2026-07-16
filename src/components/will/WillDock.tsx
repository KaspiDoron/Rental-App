"use client";

// The sticky one-row composer that makes conversation the dominant interface:
// always reachable above the TabBar, one thumb, with voice input where the
// browser supports it (Web Speech API - progressive enhancement, no deps).
// Will himself leans over the left edge of the bar - a tiny living avatar
// (blinks, waves) - so typing here feels like chatting with a companion, not
// filling out a form. Placeholders rotate through short conversational hooks.

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../icons";
import { WillAvatar } from "./WillAvatar";
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
  hints,
  onSend,
  onOpen,
}: {
  busy: boolean;
  paused: boolean;
  lastSay?: string;
  /** Contextual placeholder hooks - the dock rotates through them. */
  hints?: string[];
  onSend: (text: string) => void;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const [listening, setListening] = useState(false);
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [hintIdx, setHintIdx] = useState(0);
  const recRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    setVoiceAvailable(Boolean(getRecognizer()));
  }, []);

  // Short, conversational, contextual - never instructional.
  const prompts = useMemo(() => {
    const base = hints?.length
      ? hints
      : [
          t("Ask Will anything..."),
          t("Need the cheapest scooter?"),
          t("What should I negotiate?"),
          t("Where are you staying?"),
        ];
    return base.filter(Boolean);
  }, [hints, t]);

  useEffect(() => {
    if (prompts.length < 2) return;
    const id = setInterval(() => setHintIdx((i) => i + 1), 4200);
    return () => clearInterval(id);
  }, [prompts.length]);

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

  const placeholder = listening
    ? t("Listening...")
    : busy
      ? t("Will is on it...")
      : prompts[hintIdx % Math.max(1, prompts.length)] ?? t("Ask Will anything...");

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
            className="relative mb-2 ml-9 block w-[calc(100%-2.25rem)] rounded-2xl rounded-bl-md bg-card2/95 px-3 py-2 text-left text-[12px] font-bold leading-snug text-soft shadow-md backdrop-blur animate-slide-up"
          >
            <span className="line-clamp-2">{lastSay}</span>
            <span
              aria-hidden
              className="absolute -bottom-1 left-3 h-2.5 w-2.5 rotate-45 bg-card2/95"
            />
          </button>
        )}
        <div className="relative">
          {/* Will leans over the edge of the bar - tap him to open the chat */}
          <button
            onClick={onOpen}
            className="absolute -left-1.5 -top-2.5 z-10 transition-transform active:scale-95"
            aria-label={t("Open Will")}
          >
            <WillAvatar size={48} wave={!busy} className="drop-shadow-lg" />
            {busy && (
              <span className="absolute -right-0.5 top-0 h-2.5 w-2.5 animate-ping rounded-full bg-brandyellow" />
            )}
            {paused && !busy && (
              <span className="absolute -right-1 top-0 flex h-4 w-4 items-center justify-center rounded-full bg-brandyellow text-black shadow">
                <Icon name="pause" className="h-2.5 w-2.5" />
              </span>
            )}
          </button>
          <div className="surface-strong flex items-center gap-1.5 rounded-full py-1.5 pl-12 pr-1.5 shadow-xl">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder={placeholder}
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
    </div>
  );
}
