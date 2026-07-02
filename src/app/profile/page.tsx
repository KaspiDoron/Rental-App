"use client";

import { useEffect, useRef, useState } from "react";
import type { Session } from "@/lib/types";
import { Icon } from "@/components/icons";
import { BrandMark } from "@/components/BrandMark";

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
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<{ phone?: string; name?: string } | null>(null);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [prefs, setPrefs] = useState({ currency: "USD", homeCity: "", ride: "scooter" });

  // Owner assistant chat
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState(false);
  const chatEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        if (!d.session) {
          window.location.href = "/login";
          return;
        }
        setSession(d.session);
        setProfile(d.profile);
      })
      .catch(() => {});
    fetch("/api/bookings")
      .then((r) => r.json())
      .then((d) => setBookings(d.bookings ?? []))
      .catch(() => {});
    try {
      const t = (localStorage.getItem("wd_theme") as "light" | "dark") || "light";
      setTheme(t);
      const p = localStorage.getItem("wd_prefs");
      if (p) setPrefs(JSON.parse(p));
    } catch {}
  }, []);

  function switchTheme(t: "light" | "dark") {
    setTheme(t);
    document.documentElement.setAttribute("data-theme", t);
    try {
      localStorage.setItem("wd_theme", t);
    } catch {}
  }

  function savePrefs(next: typeof prefs) {
    setPrefs(next);
    try {
      localStorage.setItem("wd_prefs", JSON.stringify(next));
    } catch {}
  }

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
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
    <main className="mx-auto min-h-[100dvh] max-w-md pb-32 sm:max-w-lg">
      {/* Section top bar (sits below the phone status bar - never under it) */}
      <div className="topbar">
        <div className="flex items-center justify-between px-4 pb-2.5">
          <div className="flex items-center gap-2">
            <BrandMark size={30} />
            <h1 className="font-display text-lg font-extrabold text-strong">Profile</h1>
          </div>
          <a href="/" className="btn btn-sm btn-ghost rounded-xl px-3 py-1.5 text-[12px]">
            ← Search
          </a>
        </div>
      </div>

      <div className="space-y-4 px-4 pt-4">
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
              {profile?.phone && (
                <div className="text-[12px] text-faint">{profile.phone}</div>
              )}
            </div>
            <span
              className={`ml-auto shrink-0 rounded-full px-2.5 py-1 text-[10px] font-extrabold ${
                isOwner
                  ? "bg-brandyellow text-[#4a3300]"
                  : isMgmt
                  ? "bg-brandblue text-white"
                  : "bg-savings-soft text-savings"
              }`}
            >
              {isOwner ? "OWNER" : isMgmt ? "ADMIN" : "TRAVELLER"}
            </span>
          </div>
        </section>

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
                <button
                  onClick={() => ask()}
                  disabled={thinking}
                  className="btn btn-sm w-full rounded-xl bg-brandyellow-soft py-2.5 text-[13px] font-extrabold text-[#8a6100] dark:text-brandyellow"
                >
                  {thinking ? "Analysing the business..." : "Brief me - what needs my attention?"}
                </button>
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
                <div className="mr-6 rounded-2xl bg-card p-2.5 text-[13px] text-faint">
                  thinking...
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
              <Icon name="shield" className="h-5 w-5 text-brandblue" /> Management workspace
            </span>
            <Icon name="chevron" className="h-4 w-4 text-faint" />
          </a>
        )}

        {/* Appearance */}
        <section className="surface rounded-blob p-4">
          <div className="mb-2 text-[13px] font-extrabold text-strong">Appearance</div>
          <div className="grid grid-cols-2 gap-2">
            {(["light", "dark"] as const).map((t) => (
              <button
                key={t}
                onClick={() => switchTheme(t)}
                className={`btn chip rounded-2xl border-2 p-3 text-sm font-extrabold capitalize ${
                  theme === t
                    ? "border-brandblue bg-brandblue-soft text-brandblue"
                    : "border-line text-soft"
                }`}
              >
                {t === "light" ? "☀️ Light" : "🌙 Dark"}
              </button>
            ))}
          </div>
        </section>

        {/* Travel preferences */}
        <section className="surface rounded-blob p-4">
          <div className="mb-2 text-[13px] font-extrabold text-strong">Travel preferences</div>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-[11px] font-bold text-faint">
              Currency
              <select
                value={prefs.currency}
                onChange={(e) => savePrefs({ ...prefs, currency: e.target.value })}
                className="mt-1 w-full rounded-xl border-2 border-line bg-card p-2.5 text-sm font-bold text-strong"
              >
                {["USD", "EUR", "GBP", "IDR", "THB", "ILS"].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label className="text-[11px] font-bold text-faint">
              Favourite ride
              <select
                value={prefs.ride}
                onChange={(e) => savePrefs({ ...prefs, ride: e.target.value })}
                className="mt-1 w-full rounded-xl border-2 border-line bg-card p-2.5 text-sm font-bold text-strong"
              >
                <option value="scooter">Automatic scooter</option>
                <option value="motorbike">Manual motorcycle</option>
                <option value="car">Car</option>
              </select>
            </label>
          </div>
          <label className="mt-2 block text-[11px] font-bold text-faint">
            Home city
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
          <div className="mb-2 text-[13px] font-extrabold text-strong">My bookings</div>
          {bookings.length === 0 ? (
            <p className="text-[12px] text-faint">
              No bookings yet - lock your first deal and it will show up here.
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

        <button onClick={signOut} className="btn btn-danger w-full rounded-2xl py-3 text-sm">
          Sign out
        </button>
      </div>
    </main>
  );
}
