"use client";

// ONE bubble, used by every transcript surface (ThreadDashboard's "Full
// conversation" and the TranscriptSheet). It used to be copy-pasted in both,
// which is why photos, voice notes and dropped pins rendered as the literal
// string "[photo]" in one place and were invisible in the other.
//
// A shop's price board IS the offer. A dropped pin IS the address. Showing the
// traveller a placeholder where the shop sent real information is the app
// lying about its own conversation - so every message type gets a real render
// here, and anything unrecognised still falls back to its text.

import { useState } from "react";
import { useI18n } from "@/lib/i18n";

export interface ThreadMsg {
  id: string;
  dir: "in" | "out";
  text: string;
  english?: string;
  kind?: string;
  at: string;
  /** Present when the shop sent a photo / voice note / document. */
  media?: { id: string; kind: string; fileName?: string | null };
  /** A dropped WhatsApp pin. */
  location?: { lat: number; lng: number; name?: string | null };
  /** A shared contact card. */
  contact?: { name?: string | null; digits?: string | null };
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Bytes are redeemed on demand and never cached publicly - see /api/wa/media. */
const mediaSrc = (id: string) => `/api/wa/media?id=${encodeURIComponent(id)}`;

function MediaPart({ media }: { media: NonNullable<ThreadMsg["media"]> }) {
  const { t } = useI18n();
  const [broken, setBroken] = useState(false);
  const src = mediaSrc(media.id);

  if (media.kind === "audio") {
    return (
      <audio controls preload="none" src={src} className="mt-1 h-9 w-full max-w-[220px]">
        {t("Voice message")}
      </audio>
    );
  }
  if (media.kind === "document") {
    return (
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        className="mt-1 flex items-center gap-1.5 rounded-xl bg-black/10 px-2 py-1.5 text-[11px] font-extrabold underline"
      >
        📄 {media.fileName || t("Open document")}
      </a>
    );
  }
  // An image that will not load is not worth an empty grey box - say so.
  if (broken) {
    return (
      <div className="mt-1 rounded-xl bg-black/10 px-2 py-1.5 text-[11px] font-bold opacity-80">
        🖼️ {t("Photo no longer available on WhatsApp")}
      </div>
    );
  }
  return (
    <a href={src} target="_blank" rel="noreferrer" className="mt-1 block">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={t("Photo from the shop")}
        loading="lazy"
        decoding="async"
        onError={() => setBroken(true)}
        className="max-h-56 w-full rounded-xl object-cover"
      />
    </a>
  );
}

export function MessageBubble({ m }: { m: ThreadMsg }) {
  const { t } = useI18n();
  const out = m.dir === "out";
  // A pin is only useful if you can open it - link out to the map, do not
  // print coordinates the traveller has to copy by hand.
  const mapHref = m.location
    ? `https://www.google.com/maps/search/?api=1&query=${m.location.lat},${m.location.lng}`
    : null;
  // "[photo]" is a placeholder the ingest writes when there is no caption; once
  // the photo itself is on screen the placeholder is noise.
  const placeholder = /^\[(photo|voice note|document[^\]]*)\]$/i.test(m.text.trim());
  const showText = m.text && !(m.media && placeholder);

  return (
    <div className={`flex ${out ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3 py-2 text-[12px] font-semibold leading-snug ${
          out
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
        {m.media && <MediaPart media={m.media} />}
        {mapHref && (
          <a
            href={mapHref}
            target="_blank"
            rel="noreferrer"
            className="mt-1 flex items-center gap-1.5 rounded-xl bg-black/10 px-2 py-1.5 text-[11px] font-extrabold underline"
          >
            📍 {m.location?.name || t("Open the shop's pin in Maps")}
          </a>
        )}
        {m.contact && (m.contact.name || m.contact.digits) && (
          <div className="mt-1 rounded-xl bg-black/10 px-2 py-1.5 text-[11px] font-bold">
            👤 {m.contact.name || t("Contact")}
            {m.contact.digits ? ` · +${m.contact.digits}` : ""}
          </div>
        )}
        {showText ? <div className={m.media ? "mt-1" : ""}>{m.text}</div> : null}
        {m.english && m.english !== m.text && (
          <div className="mt-1 border-t border-white/25 pt-1 text-[10px] font-normal opacity-85">
            {m.english}
          </div>
        )}
        <div className={`mt-0.5 text-[9px] font-bold ${out ? "text-white/70" : "text-faint"}`}>
          {clock(m.at)}
        </div>
      </div>
    </div>
  );
}
