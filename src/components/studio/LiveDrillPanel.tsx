"use client";

// LIVE DRILL: rehearse the whole pipeline against a REAL WhatsApp number -
// a friend plays the rental shop. The opener leaves through the exact
// production path (profiler -> varied opener -> localization -> anti-ban
// guard -> your own WhatsApp) and every reply the "shop" sends runs through
// the real webhook + agents. The transcript below is the live thread.

import { useEffect, useRef, useState } from "react";
import { LoadingDots } from "../LoadingDots";
import { digitsOnly } from "@/lib/phone";

interface ThreadMsg {
  id: string;
  dir: "in" | "out";
  text: string;
  english?: string;
  kind?: string;
  at: string;
}

export function LiveDrillPanel() {
  const [name, setName] = useState("Drill Shop");
  const [phone, setPhone] = useState("");
  const [text, setText] = useState("A 125cc automatic scooter for 3 days near Kata Beach, Phuket");
  const [region, setRegion] = useState("Phuket, Thailand");
  const [localLang, setLocalLang] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<ThreadMsg[]>([]);
  const poll = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => () => clearInterval(poll.current), []);

  async function start() {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/admin/drill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, phone, text, region, localLang }),
      });
      const d = await res.json();
      if (d.sent || d.queued) {
        setVendorId(d.vendorId);
        setNote(
          d.sent
            ? "Opener sent from YOUR WhatsApp. Ask your friend to reply - the real agents take it from there."
            : "Opener queued by the pacing engine - it sends in a moment."
        );
        clearInterval(poll.current);
        poll.current = setInterval(refresh, 5000);
        setTimeout(refresh, 800);
      } else {
        setNote(d.error ?? "Could not start the drill.");
      }
    } catch {
      setNote("Request failed - check your connection.");
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    if (!vendorIdRef.current) return;
    try {
      const d = await (
        await fetch(`/api/thread?vendorId=${encodeURIComponent(vendorIdRef.current)}&full=1`)
      ).json();
      if (Array.isArray(d.messages)) setMsgs(d.messages);
    } catch {
      /* next poll */
    }
  }
  // Ref mirror so the interval sees the latest vendorId.
  const vendorIdRef = useRef<string | null>(null);
  useEffect(() => {
    vendorIdRef.current = vendorId;
  }, [vendorId]);

  return (
    <div className="space-y-3">
      <div className="rounded-2xl bg-brandblue-soft p-2.5 text-[12px] font-bold text-brandblue">
        Rehearse for real: enter a friend&apos;s WhatsApp number - they play the rental shop. The
        opener sends from YOUR WhatsApp through the full production pipeline, and their replies run
        through the real agents. Live transcript below.
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-[11px] font-bold text-soft">
          &quot;Shop&quot; name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded-xl border-2 border-line bg-card p-2 text-[16px] text-strong"
          />
        </label>
        <label className="block text-[11px] font-bold text-soft">
          Friend&apos;s WhatsApp number (with country code)
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            inputMode="tel"
            placeholder="+66 81 234 5678"
            className="mt-1 w-full rounded-xl border-2 border-line bg-card p-2 text-[16px] text-strong"
          />
        </label>
      </div>
      <label className="block text-[11px] font-bold text-soft">
        The rental request (the profiler structures it, like a real search)
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          className="mt-1 w-full rounded-xl border-2 border-line bg-card p-2 text-[13px] text-strong"
        />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <label className="block flex-1 text-[11px] font-bold text-soft">
          Region (drives localization + currency)
          <input
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            className="mt-1 w-full rounded-xl border-2 border-line bg-card p-2 text-[16px] text-strong"
          />
        </label>
        <label className="flex items-center gap-2 pt-4 text-[12px] font-bold text-soft">
          <input
            type="checkbox"
            checked={localLang}
            onChange={(e) => setLocalLang(e.target.checked)}
            className="h-4 w-4 accent-[var(--blue)]"
          />
          Local language
        </label>
      </div>

      <button
        onClick={start}
        disabled={busy || digitsOnly(phone).length < 7}
        className="btn btn-primary w-full rounded-2xl py-3 text-sm font-bold disabled:opacity-50"
      >
        {busy ? <LoadingDots light label="Starting the drill" /> : "▶️ Start the live drill"}
      </button>

      {note && (
        <div className="rounded-xl bg-card2 p-2 text-[12px] font-bold text-soft">{note}</div>
      )}

      {vendorId && (
        <div className="rounded-2xl border border-line bg-card2 p-2.5">
          <div className="mb-1.5 flex items-center justify-between text-[11px] font-extrabold text-strong">
            Live thread (refreshes every 5s)
            <button onClick={refresh} className="chip rounded-full border border-line px-2 py-0.5 text-[10px] font-bold text-brandblue">
              ↻ Refresh now
            </button>
          </div>
          {msgs.length === 0 ? (
            <p className="py-3 text-center text-[12px] text-faint">
              Waiting for the thread... your friend&apos;s replies appear here.
            </p>
          ) : (
            <div className="max-h-[46vh] space-y-1.5 overflow-y-auto">
              {msgs.map((m) => (
                <div
                  key={m.id}
                  className={`max-w-[88%] rounded-xl px-2.5 py-1.5 text-[13px] ${
                    m.dir === "out"
                      ? "ml-auto bg-brandblue text-white"
                      : "mr-auto bg-card text-strong"
                  }`}
                >
                  <span className="mb-0.5 block text-[9px] font-extrabold uppercase opacity-60">
                    {m.dir === "out" ? (m.kind === "human-manual" ? "You (manual)" : "Your agent") : "Shop (your friend)"}
                  </span>
                  {m.text}
                  {m.english && m.dir === "out" && (
                    <span className="mt-1 block rounded-lg bg-white/15 p-1 text-[10px] font-bold">
                      🌐 {m.english}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
