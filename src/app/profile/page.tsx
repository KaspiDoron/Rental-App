"use client";

import { useEffect, useRef, useState } from "react";
import type { Session } from "@/lib/types";
import { Icon } from "@/components/icons";
import { BrandMark } from "@/components/BrandMark";
import { PasswordInput } from "@/components/PasswordInput";
import { LoadingDots } from "@/components/LoadingDots";
import { Skeleton, SkeletonCard } from "@/components/Skeleton";
import { LanguageButton } from "@/components/LanguageButton";
import { CountryPhoneInput } from "@/components/CountryPhoneInput";
import { WaConnect } from "@/components/WaConnect";
import { AdBanner } from "@/components/AdBanner";
import { CURRENCIES, setSavedCurrency } from "@/lib/currency";
import { useI18n } from "@/lib/i18n";

interface Booking {
  vendor_name: string;
  price_per_day: number;
  total_price: number;
  fulfillment: string;
  scheduled_at: string | null;
  status: string;
  created_at: string;
}

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

export default function ProfilePage() {
  const { t } = useI18n();
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<{ phone?: string; name?: string } | null>(null);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [prefs, setPrefs] = useState({ currency: "USD", homeCity: "", ride: "scooter" });
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNext, setPwNext] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [mustChangePw, setMustChangePw] = useState(false);

  // Phone editing (mirrored to the database + used by WhatsApp threads).
  const [phoneEdit, setPhoneEdit] = useState(false);
  const [phoneVal, setPhoneVal] = useState("");
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [phoneMsg, setPhoneMsg] = useState<string | null>(null);

  // Personal WhatsApp session state (rendered by <WaConnect/>).
  const [wa, setWa] = useState<{
    available: boolean;
    connected: boolean;
    state?: string;
  } | null>(null);

  // Owner brand/social
  const [twitter, setTwitter] = useState("");
  const [twitterBusy, setTwitterBusy] = useState(false);
  const [twitterMsg, setTwitterMsg] = useState<string | null>(null);

  // Owner assistant chat
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState(false);
  const chatEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (!d.session) {
          window.location.href = "/login";
          return;
        }
        setSession(d.session);
        setProfile(d.profile);
        setPhoneVal(d.profile?.phone ?? "");
        const urlPw = new URLSearchParams(window.location.search).get("pw") === "1";
        if (d.profile?.mustChangePassword || urlPw) setMustChangePw(true);
      })
      .catch(() => {});
    fetch("/api/bookings")
      .then((r) => r.json())
      .then((d) => setBookings(d.bookings ?? []))
      .catch(() => {});
    fetch("/api/wa/status")
      .then((r) => r.json())
      .then((d) => setWa(d))
      .catch(() => {});
    // Load the saved X handle (owner brand card).
    fetch("/api/admin/config?reveal=1")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const row = d?.values?.find((v: any) => v.name === "TWITTER_HANDLE");
        if (row?.value) setTwitter(row.value);
      })
      .catch(() => {});
    try {
      const t2 = (localStorage.getItem("wd_theme") as "light" | "dark") || "light";
      setTheme(t2);
      const p = localStorage.getItem("wd_prefs");
      if (p) setPrefs(JSON.parse(p));
    } catch {}
  }, []);

  function switchTheme(t2: "light" | "dark") {
    setTheme(t2);
    document.documentElement.setAttribute("data-theme", t2);
    try {
      localStorage.setItem("wd_theme", t2);
    } catch {}
  }

  function savePrefs(next: typeof prefs) {
    setPrefs(next);
    try {
      localStorage.setItem("wd_prefs", JSON.stringify(next));
    } catch {}
  }

  async function signOut() {
    const { startNav } = await import("@/components/NavVeil");
    startNav();
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  async function savePhone() {
    setPhoneBusy(true);
    setPhoneMsg(null);
    try {
      const res = await fetch("/api/profile/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: phoneVal }),
      });
      const d = await res.json();
      if (res.ok) {
        setProfile((p) => ({ ...p, phone: d.profile.phone ?? undefined }));
        setPhoneEdit(false);
        setPhoneMsg(t("Phone updated everywhere") + " ✓");
      } else {
        setPhoneMsg(d.error ?? t("Could not update."));
      }
    } finally {
      setPhoneBusy(false);
    }
  }

  async function saveTwitter() {
    setTwitterBusy(true);
    setTwitterMsg(null);
    try {
      const res = await fetch("/api/admin/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "TWITTER_HANDLE", value: twitter.trim() }),
      });
      if (res.ok) setTwitterMsg("Saved - redeploy to refresh share cards. ✓");
      else setTwitterMsg("Could not save.");
    } finally {
      setTwitterBusy(false);
    }
  }

  async function ask(text?: string) {
    const content = (text ?? draft).trim();
    if (!content && chat.length > 0) return;
    const next: ChatMsg[] = content ? [...chat, { role: "user", content }] : chat;
    setChat(next);
    setDraft("");
    setThinking(true);
    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });
      const data = await res.json();
      setChat([...next, { role: "assistant", content: data.reply ?? data.error ?? "..." }]);
      setTimeout(() => chatEnd.current?.scrollIntoView({ behavior: "smooth" }), 50);
    } finally {
      setThinking(false);
    }
  }

  const isOwner = session?.role === "owner";
  const isMgmt = session && session.role !== "user";

  return (
    <main className="mx-auto min-h-[100dvh] max-w-md pb-32 sm:max-w-lg md:max-w-2xl">
      <div className="topbar">
        <div className="mx-auto flex max-w-md items-center justify-between px-4 pb-2.5 sm:max-w-lg md:max-w-2xl">
          <div className="flex items-center gap-2">
            <BrandMark size={30} />
            <h1 className="font-display text-lg font-extrabold text-strong">{t("Profile")}</h1>
          </div>
          <div className="flex items-center gap-1.5">
            <LanguageButton />
            <a href="/" className="btn btn-sm btn-ghost rounded-xl px-3 py-1.5 text-[12px]">
              ← {t("Search")}
            </a>
          </div>
        </div>
      </div>

      {!session && (
        <div className="space-y-4 px-4 pt-4" role="status" aria-label="Loading profile">
          <section className="surface rounded-blob p-4">
            <div className="flex items-center gap-3">
              <Skeleton rounded="rounded-full" className="h-14 w-14" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            </div>
          </section>
          <SkeletonCard lines={2} />
          <SkeletonCard lines={3} />
        </div>
      )}

      <div className={`rise-in space-y-4 px-4 pt-4 ${!session ? "hidden" : ""}`}>
        {/* Identity card */}
        <section className="surface rounded-blob p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brandblue text-xl font-extrabold text-white">
              {(profile?.name || session?.email || "?").slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0">
              <div className="truncate text-[16px] font-extrabold text-strong">
                {profile?.name || session?.email}
              </div>
              <div className="truncate text-[12px] text-soft">{session?.email}</div>
              {!phoneEdit ? (
                <button
                  onClick={() => setPhoneEdit(true)}
                  className="chip text-[12px] font-bold text-brandblue underline decoration-dotted"
                >
                  {profile?.phone || t("Add phone number")} ✎
                </button>
              ) : null}
            </div>
            <span
              className={`ml-auto shrink-0 rounded-full px-2.5 py-1 text-[10px] font-extrabold ${
                isOwner
                  ? "bg-brandyellow text-[#4a3300]"
                  : isMgmt
                  ? "badge-ultra"
                  : session?.plan === "ultra"
                  ? "badge-ultra"
                  : "bg-savings-soft text-savings"
              }`}
            >
              {isOwner
                ? "OWNER"
                : isMgmt
                ? "ADMIN · ULTRA"
                : (session?.plan ?? "free").toUpperCase()}
            </span>
          </div>
          {phoneEdit && (
            <div className="mt-3">
              <label className="text-[11px] font-bold text-faint">{t("Phone number")}</label>
              <div className="mt-1">
                <CountryPhoneInput value={phoneVal} onChange={setPhoneVal} />
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={savePhone}
                  disabled={phoneBusy}
                  className="btn btn-primary btn-sm flex-1 rounded-xl text-[12px] disabled:opacity-60"
                >
                  {phoneBusy ? <LoadingDots light label={t("Saving")} /> : t("Save phone")}
                </button>
                <button
                  onClick={() => setPhoneEdit(false)}
                  className="btn btn-ghost btn-sm flex-1 rounded-xl text-[12px]"
                >
                  {t("Cancel")}
                </button>
              </div>
              <p className="mt-1.5 text-[10px] text-faint">
                {t("Updated everywhere we use it. Your WhatsApp connection below is tied to the phone that scans the QR - reconnect it if you switch numbers.")}
              </p>
            </div>
          )}
          {phoneMsg && (
            <p className="mt-2 text-[12px] font-bold text-savings">{phoneMsg}</p>
          )}
        </section>

        {/* Personal WhatsApp connection (Evolution API QR session) */}
        <section className="surface rounded-blob p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-1.5 text-[13px] font-extrabold text-strong">
                💬 {t("Your WhatsApp")}
                <span className="badge-flash rounded-full px-2 py-0.5 text-[9px] font-extrabold">
                  {t("Authentic bargaining")}
                </span>
              </div>
              <p className="mt-0.5 text-[11px] text-faint">
                {t("Connect your own number so agents bargain as YOU - shops see a real traveller, and every reply lands in the app automatically.")}
              </p>
            </div>
            <span
              className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-extrabold ${
                wa?.connected
                  ? "bg-savings-soft text-savings"
                  : "bg-card2 text-faint"
              }`}
            >
              {wa?.connected ? t("CONNECTED") : t("NOT CONNECTED")}
            </span>
          </div>

          <div className="mt-3">
            <WaConnect phone={profile?.phone} />
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-faint">
            {t("Human-pace sending limits apply automatically to keep your number safe. Details are in the Terms of Use.")}
          </p>
        </section>

        {/* Owner brand kit + social */}
        {isOwner && (
          <section className="surface rounded-blob p-4">
            <div className="mb-2 text-[13px] font-extrabold text-strong">🎨 Brand kit & social</div>
            <div className="grid grid-cols-2 gap-2">
              <a
                href="/api/brand/banner"
                download="wheeldeal-x-banner.png"
                className="btn btn-ghost rounded-2xl py-2.5 text-center text-[12px] font-extrabold"
              >
                ⬇ X banner (1500x500)
              </a>
              <a
                href="/apple-icon"
                download="wheeldeal-logo.png"
                className="btn btn-ghost rounded-2xl py-2.5 text-center text-[12px] font-extrabold"
              >
                ⬇ Logo (512)
              </a>
              <a
                href="/opengraph-image"
                download="wheeldeal-social.png"
                className="btn btn-ghost rounded-2xl py-2.5 text-center text-[12px] font-extrabold"
              >
                ⬇ Social card
              </a>
              <a
                href="/api/brand/banner"
                target="_blank"
                rel="noreferrer"
                className="btn btn-ghost rounded-2xl py-2.5 text-center text-[12px] font-extrabold"
              >
                👁 Preview banner
              </a>
            </div>
            <label className="mt-3 block text-[11px] font-bold text-faint">
              X (Twitter) handle - shown in share cards
              <div className="mt-1 flex gap-2">
                <input
                  value={twitter}
                  onChange={(e) => setTwitter(e.target.value)}
                  placeholder="@wheeldeal"
                  className="flex-1 rounded-xl border-2 border-line bg-card p-2.5 text-sm text-strong placeholder:text-faint focus:border-brandblue focus:outline-none"
                />
                <button
                  onClick={saveTwitter}
                  disabled={twitterBusy}
                  className="btn btn-primary btn-sm rounded-xl px-3 text-[12px] disabled:opacity-60"
                >
                  {twitterBusy ? <LoadingDots light /> : "Save"}
                </button>
              </div>
            </label>
            {twitterMsg && <p className="mt-1 text-[11px] font-bold text-savings">{twitterMsg}</p>}
          </section>
        )}

        {/* Owner AI co-manager */}
        {isOwner && (
          <section className="surface rounded-blob border-2 !border-brandyellow p-4">
            <div className="mb-2 flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-brandyellow text-base">
                🧠
              </span>
              <div>
                <div className="text-[15px] font-extrabold text-strong">
                  Deals - your AI co-manager
                </div>
                <div className="text-[11px] text-faint">
                  Sees all agent memory, users, feedback & bookings
                </div>
              </div>
            </div>
            <div className="max-h-72 space-y-2 overflow-y-auto rounded-2xl bg-card2 p-3">
              {chat.length === 0 && (
                <>
                  <button
                    onClick={() => ask()}
                    disabled={thinking}
                    className="btn btn-sm w-full rounded-xl bg-brandyellow-soft py-2.5 text-[13px] font-extrabold text-[#8a6100] dark:text-brandyellow"
                  >
                    {thinking ? (
                      <LoadingDots label="Analysing the business" />
                    ) : (
                      "Brief me - what needs my attention?"
                    )}
                  </button>
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      "Top issue right now?",
                      "How are signups trending?",
                      "Which shops convert best?",
                      "Any API about to run out?",
                    ].map((q) => (
                      <button
                        key={q}
                        onClick={() => ask(q)}
                        disabled={thinking}
                        className="chip rounded-full border border-line bg-card px-2.5 py-1 text-[11px] font-bold text-soft hover:border-brandblue hover:text-brandblue"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </>
              )}
              {chat.map((m, i) => (
                <div
                  key={i}
                  className={`whitespace-pre-wrap rounded-2xl p-2.5 text-[13px] leading-relaxed ${
                    m.role === "user"
                      ? "ml-6 bg-brandblue text-white"
                      : "mr-6 bg-card text-soft"
                  }`}
                >
                  {m.content}
                </div>
              ))}
              {thinking && chat.length > 0 && (
                <div className="mr-6 rounded-2xl bg-card p-2.5">
                  <LoadingDots label="thinking" />
                </div>
              )}
              <div ref={chatEnd} />
            </div>
            <div className="mt-2 flex gap-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && ask()}
                placeholder="Ask Deals anything about the business..."
                className="w-full rounded-2xl border-2 border-line bg-card px-3 py-2.5 text-sm text-strong placeholder:text-faint focus:border-brandblue focus:outline-none"
              />
              <button
                onClick={() => ask()}
                disabled={thinking || !draft.trim()}
                className="btn btn-primary rounded-2xl px-4 disabled:opacity-50"
                aria-label="Send"
              >
                <Icon name="send" className="h-4 w-4" />
              </button>
            </div>
          </section>
        )}

        {/* Management shortcut */}
        {isMgmt && (
          <a
            href="/admin"
            className="btn surface flex items-center justify-between rounded-blob p-4"
          >
            <span className="flex items-center gap-2 text-[14px] font-extrabold text-strong">
              <Icon name="shield" className="h-5 w-5 text-brandblue" /> {t("Management workspace")}
            </span>
            <Icon name="chevron" className="h-4 w-4 text-faint" />
          </a>
        )}

        {/* Password */}
        <section
          className={`surface rounded-blob p-4 ${
            mustChangePw ? "border-2 !border-brandred" : ""
          }`}
        >
          <div className="mb-2 text-[13px] font-extrabold text-strong">
            {mustChangePw ? `⚠️ ${t("Change your temporary password now")}` : t("Change password")}
          </div>
          {mustChangePw && (
            <p className="mb-2 rounded-2xl bg-brandred-soft p-2.5 text-[12px] font-bold text-brandred">
              {t("You logged in with a temporary password. Set a new one before doing anything else.")}
            </p>
          )}
          {!mustChangePw && (
            <div className="mb-2">
              <PasswordInput
                value={pwCurrent}
                onChange={setPwCurrent}
                autoComplete="current-password"
                placeholder={t("Current password")}
              />
            </div>
          )}
          <PasswordInput
            value={pwNext}
            onChange={setPwNext}
            autoComplete="new-password"
            placeholder={t("New password (6+ characters)")}
          />
          {pwMsg && (
            <p
              className={`mt-2 text-[12px] font-bold ${
                pwMsg.ok ? "text-savings" : "text-brandred"
              }`}
            >
              {pwMsg.text}
            </p>
          )}
          <button
            onClick={async () => {
              setPwMsg(null);
              setPwBusy(true);
              try {
                const res = await fetch("/api/auth/password", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ current: pwCurrent, next: pwNext }),
                });
                const d = await res.json();
                if (res.ok) {
                  setPwMsg({ ok: true, text: t("Password updated - use it on your next login.") + " ✓" });
                  setPwCurrent("");
                  setPwNext("");
                  setMustChangePw(false);
                } else {
                  setPwMsg({ ok: false, text: d.error ?? t("Could not update.") });
                }
              } finally {
                setPwBusy(false);
              }
            }}
            disabled={pwNext.length < 6 || pwBusy}
            className="btn btn-primary mt-2 w-full rounded-2xl py-2.5 text-sm disabled:opacity-60"
          >
            {pwBusy ? <LoadingDots light label={t("Saving")} /> : t("Update password")}
          </button>
        </section>

        {/* Appearance */}
        <section className="surface rounded-blob p-4">
          <div className="mb-2 text-[13px] font-extrabold text-strong">{t("Appearance")}</div>
          <div className="grid grid-cols-2 gap-2">
            {(["light", "dark"] as const).map((t2) => (
              <button
                key={t2}
                onClick={() => switchTheme(t2)}
                className={`btn chip rounded-2xl border-2 p-3 text-sm font-extrabold capitalize ${
                  theme === t2
                    ? "border-brandblue bg-brandblue-soft text-brandblue"
                    : "border-line text-soft"
                }`}
              >
                {t2 === "light" ? `☀️ ${t("Light")}` : `🌙 ${t("Dark")}`}
              </button>
            ))}
          </div>
        </section>

        {/* Travel preferences */}
        <section className="surface rounded-blob p-4">
          <div className="mb-2 text-[13px] font-extrabold text-strong">{t("Travel preferences")}</div>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[11px] font-bold text-faint">
              {t("Currency")}
              <select
                value={prefs.currency}
                onChange={(e) => {
                  savePrefs({ ...prefs, currency: e.target.value });
                  setSavedCurrency(e.target.value);
                }}
                className="mt-1 w-full rounded-xl border-2 border-line bg-card p-2.5 text-sm font-bold text-strong"
              >
                {CURRENCIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.flag} {c.code}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[11px] font-bold text-faint">
              {t("Favourite ride")}
              <select
                value={prefs.ride}
                onChange={(e) => savePrefs({ ...prefs, ride: e.target.value })}
                className="mt-1 w-full rounded-xl border-2 border-line bg-card p-2.5 text-sm font-bold text-strong"
              >
                <option value="scooter">{t("Automatic scooter")}</option>
                <option value="motorbike">{t("Manual motorcycle")}</option>
                <option value="car">{t("Car")}</option>
              </select>
            </label>
          </div>
          <label className="mt-2 block text-[11px] font-bold text-faint">
            {t("Home city")}
            <input
              value={prefs.homeCity}
              onChange={(e) => savePrefs({ ...prefs, homeCity: e.target.value })}
              placeholder="e.g. Tel Aviv"
              className="mt-1 w-full rounded-xl border-2 border-line bg-card p-2.5 text-sm text-strong placeholder:text-faint focus:border-brandblue focus:outline-none"
            />
          </label>
        </section>

        {/* Booking history */}
        <section className="surface rounded-blob p-4">
          <div className="mb-2 text-[13px] font-extrabold text-strong">{t("My bookings")}</div>
          {bookings.length === 0 ? (
            <p className="text-[12px] text-faint">
              {t("No bookings yet - lock your first deal and it will show up here.")}
            </p>
          ) : (
            <div className="space-y-2">
              {bookings.map((b, i) => (
                <div key={i} className="flex items-center justify-between rounded-2xl bg-card2 p-3">
                  <div>
                    <div className="text-[13px] font-extrabold text-strong">{b.vendor_name}</div>
                    <div className="text-[11px] text-faint">
                      {b.scheduled_at ? new Date(b.scheduled_at).toLocaleString() : ""} ·{" "}
                      {b.fulfillment}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[14px] font-extrabold text-strong">${b.total_price}</div>
                    <div className="text-[10px] font-bold uppercase text-savings">{b.status}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <AdBanner plan={session?.plan} />

        <button onClick={signOut} className="btn btn-danger w-full rounded-2xl py-3 text-sm">
          {t("Sign out")}
        </button>
      </div>
    </main>
  );
}
