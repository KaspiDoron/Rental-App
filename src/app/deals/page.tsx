"use client";

// "My deals" hub: everything with money on the table in one place - confirmed
// bookings, open offers your agents negotiated, and honest staleness flags.
// Bookings used to hide inside Profile; travellers need to find their active
// deals in one tap.

import { useEffect, useState } from "react";
import { BrandMark } from "@/components/BrandMark";
import { Icon } from "@/components/icons";
import { LanguageButton } from "@/components/LanguageButton";
import { SiteFooter } from "@/components/SiteFooter";
import { SkeletonCard } from "@/components/Skeleton";
import { TabBar } from "@/components/TabBar";
import { FeedbackModal } from "@/components/FeedbackModal";
import { UpgradeSheet } from "@/components/UpgradeSheet";
import { startNav } from "@/components/NavVeil";
import { moneyLocal } from "@/lib/currency";
import { useI18n } from "@/lib/i18n";

interface Booking {
  id?: number;
  vendor_name: string;
  price_per_day: number;
  total_price: number;
  currency?: string | null;
  fulfillment: string;
  scheduled_at: string | null;
  status: string;
  created_at: string;
}

interface OpenOffer {
  vendorId: string;
  vendorName: string;
  pricePerDay: number;
  currency: string;
  round: number;
  verified: boolean;
  fulfillment: string | null;
  durationDays: number | null;
  at: string;
  stale: boolean;
}

