"use client";

// React binding for the AuthHandshake machine (see ./handshake.ts for the WHY).
//
// Thin on purpose: all the rules live in the machine so they can be tested
// without a DOM, and this file only owns the two things that are genuinely
// React's business - keeping one machine instance per mount, and republishing
// its state through useSyncExternalStore so a phase change repaints.
//
// It is also the single place the global navigation veil is wired to auth:
// `entering` shows it and any failure hides it, so a sign-in that dies mid-flight
// can never leave the app behind a permanent dimmed overlay.

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { startNav, stopNav } from "../NavVeil";
import {
  AuthHandshake,
  isBusyPhase,
  type AuthPhase,
  type HandshakeRun,
  type HandshakeState,
} from "./handshake";

export interface UseAuthHandshake {
  phase: AuthPhase;
  error: string | null;
  /** Which method is mid-handshake, so only that button shows a spinner. */
  methodId: string | null;
  /** True while something is genuinely in flight. */
  busy: boolean;
  run: (methodId: string, fn: (ctl: HandshakeRun) => Promise<void> | void) => Promise<boolean>;
  fail: (message: string) => void;
  reset: () => void;
}

export function useAuthHandshake(): UseAuthHandshake {
  const ref = useRef<AuthHandshake | null>(null);
  if (ref.current === null) {
    ref.current = new AuthHandshake({ onEnter: startNav, onLeave: stopNav });
  }
  const machine = ref.current;

  useEffect(() => {
    return () => machine.dispose();
  }, [machine]);

  const subscribe = useCallback(
    (cb: () => void) => machine.subscribe(() => cb()),
    [machine]
  );
  const snapshot = useCallback((): HandshakeState => machine.state, [machine]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);

  const run = useCallback<UseAuthHandshake["run"]>(
    (methodId, fn) => machine.run(methodId, fn),
    [machine]
  );
  const fail = useCallback((message: string) => machine.fail(message), [machine]);
  const reset = useCallback(() => machine.reset(), [machine]);

  return useMemo(
    () => ({
      phase: state.phase,
      error: state.error,
      methodId: state.methodId,
      busy: isBusyPhase(state.phase),
      run,
      fail,
      reset,
    }),
    [state, run, fail, reset]
  );
}
