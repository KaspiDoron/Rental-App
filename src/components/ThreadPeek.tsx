"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";

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
  return (
    <details className="rounded-xl border-2 border-line p-2 text-[11px]">
      <summary className={`cursor-pointer font-extrabold ${accent}`}>
        {emoji} {label}: &ldquo;{summarize(msg.text)}&rdquo;
      </summary>
      <p className="mt-1.5 whitespace-pre-wrap leading-relaxed text-soft">{msg.text}</p>
      {msg.english && msg.english.trim() !== msg.text.trim() && (
        <p className="mt-1 whitespace-pre-wrap rounded-lg bg-brandblue-soft p-1.5 text-[10px] font-bold leading-relaxed text-brandblue">
          🌐 {inEnglishLabel}: {msg.english}
        </p>
      )}
    </details>
  );
}

export function ThreadPeek({
  vendorId,
  fallbackReceived,
  since,
}: {
  vendorId: string;
  // The shop's offer message already on the card (replies are shown verbatim,
  // so the fallback is safe for the received side only).
  fallbackReceived?: string;
  // Session epoch - only show messages from the current search, never a
  // previous session's thread with the same shop.
  since?: number;
}) {
  const { t } = useI18n();
  const [sent, setSent] = useState<Msg | null>(null);
  const [received, setReceived] = useState<Msg | null>(
    fallbackReceived ? { text: fallbackReceived } : null
  );

  useEffect(() => {
    let alive = true;
    // POLL, don't fetch-once: the card mounts this peek the instant the RFQ is
    // sent - BEFORE any reply exists - so a single fetch showed an empty thread
    // forever and the shop's reply never rendered. Re-fetch on an interval (and
    // no-store) so a reply that lands seconds later appears without a refresh.
    const load = async () => {
      // Pause in a hidden tab: with a peek mounted per engaged card, N x 10s
      // would be needless load while the user is away (matches the activity
      // poll's own visibility gate). It resumes on focus.
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const r = await fetch(
          `/api/thread?vendorId=${encodeURIComponent(vendorId)}${since ? `&since=${since}` : ""}`,
          { cache: "no-store" }
        );
        if (!r.ok) return;
        const d = await r.json();
        if (!alive || !d) return;
        if (d.sent?.text) setSent(d.sent);
        if (d.received?.text) setReceived(d.received);
      } catch {
        /* transient - the next tick retries */
      }
    };
    void load();
    const iv = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
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
