"use client";

// Anchored welcome tour (item #11): instead of abstract slides, each step
// SPOTLIGHTS the real UI element it explains (search box, stay picker, radius,
// find button, live status, queue, shop cards...) with a tooltip card pinned
// next to it. Steps whose element is not on screen yet (offers appear only
// after a search) fall back to a centered card. Ends with the adaptive
// "add to Home Screen" guide. Next / Back / Skip; works from 320px up.

import { useEffect, useRef, useState } from "react";
import { BrandMark } from "./BrandMark";

interface Step {
  emoji: string;
  title: string;
  text: string;
  anchor?: string; // [data-tour="..."] to spotlight; none = centered card
}

const STEPS: Step[] = [
  {
    emoji: "👋",
    title: "Welcome to WheelDeal!",
    text: "Your AI agents find every rental shop around your stay and bargain for the cheapest real price - on your own WhatsApp. Here is exactly how to use it, step by step.",
  },
  {
    emoji: "💬",
    title: "1 · Say what you want",
    text: 'Type it like you would to a friend: "125cc scooter, 3 days" or "automatic SUV, 5 seats". No size in mind? The agents automatically go for the cheapest option.',
    anchor: "request",
  },
  {
    emoji: "✨",
    title: "2 · Or tap an example",
    text: "These chips are ready-made requests - tap one to fill the box instantly and tweak it.",
    anchor: "examples",
  },
  {
    emoji: "📍",
    title: "3 · Set your stay",
    text: "Search your hotel or tap 'Use my current location'. The moment an area is set you also see the honest local going rate - the same floor your agents bargain toward.",
    anchor: "stay",
  },
  {
    emoji: "📏",
    title: "4 · Pick the radius",
    text: "Agents only contact shops inside this circle around your stay. 8 km is a good default in most beach towns.",
    anchor: "radius",
  },
  {
    emoji: "⚡",
    title: "5 · Find my deal",
    text: "One tap: the agents structure your request, find every real shop nearby (live from Google Maps) and get ready to message them from YOUR WhatsApp.",
    anchor: "find",
  },
  {
    emoji: "📊",
    title: "6 · The live status bar",
    text: "After you search, a status strip appears here: how many shops were messaged, how many offers landed, and every message queued for later - tap it to expand the full detail.",
    anchor: "status",
  },
  {
    emoji: "🕘",
    title: "7 · Your queued messages",
    text: "Shops that are closed (or paced for your number's safety) wait in YOUR queue. You see exactly what is waiting, when it sends, and you can remove any of it.",
    anchor: "queue",
  },
  {
    emoji: "🏪",
    title: "8 · Every shop is a live card",
    text: "Each card tracks its own conversation: the pipeline (Messaged -> Awaiting -> Offer), the exact messages exchanged, verified shop facts, and the shop's real offer in its own currency.",
    anchor: "vendors",
  },
  {
    emoji: "🥊",
    title: "9 · Bargain and book",
    text: "When a price lands, your agent compares it to the real local floor and makes ONE friendly ask - it never pushes twice and never accepts for you. Happy? Tap Book and choose delivery or pickup.",
  },
  {
    emoji: "💬",
    title: "10 · Connect your WhatsApp",
    text: "Everything is sent from YOUR number so shops talk to a real traveller. Open Profile -> Your WhatsApp and link it with the pairing code - it takes 30 seconds.",
    anchor: "tab-profile",
  },
];

