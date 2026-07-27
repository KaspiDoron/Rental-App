"use client";

// useVersionedToggle - one hook for every control that flips a piece of SERVER
// state and is also fed by a poll.
//
// The pattern this replaces was hand-rolled per control and got the ordering
// wrong in the same way every time: an optimistic flip, a `busy` flag to ignore
// polls while the write is in flight, and an effect that listed `busy` in its
// dependencies - so the moment the write finished the effect re-ran and applied
// the LAST poll value it had seen, which predated the write. Combined with a
// 30s per-instance cache on the server, tapping Resume showed "active" and then
// flipped back to "paused" a few seconds later, with nothing having re-paused.
//
// The fix is not another guard: it is ORDER. Every value carries a version, and
// the hook only ever moves forward (lib/versioned). A stale answer - from a
// re-fired effect, an overtaken poll, or another instance's cache - is a version
// that is not newer, and is simply dropped.

import { useCallback, useEffect, useRef, useState } from "react";
import { applyIfNewer, optimisticVersion, UNKNOWN_VERSION, type Versioned } from "../versioned";

export interface VersionedToggle {
  /** null until the first real value is known. */
  value: boolean | null;
  /** A write is in flight. */
  busy: boolean;
  error: string | null;
  /** The newest version applied - pass it back to the server on reads. */
  version: number;
  toggle: () => void;
}

export function useVersionedToggle(opts: {
  /** Read the current value once (on mount). */
  read: (knownVersion: number) => Promise<Versioned<boolean> | null>;
  /** Write the new value; return what the server confirmed. */
  write: (next: boolean) => Promise<Versioned<boolean> | null>;
  /** Live value from a poll, if this control is also fed by one. */
  incoming?: Versioned<boolean> | null;
  /** Message shown when a write does not land. `next` is what was attempted. */
  errorFor?: (next: boolean) => string;
}): VersionedToggle {
  const [state, setState] = useState<Versioned<boolean> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  // The applied version lives in a ref as well as in state, so the merge rule
  // reads the CURRENT version rather than one captured by a closure - the exact
  // staleness this hook exists to prevent.
  const applied = useRef<Versioned<boolean> | null>(null);

  const adopt = useCallback((next: Versioned<boolean> | null) => {
    const merged = applyIfNewer(applied.current, next);
    if (merged === applied.current) return; // not newer - drop it
    applied.current = merged;
    if (mounted.current) setState(merged);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const readRef = useRef(opts.read);
  readRef.current = opts.read;
  const writeRef = useRef(opts.write);
  writeRef.current = opts.write;
  const errorForRef = useRef(opts.errorFor);
  errorForRef.current = opts.errorFor;

  // Initial read. Empty deps on purpose: re-running it would race the user.
  useEffect(() => {
    (async () => {
      try {
        adopt(await readRef.current(applied.current?.version ?? UNKNOWN_VERSION));
      } catch {
        // Unknown -> stay null rather than inventing a value. Server-side gates
        // fail closed regardless of what this control shows.
      }
    })();
  }, [adopt]);

  // Follow the poll - by VERSION, not by a `busy` flag. There is deliberately no
  // `busy` in these dependencies: that is what made a finished write immediately
  // re-apply the pre-write value.
  const incomingValue = opts.incoming?.value;
  const incomingVersion = opts.incoming?.version;
  useEffect(() => {
    if (typeof incomingValue !== "boolean" || typeof incomingVersion !== "number") return;
    adopt({ value: incomingValue, version: incomingVersion });
  }, [incomingValue, incomingVersion, adopt]);

  const toggle = useCallback(() => {
    const current = applied.current;
    if (busy || !current) return;
    const next = !current.value;
    setBusy(true);
    setError(null);
    // The optimistic flip is stamped just below "now", so it outranks every
    // answer that predates the write and is still outranked by the server's own
    // confirmation - which is stamped from the durable record.
    applied.current = { value: next, version: optimisticVersion(current, Date.now()) };
    setState(applied.current);
    void (async () => {
      try {
        const confirmed = await writeRef.current(next);
        if (!confirmed) {
          if (!mounted.current) return;
          // The write did NOT land. Revert at a version that outranks the
          // optimistic flip, so the revert cannot itself be dropped as stale.
          applied.current = { value: current.value, version: Date.now() };
          setState(applied.current);
          setError(errorForRef.current?.(next) ?? "That did not save. Try again.");
        } else {
          adopt(confirmed);
        }
      } catch {
        if (mounted.current) {
          applied.current = { value: current.value, version: Date.now() };
          setState(applied.current);
          setError(errorForRef.current?.(next) ?? "Network hiccup - nothing changed.");
        }
      } finally {
        if (mounted.current) setBusy(false);
      }
    })();
  }, [busy, adopt]);

  return {
    value: state?.value ?? null,
    busy,
    error,
    version: state?.version ?? UNKNOWN_VERSION,
    toggle,
  };
}