export default function DealsPage() {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [offers, setOffers] = useState<OpenOffer[]>([]);
  const [email, setEmail] = useState<string | undefined>();
  const [plan, setPlan] = useState<string>("free");
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (!d.session) {
          window.location.href = "/login";
          return;
        }
        setEmail(d.session.email);
        setPlan(d.session.plan ?? "free");
      })
      .catch(() => {});
    fetch("/api/deals", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        setBookings(d.bookings ?? []);
        setOffers(d.offers ?? []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const fulfillmentLabel = (f: string | null | undefined) =>
    f === "delivery" || f === "hotel-delivery"
      ? t("Delivered to you")
      : f === "pickup"
      ? t("Shop picks you up")
      : f === "on-shop" || f === "in-store"
      ? t("Pick up at the shop")
      : null;

  return (
    <main className="mx-auto min-h-[100dvh] max-w-md pb-32 sm:max-w-lg md:max-w-2xl">
      <div className="topbar">
        <div className="mx-auto flex max-w-md items-center justify-between px-4 pb-2.5 sm:max-w-lg md:max-w-2xl">
          <div className="flex items-center gap-2">
            <BrandMark size={30} />
            <h1 className="font-display text-lg font-extrabold text-strong">{t("My deals")}</h1>
          </div>
          <div className="flex items-center gap-1.5">
            <LanguageButton />
            <a href="/" className="btn btn-sm btn-ghost rounded-xl px-3 py-1.5 text-[12px]">
              ← {t("Search")}
            </a>
          </div>
        </div>
      </div>

      <div className="space-y-4 px-4 pt-4">
        {loading && (
          <>
            <SkeletonCard lines={2} />
            <SkeletonCard lines={3} />
          </>
        )}

        {!loading && (
          <>
            {/* Confirmed bookings */}
            <section className="rise-in">
              <div className="mb-2 flex items-center gap-1.5 text-[13px] font-extrabold text-strong">
                <Icon name="check" className="h-4 w-4 text-savings" /> {t("Booked")}
              </div>
              {bookings.length === 0 ? (
                <div className="surface rounded-blob p-4 text-[12px] text-soft">
                  {t("Nothing booked yet - lock a deal and it lands here.")}
                </div>
              ) : (
                <div className="space-y-2.5">
                  {bookings.map((b, i) => (
                    <div key={b.id ?? i} className="surface rounded-blob p-3.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-[14px] font-extrabold text-strong">
                            {b.vendor_name}
                          </div>
                          <div className="mt-0.5 text-[11px] text-soft">
                            {b.scheduled_at
                              ? `${t("Pick-up")}: ${b.scheduled_at.replace("T", " · ")}`
                              : t("Pick-up time agreed in chat")}
                          </div>
                          {fulfillmentLabel(b.fulfillment) && (
                            <div className="mt-0.5 text-[11px] font-bold text-soft">
                              {fulfillmentLabel(b.fulfillment)}
                            </div>
                          )}
                        </div>
                        <div className="text-right">
                          <div className="text-[15px] font-extrabold text-strong">
                            {moneyLocal(b.total_price, b.currency ?? "USD")}
                          </div>
                          <div className="text-[10px] font-bold text-faint">
                            {moneyLocal(b.price_per_day, b.currency ?? "USD")}/{t("day")}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Open negotiated offers */}
            <section className="rise-in">
              <div className="mb-2 flex items-center gap-1.5 text-[13px] font-extrabold text-strong">
                <Icon name="money" className="h-4 w-4 text-brandblue" /> {t("Deals on the table")}
              </div>
              {offers.length === 0 ? (
                <div className="surface rounded-blob p-5 text-center">
                  <div className="mx-auto mb-2 w-fit float-soft">
                    <BrandMark size={52} />
                  </div>
                  <div className="text-[13px] font-extrabold text-strong">
                    {t("No open offers right now")}
                  </div>
                  <p className="mx-auto mt-1 max-w-[280px] text-[12px] text-soft">
                    {t("Start a search and your agents will bring negotiated prices straight here.")}
                  </p>
                  <a
                    href="/"
                    onClick={() => startNav()}
                    className="btn btn-primary mt-3 inline-block rounded-2xl px-5 py-2.5 text-[13px]"
                  >
                    {t("Find my deal")}
                  </a>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {offers.map((o) => (
                    <div key={o.vendorId + o.at} className="surface rounded-blob p-3.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-[14px] font-extrabold text-strong">
                            {o.vendorName}
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5">
                            {o.verified ? (
                              <span className="rounded-full bg-savings-soft px-2 py-0.5 text-[10px] font-extrabold text-savings">
                                {t("Confirmed by the shop")}
                              </span>
                            ) : (
                              <span className="rounded-full bg-card2 px-2 py-0.5 text-[10px] font-extrabold text-faint">
                                {t("Unconfirmed")}
                              </span>
                            )}
                            {o.round > 0 && (
                              <span className="rounded-full bg-brandblue-soft px-2 py-0.5 text-[10px] font-extrabold text-brandblue">
                                {t("After")} {o.round}{" "}
                                {o.round === 1 ? t("bargaining round") : t("bargaining rounds")}
                              </span>
                            )}
                            {fulfillmentLabel(o.fulfillment) && (
                              <span className="rounded-full bg-card2 px-2 py-0.5 text-[10px] font-extrabold text-soft">
                                {fulfillmentLabel(o.fulfillment)}
                              </span>
                            )}
                          </div>
                          {o.stale && (
                            <div className="mt-1.5 flex items-center gap-1 text-[11px] font-bold text-[#8a6100] dark:text-brandyellow">
                              <Icon name="clock" className="h-3.5 w-3.5" />
                              {t("Quoted over a day ago - worth re-confirming before you rely on it.")}
                            </div>
                          )}
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-[16px] font-extrabold text-strong">
                            {moneyLocal(o.pricePerDay, o.currency)}
                          </div>
                          <div className="text-[10px] font-bold text-faint">/{t("day")}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <SiteFooter />
          </>
        )}
      </div>

      {feedbackOpen && <FeedbackModal email={email} onClose={() => setFeedbackOpen(false)} />}
      {upgradeOpen && <UpgradeSheet onClose={() => setUpgradeOpen(false)} />}

      <TabBar
        active="deals"
        onSelect={(tab) => {
          if (tab === "home") window.location.href = "/";
          else if (tab === "profile") window.location.href = "/profile";
        }}
        onFeedback={() => setFeedbackOpen(true)}
        onUpgrade={() => setUpgradeOpen(true)}
        showUpgrade={!upgradeOpen && plan === "free"}
      />
    </main>
  );
}
