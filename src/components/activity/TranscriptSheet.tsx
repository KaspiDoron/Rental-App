"use client";

// Full WhatsApp-style transcript of one shop thread (both directions, oldest
// first). Read-only in Phase 3; the human-takeover controls plug in here.

import { useEffect, useRef, useState } from "react";
import { Modal } from "../Modal";
import { LoadingDots } from "../LoadingDots";
import { useI18n } from "@/lib/i18n";

interface Msg {
  id: string;
  dir: "in" | "out";
  text: string;
  english?: string;
  kind?: string;
  at: string;
}

export function TranscriptSheet({
  vendorId,
  vendorName,
  since,
  onClose,
}: {
  vendorId: string;
  vendorName: string;
  since?: number;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [messages, setMessages] = useState<Msg[] | null>(null);
  const [takeover, setTakeover] = useState<boolean | null>(null);
  const [switching, setSwitching] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const q = new URLSearchParams({ vendorId, full: "1" });
    if (since) q.set("since", String(since));
    fetch(`/api/thread?${q.toString()}`)
      .then((r) => r.json())
      .then((d) => setMessages(Array.isArray(d.messages) ? d.messages : []))
      .catch(() => setMessages([]));
    fetch(`/api/thread/takeover?vendorId=${encodeURIComponent(vendorId)}`)
      .then((r) => r.json())
      .then((d) => setTakeover(Boolean(d.takeover)))
      .catch(() => {});
  }, [vendorId, since]);

  async function switchTakeover(mode: "takeover" | "handback") {
    setSwitching(true);
    try {
      const res = await fetch("/api/thread/takeover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vendorId, mode }),
      });
      const d = await res.json();
      if (d.ok !== undefined) setTakeover(mode === "takeover");
    } finally {
      setSwitching(false);
    }
  }

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  return (
    <Modal onClose={onClose}>
      <div className="mb-2 flex items-center justify-between">
        <div>
          <h2 className="text-[16px] font-extrabold text-strong">{vendorName}</h2>
          <p className="text-[11px] text-faint">{t("The full conversation, exactly as sent")}</p>
        </div>
        <button onClick={onClose} className="btn btn-sm btn-ghost rounded-xl px-3" aria-label={t("Close")}>
          ✕
        </button>
      </div>

      {takeover !== null && (
        <div
          className={`mb-2 flex items-center justify-between gap-2 rounded-2xl p-2.5 ${
            takeover ? "bg-savings-soft" : "bg-card2"
          }`}
        >
          <div className="min-w-0 text-[11px] font-bold leading-snug text-soft">
            {takeover
              ? t("You have the wheel - Will stays silent on this chat until you hand it back.")
              : t("Will is handling this chat. Take over any time - he'll stand down instantly.")}
          </div>
          <button
            onClick={() => switchTakeover(takeover ? "handback" : "takeover")}
            disabled={switching}
            className={`btn btn-sm shrink-0 rounded-xl px-3 py-1.5 text-[11px] font-extrabold disabled:opacity-50 ${
              takeover ? "btn-primary" : "btn-ghost border border-line"
            }`}
          >
            {takeover ? t("Hand back to Will") : t("Take over")}
          </button>
        </div>
      )}

      <div className="no-scrollbar max-h-[55vh] space-y-2 overflow-y-auto rounded-2xl bg-card2 p-3">
        {messages === null && <LoadingDots label={t("Loading the conversation")} />}
        {messages !== null && messages.length === 0 && (
          <p className="py-4 text-center text-[12px] text-faint">
            {t("No messages in this thread yet.")}
          </p>
        )}
        {messages?.map((m) => (
          <div key={m.id} className={`flex ${m.dir === "out" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[85%] rounded-2xl px-3 py-2 text-[12px] font-semibold leading-snug ${
                m.dir === "out"
                  ? m.kind === "human-manual"
                    ? "rounded-br-md bg-savings text-white"
                    : "rounded-br-md bg-brandblue text-white"
                  : "rounded-bl-md bg-card text-strong"
              }`}
            >
              {m.kind === "human-manual" && (
                <div className="mb-0.5 text-[9px] font-extrabold uppercase tracking-wide opacity-80">
                  {t("You (from WhatsApp)")}
                </div>
              )}
              {m.text}
              {m.english && m.english !== m.text && (
                <div className="mt-1 border-t border-white/25 pt-1 text-[10px] font-normal opacity-85">
                  {m.english}
                </div>
              )}
              <div className={`mt-0.5 text-[9px] font-bold ${m.dir === "out" ? "text-white/70" : "text-faint"}`}>
                {new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </div>
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <p className="mt-2 text-center text-[10px] text-faint">
        {t("Blue = your agent · Grey = the shop. Continue any time from your own WhatsApp.")}
      </p>
    </Modal>
  );
}
