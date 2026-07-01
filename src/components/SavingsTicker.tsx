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
  const fromRef = useRef(value);
  const startRef = useRef<number | null>(null);
  const [pop, setPop] = useState(false);

  useEffect(() => {
    const from = fromRef.current;
    const to = value;
    if (from === to) return;
    setPop(true);
    const t = setTimeout(() => setPop(false), 400);
    let raf = 0;
    const tick = (ts: number) => {
      if (startRef.current === null) startRef.current = ts;
      const p = Math.min(1, (ts - startRef.current) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(from + (to - from) * eased);
      if (p < 1) raf = requestAnimationFrame(tick);
      else {
        fromRef.current = to;
        startRef.current = null;
      }
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
