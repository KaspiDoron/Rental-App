"use client";

import { useCallback, useRef } from "react";

/**
 * Returns a stable function identity that always calls the latest version of
 * `fn`. Useful for callbacks passed into timers/effects without re-subscribing.
 */
export function useCallbackRef<A extends unknown[], R>(
  fn: (...args: A) => R
): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}
