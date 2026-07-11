"use client";

import { useEffect, useRef, useState } from "react";

/** Smoothly animates a number toward `value`, with a pop on change. */
export function AnimatedNumber({
  value,
  prefix = "",
  suffix = "",
  duration = 700,
  className = "",
}: {
  value: number;
  prefix?: string;
  suffix?: string;
  duration?: number;
  className?: string;
}) {
  const [display, setDisplay] = useState(value);
  const displayRef = useRef(value);
  displayRef.current = display;
  const [pop, setPop] = useState(false);

  useEffect(() => {
    // Always start the new tween from the CURRENTLY DISPLAYED value and a fresh
    // start timestamp. The old code reused a stale start time when a poll
    // updated the value mid-animation, which made the number JUMP instead of
    // animate.
    const from = displayRef.current;
    const to = value;
    if (from === to) return;
    setPop(true);
    const t = setTimeout(() => setPop(false), 400);
    let raf = 0;
    let start: number | null = null;
    const tick = (ts: number) => {
      if (start === null) start = ts;
      const p = Math.min(1, (ts - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(from + (to - from) * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [value, duration]);

  return (
    <span className={`tabular ${pop ? "animate-count-pop inline-block" : ""} ${className}`}>
      {prefix}
      {Math.round(display).toLocaleString()}
      {suffix}
    </span>
  );
}
