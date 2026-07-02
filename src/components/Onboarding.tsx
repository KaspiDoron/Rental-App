"use client";

import { useEffect, useState } from "react";
import { BrandMark } from "./BrandMark";

// Post-signup walkthrough of the core features, ending with an adaptive
// "add to Home Screen" guide per phone OS. Next / Back / Skip.
const STEPS: { emoji: string; title: string; text: string }[] = [
  {
    emoji: "👋",
    title: "Welcome to WheelDeal!",
    text: "Your AI agents find every rental shop around your hotel and chase the cheapest price for you. Here is a 30-second tour.",
  },
  {
    emoji: "💬",
    title: "1 · Say what you want",
    text: 'Type it like you would to a friend: "125cc automatic scooter with a phone mount, 3 days". The Profiler agent turns it into a professional request.',
  },
  {
    emoji: "📍",
    title: "2 · Set your stay",
    text: "Search your hotel or tap 'Use my current location'. Pick a radius - the agents only contact shops inside it.",
  },
  {
    emoji: "⚡",
    title: "3 · Watch the live tracker",
    text: "Every shop gets its own progress bar: Locating, RFQ sent, Awaiting, Negotiating, Offer. Real prices come only from real shop replies - never invented.",
  },
  {
    emoji: "🥊",
    title: "4 · Bargain with one tap",
    text: "Got a quote? Tap Bargain draft and the agent writes the perfect counter-message, learned from real negotiations. Send it on WhatsApp.",
  },
  {
    emoji: "🗺️",
    title: "5 · Map or list",
    text: "Toggle between the list and the map. Expand the map fullscreen and browse shops booking-style with prices on the pins.",
  },
  {
    emoji: "✅",
    title: "6 · Lock the deal",
    text: "The agent double-checks the exact vehicle, then you pick delivery or pickup and the time. Free plan schedules same-day pickups; Pro unlocks future days.",
  },
];

type OS = "ios" | "android";

export function Onboarding({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [osStep, setOsStep] = useState(false);
  const [os, setOs] = useState<OS>("ios");

  useEffect(() => {
    // Adaptive default from the device itself.
    const ua = navigator.userAgent;
    setOs(/android/i.test(ua) ? "android" : "ios");
  }, []);

  function finish() {
    try {
      localStorage.setItem("wd_onboarded", "1");
    } catch {}
    onClose();
  }

  const s = STEPS[step];

  return (
    <div className="fixed inset-0 z-[1300] flex items-end justify-center bg-black/55 backdrop-blur-sm sm:items-center">
      <div className="surface-strong w-full max-w-md rounded-t-3xl p-6 pb-safe sm:rounded-blob animate-slide-up">
        {!osStep ? (
          <>
            <div className="mb-4 text-center">
              <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-3xl bg-brandblue-soft text-3xl">
                {step === 0 ? <BrandMark size={44} /> : s.emoji}
              </div>
              <h2 className="font-display text-xl font-extrabold text-strong">{s.title}</h2>
              <p className="mx-auto mt-2 max-w-[300px] text-[14px] leading-relaxed text-soft">
                {s.text}
              </p>
            </div>

            {/* progress dots */}
            <div className="mb-4 flex justify-center gap-1.5">
              {STEPS.map((_, i) => (
                <span
                  key={i}
                  className={`h-1.5 rounded-full transition-all ${
                    i === step ? "w-5 bg-brandblue" : "w-1.5 bg-line"
                  }`}
                />
              ))}
            </div>

            <div className="flex items-center gap-2">
              {step > 0 && (
                <button
                  onClick={() => setStep(step - 1)}
                  className="btn btn-ghost rounded-2xl px-4 py-3 text-sm"
                >
                  Back
                </button>
              )}
              <button
                onClick={() =>
                  step < STEPS.length - 1 ? setStep(step + 1) : setOsStep(true)
                }
                className="btn btn-primary flex-1 rounded-2xl py-3 text-sm"
              >
                {step < STEPS.length - 1 ? "Next" : "One last thing..."}
              </button>
            </div>
            <button
              onClick={finish}
              className="btn mt-2 w-full py-2 text-center text-[12px] font-bold text-faint hover:text-soft"
            >
              Skip introduction
            </button>
          </>
        ) : (
          <>
            <div className="mb-3 text-center">
              <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-3xl bg-brandyellow-soft text-3xl">
                📲
              </div>
              <h2 className="font-display text-xl font-extrabold text-strong">
                Install WheelDeal like an app
              </h2>
              <p className="mt-1 text-[13px] text-soft">
                Add it to your Home Screen - it opens full-screen with its own
                icon, just like from the App Store.
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
                    os === o.id
                      ? "border-brandblue bg-brandblue-soft text-brandblue"
                      : "border-line text-soft"
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
                  <li>3. Scroll and tap "Add to Home Screen".</li>
                  <li>4. Tap "Add" - done! Launch it from your Home Screen.</li>
                </>
              ) : (
                <>
                  <li>1. Open this site in Chrome.</li>
                  <li>2. Tap the ⋮ menu (top right).</li>
                  <li>3. Tap "Add to Home screen" (or "Install app").</li>
                  <li>4. Confirm - done! Launch it from your Home Screen.</li>
                </>
              )}
            </ol>
            <p className="mt-2 text-center text-[11px] text-faint">
              Menus can move slightly between OS updates - look for Share or
              Install in your browser menu.
            </p>

            <button onClick={finish} className="btn btn-primary mt-4 w-full rounded-2xl py-3 text-sm">
              Start saving 🎉
            </button>
          </>
        )}
      </div>
    </div>
  );
}
