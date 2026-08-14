"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { WaText } from "./WaText";
import { waPlain } from "@/lib/wa/format";
import { subscribeThreadPeek } from "@/lib/client/thread-peek-store";

// The card's conversation peek: TWO individually collapsible sections in one
// component - the last message we sent the shop and the last message the shop
// sent back. Ordered chronologically: the OLDER one sits on top, the newest
// message is always at the bottom (like a real chat).
//
// TRUTH RULE: the "sent" row shows ONLY what the server actually delivered
// (or queued) - the real WhatsApp body, even when it's in the shop's local
// language, with the English gloss underneath. It is never seeded from a
// client-side draft, because the real message is rewritten (localized,
// humanized, uniqueness-varied) before it leaves.

interface Msg {
  text: string;
  at?: string;
  english?: string; // Ultra local-language: English gloss of what we said
  queued?: boolean; // still held in the outbox - will send automatically
}

function summarize(m: string): string {
  const first = m.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0] ?? m;
  return first.length > 64 ? `${first.slice(0, 61)}...` : first;
}

function Row({
  label,
  emoji,
  msg,
  accent,
  inEnglishLabel,
}: {
  label: string;
  emoji: string;
  msg: Msg;
  accent: string;
  inEnglishLabel: string;
}) {
  // GLOSS-FIRST PREVIEW (W1.5): the always-visible one line is the ENGLISH
  // gloss when one exists - a collapsed Thai preview told the traveller
  // nothing. The raw local text stays primary in the expanded view below,
  // with the gloss under it, exactly as before.
  const gloss = msg.english?.trim();
  const preview = gloss && gloss !== msg.text.trim() ? gloss : msg.text;
  return (
    <details className="rounded-xl border-2 border-line p-2 text-[11px]">
      <summary className={`cursor-pointer font-extrabold ${accent}`}>
        {/* The one-line preview is plain text - formatting marks would be
            noise inside a quoted summary, but the asterisks must not show
            either. */}
        {emoji} {label}: &ldquo;{summarize(waPlain(preview))}&rdquo;
      </summary>
      <p className="mt-1.5 whitespace-pre-wrap leading-relaxed text-soft">
        <WaText text={msg.text} />
      </p>
      {msg.english && msg.english.trim() !== msg.text.trim() && (
        <p className="mt-1 whitespace-pre-wrap rounded-lg bg-brandblue-soft p-1.5 text-[10px] font-bold leading-relaxed text-brandblue">
          🌐 {inEnglishLabel}: <WaText text={msg.english} />
        </p>
      )}
    </details>
  );
}

export function ThreadPeek({
  vendorId,
  fallbackReceived,
  fallbackReceivedEnglish,
  since,
}: {
  vendorId: string;
  // The shop's offer message already on the card (replies are shown verbatim,
  // so the fallback is safe for the received side only).
  fallbackReceived?: string;
  // Its English gloss (offer.messageEnglish) - the seeded first reply used to
  // carry no `english`, so the peek opened raw-local until the first poll.
  fallbackReceivedEnglish?: string;
  // Session epoch - only show messages from the current search, never a
  // previous session's thread with the same shop.
  since?: number;
}) {
  const { t } = useI18n();
  const [sent, setSent] = useState<Msg | null>(null);
  const [received, setReceived] = useState<Msg | null>(
    fallbackReceived ? { text: fallbackReceived, english: fallbackReceivedEnglish } : null
  );

  useEffect(() => {
    // SUBSCRIBE, don't poll. This component still needs live data - the card
    // mounts it the instant the RFQ is sent, BEFORE any reply exists, so a
    // single fetch showed an empty thread forever. But the poll does not belong
    // HERE: one peek is mounted per engaged shop, so an interval per component
    // meant twenty timers and twenty requests every ten seconds on a busy
    // board. The store owns one timer and one batched request for every card
    // and fans the answer out - see lib/client/thread-peek-store.
    return subscribeThreadPeek(vendorId, since, (peek) => {
      if (peek.sent?.text) setSent(peek.sent);
      if (peek.received?.text) setReceived(peek.received);
    });
  }, [vendorId, since]);

  if (!sent && !received) return null;

  // Newest message at the bottom.
  const sentAt = sent?.at ? Date.parse(sent.at) : 0;
  const recvAt = received?.at ? Date.parse(received.at) : 1; // replies default newer
  const rows = [
    sent && {
      key: "sent",
      at: sentAt,
      node: (
        <Row
          key="sent"
          label={sent.queued ? t("Queued to send") : t("Last message sent")}
          emoji={sent.queued ? "🕘" : "📤"}
          msg={sent}
          accent="text-brandblue"
          inEnglishLabel={t("In English")}
        />
      ),
    },
    received && {
      key: "recv",
      at: recvAt,
      node: (
        <Row
          key="recv"
          label={t("Last reply from the shop")}
          emoji="📥"
          msg={received}
          accent="text-savings"
          inEnglishLabel={t("In English")}
        />
      ),
    },
  ]
    .filter((x): x is { key: string; at: number; node: React.ReactElement } => Boolean(x))
    .sort((a, b) => a.at - b.at);

  return <div className="mt-1.5 space-y-1.5">{rows.map((r) => r.node)}</div>;
}
