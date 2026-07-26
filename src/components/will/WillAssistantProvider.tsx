"use client";

// WillAssistantProvider - the one place that knows WHERE the user is in the
// funnel and WHETHER they are hesitating. Pages publish their step (derived via
// deriveWillStep from live state they own); the provider adds the cross-cutting
// piece no single component can see well: idle detection.
//
// "Idle" here means no pointer/key/scroll input for WILL_IDLE_MS while the app
// is visible. That is the signal Will uses to step in proactively ("stuck on
// the link screen", "staring at the empty request box") instead of nagging
// someone who is actively moving.
//
// Mounted once in the root layout so Find Deals, Profile and Login all share
// the same instance - the step survives the route hop into pairing and back.

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { WILL_IDLE_MS, type WillStep } from "@/lib/will-assistant";

interface WillAssistant {
  step: WillStep | null;
  /** Epoch ms when the current step was entered (drives per-step timers). */
  stepSince: number;
  /** true after WILL_IDLE_MS with zero interaction - the "hesitating" signal. */
  idle: boolean;
  setStep: (step: WillStep | null) => void;
}

const Ctx = createContext<WillAssistant | null>(null);

export function WillAssistantProvider({ children }: { children: ReactNode }) {
  const [step, setStepState] = useState<WillStep | null>(null);
  const [stepSince, setStepSince] = useState(() => Date.now());
  const [idle, setIdle] = useState(false);
  const lastActivity = useRef(Date.now());
  const stepRef = useRef<WillStep | null>(null);

  const setStep = (next: WillStep | null) => {
    if (stepRef.current === next) return; // re-publishes are free
    stepRef.current = next;
    setStepState(next);
    setStepSince(Date.now());
    // A step change is progress - the user is not stuck on the NEW screen yet.
    lastActivity.current = Date.now();
    setIdle(false);
  };

  useEffect(() => {
    const wake = () => {
      lastActivity.current = Date.now();
      // Functional-only clear: avoids a re-render per scroll tick while active.
      setIdle((was) => (was ? false : was));
    };
    const opts = { passive: true } as AddEventListenerOptions;
    window.addEventListener("pointerdown", wake, opts);
    window.addEventListener("keydown", wake, opts);
    window.addEventListener("touchstart", wake, opts);
    window.addEventListener("scroll", wake, opts);
    // A 1s heartbeat beats per-event setTimeout churn: one cheap comparison,
    // and it naturally pauses with the tab (timers throttle when hidden).
    const tick = setInterval(() => {
      if (document.hidden) return;
      if (Date.now() - lastActivity.current >= WILL_IDLE_MS) {
        setIdle((was) => (was ? was : true));
      }
    }, 1000);
    return () => {
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", wake);
      window.removeEventListener("touchstart", wake);
      window.removeEventListener("scroll", wake);
      clearInterval(tick);
    };
  }, []);

  return (
    <Ctx.Provider value={{ step, stepSince, idle, setStep }}>{children}</Ctx.Provider>
  );
}

/** Null-safe: components render fine outside the provider (tests, storybook). */
export function useWillAssistant(): WillAssistant {
  return (
    useContext(Ctx) ?? {
      step: null,
      stepSince: 0,
      idle: false,
      setStep: () => {},
    }
  );
}
