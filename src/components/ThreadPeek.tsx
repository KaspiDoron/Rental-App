"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";

// The card's conversation peek: TWO individually collapsible sections in one
// component - the last message we sent the shop and the last message the shop
// sent back. Ordered chronologically: the OLDER one sits on top, the newest
// message is always at the bottom (like a real chat).

interface Msg {
  text: string;
  at?: string;
  english?: string; // Ultra local-language: English gloss of what we said
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
}: {
  label: string;
  emoji: string;
  msg: Msg;
  accent: string;
}) {
  return (
    <details className="rounded-xl border-2 border-line p-2 text-[11px]">
      <summary className={`cursor-pointer font-extrabold ${accent}`}>
        {emoji} {label}: &ldquo;{summarize(msg.text)}&rdquo;
      </summary>
      <p className="mt-1.5 whitespace-pre-wrap leading-relaxed text-soft">{msg.text}</p>
      {msg.english && (
        <p className="mt-1 whitespace-pre-wrap rounded-lg bg-brandblue-soft p-1.5 text-[10px] font-bold leading-relaxed text-brandblue">
          🌐 In English: {msg.english}
        </p>
      )}
    </details>
  );
}

export function ThreadPeek({
  vendorId,
  fallbackSent,
  fallbackReceived,
}: {
  vendorId: string;
  // Shown until (or instead of) live thread data: the RFQ we composed and the
  // shop's offer message already on the card.
  fallbackSent?: string;
  fallbackReceived?: string;
}) {
  const { t } = useI18n();
  const [sent, setSent] = useState<Msg | null>(
    fallbackSent ? { text: fallbackSent } : null
  );
  const [received, setReceived] = useState<Msg | null>(
    fallbackReceived ? { text: fallbackReceived } : null
  );

  useEffect(() => {
    let alive = true;
    fetch(`/api/thread?vendorId=${encodeURIComponent(vendorId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d) return;
        if (d.sent?.text) setSent(d.sent);
        if (d.received?.text) setReceived(d.received);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [vendorId]);

  if (!sent && !received) return null;

  // Newest message at the bottom.
  const sentAt = sent?.at ? Date.parse(sent.at) : 0;
  const recvAt = received?.at ? Date.parse(received.at) : 1; // replies default newer
  const rows = [
    sent && {
      key: "sent",
      at: sentAt,
      node: (
        <Row key="sent" label={t("Last message sent")} emoji="📤" msg={sent} accent="text-brandblue" />
      ),
    },
    received && {
      key: "recv",
      at: recvAt,
      node: (
        <Row key="recv" label={t("Last reply from the shop")} emoji="📥" msg={received} accent="text-savings" />
      ),
    },
  ]
    .filter((x): x is { key: string; at: number; node: React.ReactElement } => Boolean(x))
    .sort((a, b) => a.at - b.at);

  return <div className="mt-1.5 space-y-1.5">{rows.map((r) => r.node)}</div>;
}