type OS = "ios" | "android";

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function Onboarding({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [osStep, setOsStep] = useState(false);
  const [os, setOs] = useState<OS>("ios");
  const [rect, setRect] = useState<Rect | null>(null);
  const measureTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    const ua = navigator.userAgent;
    setOs(/android/i.test(ua) ? "android" : "ios");
  }, []);

  // Measure the current step's anchor (after scrolling it into view). A step
  // whose element is missing (no search yet) renders as a centered card.
  useEffect(() => {
    if (osStep) {
      setRect(null);
      return;
    }
    const anchor = STEPS[step]?.anchor;
    const el = anchor
      ? (document.querySelector(`[data-tour="${anchor}"]`) as HTMLElement | null)
      : null;
    if (!el) {
      setRect(null);
      return;
    }
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) {
        setRect(null);
        return;
      }
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    clearTimeout(measureTimer.current);
    measureTimer.current = setTimeout(measure, 350); // after smooth scroll
    window.addEventListener("resize", measure);
    return () => {
      clearTimeout(measureTimer.current);
      window.removeEventListener("resize", measure);
    };
  }, [step, osStep]);

  function finish() {
    try {
      localStorage.setItem("wd_onboarded", "1");
    } catch {}
    onClose();
  }

  const s = STEPS[step];
  const spotlight = rect !== null;
  // Tooltip goes under the spotlight when there is room, else above it.
  const spaceBelow = spotlight ? window.innerHeight - (rect!.top + rect!.height) : 0;
  const tooltipBelow = spotlight && spaceBelow > 230;

  const card = (
    <div
      className={`surface-strong pointer-events-auto w-full max-w-md p-5 animate-slide-up ${
        spotlight ? "rounded-blob shadow-2xl" : "rounded-t-3xl pb-safe sm:rounded-blob"
      }`}
    >
      <div className={spotlight ? "mb-3" : "mb-4 text-center"}>
        {!spotlight && (
          <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-3xl bg-brandblue-soft text-3xl">
            {step === 0 ? <BrandMark size={44} /> : s.emoji}
          </div>
        )}
        <h2 className={`font-display font-extrabold text-strong ${spotlight ? "text-[16px]" : "text-xl"}`}>
          {spotlight ? `${s.emoji} ${s.title}` : s.title}
        </h2>
        <p className={`mt-1.5 text-[13px] leading-relaxed text-soft ${spotlight ? "" : "mx-auto max-w-[300px]"}`}>
          {s.text}
        </p>
      </div>

      <div className="mb-3 flex justify-center gap-1.5">
        {STEPS.map((_, i) => (
          <span
            key={i}
            className={`h-1.5 rounded-full transition-all ${i === step ? "w-5 bg-brandblue" : "w-1.5 bg-line"}`}
          />
        ))}
      </div>

      <div className="flex items-center gap-2">
        {step > 0 && (
          <button onClick={() => setStep(step - 1)} className="btn btn-ghost rounded-2xl px-4 py-2.5 text-sm">
            Back
          </button>
        )}
        <button
          onClick={() => (step < STEPS.length - 1 ? setStep(step + 1) : setOsStep(true))}
          className="btn btn-primary flex-1 rounded-2xl py-2.5 text-sm"
        >
          {step < STEPS.length - 1 ? "Next" : "One last thing..."}
        </button>
      </div>
      <button
        onClick={finish}
        className="btn mt-1.5 w-full py-1.5 text-center text-[12px] font-bold text-faint hover:text-soft"
      >
        Skip the tour
      </button>
    </div>
  );

  if (osStep) {
    return (
      <div className="fixed inset-0 z-[1300] flex items-end justify-center bg-black/55 backdrop-blur-sm sm:items-center">
        <div className="surface-strong w-full max-w-md rounded-t-3xl p-6 pb-safe sm:rounded-blob animate-slide-up">
          <div className="mb-3 text-center">
            <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-3xl bg-brandyellow-soft text-3xl">
              📲
            </div>
            <h2 className="font-display text-xl font-extrabold text-strong">Install WheelDeal like an app</h2>
            <p className="mt-1 text-[13px] text-soft">
              Add it to your Home Screen - it opens full-screen with its own icon, just like from the App Store.
            </p>
          </div>

          <div className="mb-3 grid grid-cols-2 gap-2">
            {(
              [
                { id: "ios", label: "🍎 iPhone / iPad" },
                { id: "android", label: "🤖 Android" },
              ] as { id: OS; label: string }[]
            ).map((o) => (
              <button
                key={o.id}
                onClick={() => setOs(o.id)}
                className={`btn chip rounded-2xl border-2 p-3 text-sm font-extrabold ${
                  os === o.id ? "border-brandblue bg-brandblue-soft text-brandblue" : "border-line text-soft"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>

          <ol className="space-y-2 rounded-2xl bg-card2 p-4 text-[13px] leading-relaxed text-soft">
            {os === "ios" ? (
              <>
                <li>1. Open this site in Safari.</li>
                <li>2. Tap the Share button (square with an up arrow).</li>
                <li>3. Scroll and tap &quot;Add to Home Screen&quot;.</li>
                <li>4. Tap &quot;Add&quot; - done! Launch it from your Home Screen.</li>
              </>
            ) : (
              <>
                <li>1. Open this site in Chrome.</li>
                <li>2. Tap the ⋮ menu (top right).</li>
                <li>3. Tap &quot;Add to Home screen&quot; (or &quot;Install app&quot;).</li>
                <li>4. Confirm - done! Launch it from your Home Screen.</li>
              </>
            )}
          </ol>
          <p className="mt-2 text-center text-[11px] text-faint">
            Menus can move slightly between OS updates - look for Share or Install in your browser menu.
          </p>

          <button onClick={finish} className="btn btn-primary mt-4 w-full rounded-2xl py-3 text-sm">
            Start saving 🎉
          </button>
        </div>
      </div>
    );
  }

  if (!spotlight) {
    return (
      <div className="fixed inset-0 z-[1300] flex items-end justify-center bg-black/55 backdrop-blur-sm sm:items-center">
        {card}
      </div>
    );
  }

  const pad = 6;
  return (
    <div className="pointer-events-none fixed inset-0 z-[1300]">
      {/* Spotlight hole: one div whose giant shadow dims everything around it */}
      <div
        className="absolute rounded-2xl border-2 border-brandblue transition-all duration-300"
        style={{
          top: rect!.top - pad,
          left: rect!.left - pad,
          width: rect!.width + pad * 2,
          height: rect!.height + pad * 2,
          boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
        }}
      />
      {/* Click-catcher so taps outside don't hit the page mid-tour */}
      <div className="pointer-events-auto absolute inset-0" onClick={() => {}} aria-hidden />
      <div
        className="pointer-events-none absolute inset-x-3 flex justify-center"
        style={
          tooltipBelow
            ? { top: Math.min(rect!.top + rect!.height + pad + 10, window.innerHeight - 240) }
            : { bottom: Math.max(window.innerHeight - rect!.top + pad + 10, 16) }
        }
      >
        {card}
      </div>
    </div>
  );
}
