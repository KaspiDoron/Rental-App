"use client";

// The cross-shop, chronological "what are my agents doing" stream - the
// transparency heart of the product. Pure presentation: all data comes from
// /api/activity (already persisted by the live engine).

import { Icon } from "../icons";
import { ShopAvatar } from "../ShopAvatar";
import { useI18n } from "@/lib/i18n";
import { moneyLocal } from "@/lib/currency";

export interface FeedItem {
  id: string;
  at: string;
  kind: "trace" | "sent" | "reply" | "offer" | "queued" | "wait" | "judge" | "alert" | "drop";
  vendorId?: string;
  vendorName?: string;
  title: string;
  detail?: string;
  decisionId?: string;
  meta?: { pricePerDay?: number; currency?: string; round?: number; verified?: boolean; risk?: string };
}

const KIND_ICON: Record<FeedItem["kind"], string> = {
  trace: "sparkles",
  sent: "send",
  reply: "chat",
  offer: "money",
  queued: "clock",
  wait: "clock",
  judge: "star",
  alert: "alert",
  // A delivery drop is operational info, not a scam warning - it borrows the
  // alert glyph but never the red risk styling below.
  drop: "alert",
};

function relTime(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function ActivityFeed({
  items,
  onWhy,
  onJump,
  onTranscript,
  phoneOf,
}: {
  items: FeedItem[];
  onWhy: (decisionId: string) => void;
  onJump: (vendorId: string) => void;
  onTranscript: (vendorId: string, vendorName: string) => void;
  /** Resolves a shop's WhatsApp number so its avatar can load. Session-only. */
  phoneOf?: (vendorId: string) => string | undefined;
}) {
  const { t } = useI18n();

  if (items.length === 0) {
    return (
      <div className="surface mt-3 rounded-blob p-5 text-center">
        <div className="mb-1 text-2xl">🛰️</div>
        <div className="text-[13px] font-extrabold text-strong">
          {t("Nothing on the wire yet")}
        </div>
        <p className="mx-auto mt-1 max-w-[280px] text-[12px] text-soft">
          {t("As soon as your agents message a shop, every step lands here - sends, replies, decisions and deliberate waits.")}
        </p>
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-2">
      {items.map((it, i) => {
        const tone =
          it.kind === "offer"
            ? "bg-savings-soft text-savings"
            : it.kind === "alert"
            ? "bg-brandred-soft text-brandred"
            : it.kind === "wait" || it.kind === "queued" || it.kind === "drop"
            ? "bg-brandyellow-soft text-[#8a6100] dark:text-brandyellow"
            : it.kind === "reply"
            ? "bg-card2 text-soft"
            : "bg-brandblue-soft text-brandblue";
        return (
          <div
            key={it.id}
            className={`surface rise-in rounded-2xl p-3 ${
              it.kind === "alert" ? "border-2 !border-brandred/50" : ""
            }`}
            style={{ ["--i" as string]: Math.min(i, 8) }}
          >
            <div className="flex items-start gap-2.5">
              <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${tone}`}>
                <Icon name={KIND_ICON[it.kind]} className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[12px] font-extrabold text-strong">{t(it.title)}</span>
                  <span className="shrink-0 text-[10px] font-bold text-faint">{relTime(it.at)}</span>
                </div>
                {it.vendorName && (
                  <button
                    onClick={() => it.vendorId && onJump(it.vendorId)}
                    className="chip mt-0.5 inline-flex items-center gap-1 text-[11px] font-extrabold text-brandblue"
                  >
                    <ShopAvatar
                      name={it.vendorName}
                      phone={it.vendorId ? phoneOf?.(it.vendorId) : undefined}
                      size="sm"
                    />
                    {it.vendorName} →
                  </button>
                )}
                {it.kind === "offer" && it.meta?.pricePerDay ? (
                  <div className="mt-1 text-[14px] font-extrabold text-savings">
                    {moneyLocal(it.meta.pricePerDay, it.meta.currency ?? "USD")}/{t("day")}
                    {it.meta.round ? (
                      <span className="ml-1.5 text-[10px] font-bold text-faint">
                        {t("after")} {it.meta.round} {it.meta.round === 1 ? t("round") : t("rounds")}
                      </span>
                    ) : null}
                  </div>
                ) : it.detail ? (
                  <p className="mt-0.5 text-[11px] leading-relaxed text-soft">{it.detail}</p>
                ) : null}
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {it.decisionId && (
                    <button
                      onClick={() => onWhy(it.decisionId!)}
                      className="chip rounded-full border border-line px-2 py-0.5 text-[10px] font-extrabold text-brandblue"
                    >
                      {t("Why this move?")}
                    </button>
                  )}
                  {it.vendorId && (it.kind === "sent" || it.kind === "reply" || it.kind === "alert") && (
                    <button
                      onClick={() => onTranscript(it.vendorId!, it.vendorName ?? t("Rental shop"))}
                      className="chip rounded-full border border-line px-2 py-0.5 text-[10px] font-extrabold text-soft"
                    >
                      {t("Full conversation")}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
