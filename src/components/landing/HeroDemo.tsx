"use client";

// A looping, self-playing mock negotiation so a first-time visitor SEES what
// Will does in the first five seconds - no signup, no reading. Honest framing:
// it is clearly labelled a demo. Respects prefers-reduced-motion (renders the
// finished conversation statically).

import { useEffect, useRef, useState } from "react";
import { Icon } from "../icons";

interface DemoMsg {
  from: "shop" | "will" | "system";
  text: string;
}

const SCRIPT: DemoMsg[] = [
  { from: "will", text: "Hi! Do you have a 125cc automatic scooter for 5 days?" },
  { from: "shop", text: "Yes have. 300 per day." },
  { from: "system", text: "Will checked the real local rate: ~160/day" },
  {
    from: "will",
    text: "Oh sorry, 300 is really expensive for me 🫶 I'm renting 5 days, long time - could you do 160 a day my friend?",
  },
  { from: "shop", text: "Cannot 160... for 5 days okay 180, cash." },
  { from: "system", text: "Deal locked: 180/day - 40% below the opening price" },
];

export function HeroDemo() {
  const [count, setCount] = useState(1);
  const [reduced, setReduced] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mq.matches) {
      setReduced(true);
      setCount(SCRIPT.length);
      return;
    }
    const timer = setInterval(() => {
      setCount((c) => (c >= SCRIPT.length ? 1 : c + 1));
    }, 1900);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    // Keep the newest bubble in view inside the card (never scroll the page).
    boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight, behavior: "smooth" });
  }, [count]);

  const visible = SCRIPT.slice(0, count);
  return (
    <div className="surface-strong mx-auto w-full max-w-sm rounded-blob p-3 shadow-xl">
      <div className="mb-2 flex items-center justify-between px-1">
        <div className="flex items-center gap-1.5 text-[11px] font-extrabold text-soft">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-savings opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-savings" />
          </span>
          Will is negotiating
        </div>
        <span className="rounded-full bg-card2 px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-wide text-faint">
          Demo
        </span>
      </div>
      <div ref={boxRef} className="no-scrollbar flex h-[290px] flex-col gap-2 overflow-y-auto px-1 pb-1">
        {visible.map((m, i) => {
          const last = i === visible.length - 1;
          const anim = reduced || !last ? "" : "pop-in";
          if (m.from === "system") {
            return (
              <div
                key={i}
                className={`${anim} mx-auto flex items-center gap-1.5 rounded-full bg-brandblue-soft px-3 py-1.5 text-center text-[10px] font-extrabold text-brandblue`}
              >
                <Icon name="sparkles" className="h-3 w-3 shrink-0" /> {m.text}
              </div>
            );
          }
          const isWill = m.from === "will";
          return (
            <div
              key={i}
              className={`${anim} max-w-[85%] rounded-2xl px-3 py-2 text-[12px] font-semibold leading-snug ${
                isWill
                  ? "self-end rounded-br-md bg-brandblue text-white"
                  : "self-start rounded-bl-md bg-card2 text-strong"
              }`}
            >
              {!isWill && (
                <div className="mb-0.5 text-[9px] font-extrabold uppercase tracking-wide opacity-60">
                  Rental shop
                </div>
              )}
              {m.text}
            </div>
          );
        })}
      </div>
    </div>
  );
}
