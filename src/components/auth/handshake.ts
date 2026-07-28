"use client";

// The shared auth HANDSHAKE state machine.
//
// WHY THIS EXISTS
//
// A sign-in round trip is not one await, it is a chain of them - load the
// provider SDK, wait for a human to pick an account, exchange the credential
// with our server, then leave for the app - and the login page modelled all of
// it with a single `status: "idle" | "loading" | "error"` that only the EMAIL
// form ever set. Press the Google button and literally nothing changed on
// screen: no spinner, no disabled state, no error, because there was no state to
// change. Worse, none of those awaits was bounded, so "no feedback" could last
// forever rather than for a few seconds.
//
// The capability is a machine in which a hanging handshake is unrepresentable:
// EVERY non-terminal phase carries its own deadline, so the machine always
// arrives at `entering` (we are leaving the page) or `failed` (with copy to
// show). The deadlines differ by an order of magnitude on purpose - a human
// typing a Google password is not the same wait as a server that has stopped
// answering - which is exactly the distinction a single overloaded `loading`
// flag cannot make.
//
// It is deliberately a plain class, not a hook: the transition rules and the
// deadlines are the interesting part and they are testable directly, while
// useAuthHandshake.ts is a thin React binding over it.

export type AuthPhase =
  | "idle"
  | "starting"
  | "awaiting-provider"
  | "exchanging"
  | "entering"
  | "failed";

/**
 * Per-phase hard deadlines.
 *
 *  - starting          loading a provider SDK over the network (mirrors loadGsi)
 *  - awaiting-provider a PERSON is typing a password in a popup; minutes-ish
 *  - exchanging        our own API verifying the credential with Google
 *  - entering          the browser is navigating away; if it has not by now the
 *                      navigation was swallowed and the user must be told
 *
 * `idle` and `failed` are terminal-at-rest and carry no deadline.
 */
export const PHASE_DEADLINE_MS: Record<AuthPhase, number> = {
  idle: 0,
  starting: 8000,
  "awaiting-provider": 60_000,
  exchanging: 12_000,
  entering: 12_000,
  failed: 0,
};

/** Copy shown when a phase runs out of time. Specific beats generic here. */
export const PHASE_TIMEOUT_COPY: Record<AuthPhase, string> = {
  idle: "",
  starting: "Sign-in did not start in time - please try again.",
  "awaiting-provider": "Sign-in was not completed - please try again.",
  exchanging: "The server is taking too long to answer - please try again.",
  entering: "Signed in, but the app is slow to open - please reload the page.",
  failed: "",
};

export const GENERIC_FAILURE_COPY = "Something went wrong - please try again.";

export interface HandshakeState {
  phase: AuthPhase;
  /** User-safe copy. Non-empty exactly when phase === "failed". */
  error: string | null;
  /** Which method is mid-handshake, so a UI can spin the right button only. */
  methodId: string | null;
}

/** Controls handed to the function `run` drives. */
export interface HandshakeRun {
  /** Aborts when this run's deadline fires or the machine is reset. */
  readonly signal: AbortSignal;
  /** Advance to the next phase and re-arm the deadline for it. */
  phase(next: AuthPhase): void;
  /** True once this run has been superseded, timed out or reset. */
  readonly stale: boolean;
}

/**
 * Thrown by a runner to fail the handshake with copy the user should see.
 * Anything else that escapes is treated as an internal fault and reported with
 * generic copy, so an exception message can never leak into the UI.
 */
export class AuthHandshakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthHandshakeError";
  }
}

export interface AuthHandshakeOptions {
  /** Called when the machine enters `entering` (wire to startNav). */
  onEnter?: () => void;
  /** Called whenever it leaves a busy phase for idle/failed (wire to stopNav). */
  onLeave?: () => void;
}

const IDLE: HandshakeState = { phase: "idle", error: null, methodId: null };

/** Phases from which a NEW handshake may be started. */
function startable(phase: AuthPhase): boolean {
  return phase === "idle" || phase === "failed";
}

/** Phases that are at rest - nothing is in flight and no deadline is armed. */
export function isTerminalPhase(phase: AuthPhase): boolean {
  return phase === "idle" || phase === "failed" || phase === "entering";
}

/** Whether a UI should show pending affordances for this phase. */
export function isBusyPhase(phase: AuthPhase): boolean {
  return phase === "starting" || phase === "awaiting-provider" || phase === "exchanging";
}

export class AuthHandshake {
  private current: HandshakeState = IDLE;
  private listeners = new Set<(s: HandshakeState) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ctrl: AbortController | null = null;
  private runToken = 0;
  private readonly opts: AuthHandshakeOptions;

  constructor(opts: AuthHandshakeOptions = {}) {
    this.opts = opts;
  }

  get state(): HandshakeState {
    return this.current;
  }

  subscribe(fn: (s: HandshakeState) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(next: HandshakeState): void {
    // Identity is the subscription contract (useSyncExternalStore compares by
    // reference), so an unchanged state must keep the same object.
    if (
      next.phase === this.current.phase &&
      next.error === this.current.error &&
      next.methodId === this.current.methodId
    ) {
      return;
    }
    this.current = next;
    for (const l of [...this.listeners]) l(next);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private arm(phase: AuthPhase, token: number): void {
    this.clearTimer();
    const ms = PHASE_DEADLINE_MS[phase];
    if (!ms) return;
    const timer = setTimeout(() => {
      if (token !== this.runToken) return;
      // The deadline is the ONLY thing standing between the user and a silent
      // forever-wait, so it both aborts the in-flight work and moves the machine
      // to a phase that renders something.
      this.abortCurrent();
      this.settleFailed(PHASE_TIMEOUT_COPY[phase] || GENERIC_FAILURE_COPY);
    }, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  private abortCurrent(): void {
    const ctrl = this.ctrl;
    this.ctrl = null;
    try {
      ctrl?.abort();
    } catch {
      /* an already-aborted controller is not an error */
    }
  }

  private settleFailed(message: string): void {
    this.runToken += 1;
    this.clearTimer();
    const methodId = this.current.methodId;
    this.emit({ phase: "failed", error: message || GENERIC_FAILURE_COPY, methodId });
    this.opts.onLeave?.();
  }

  /**
   * Start a handshake. Resolves true when the runner finished without failing.
   *
   * A second call while one is in flight is REFUSED rather than queued or
   * allowed to interleave - double-tapping a sign-in button used to fire two
   * credential exchanges, and the second one's result would overwrite the
   * first's regardless of order.
   */
  async run(
    methodId: string,
    fn: (ctl: HandshakeRun) => Promise<void> | void
  ): Promise<boolean> {
    if (!startable(this.current.phase)) return false;

    const token = ++this.runToken;
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    this.emit({ phase: "starting", error: null, methodId });
    this.arm("starting", token);

    // Captured for the `stale` getter below, which needs the machine but cannot
    // use `this` (a getter in an object literal rebinds it).
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const machine = this;

    const ctl: HandshakeRun = {
      signal: ctrl.signal,
      get stale() {
        return token !== machine.runToken;
      },
      phase: (next: AuthPhase) => {
        if (token !== this.runToken) return;
        if (next === "failed") {
          this.abortCurrent();
          this.settleFailed(this.current.error || GENERIC_FAILURE_COPY);
          return;
        }
        this.emit({ phase: next, error: null, methodId });
        if (next === "entering") {
          // Terminal: the page is going away, so nothing may clear the veil or
          // reset the button back to a pressable state under the user.
          this.clearTimer();
          this.opts.onEnter?.();
          this.arm("entering", token);
          return;
        }
        this.arm(next, token);
      },
    };

    try {
      await fn(ctl);
    } catch (err) {
      if (token !== this.runToken) return false;
      const message =
        err instanceof AuthHandshakeError && err.message.trim()
          ? err.message
          : GENERIC_FAILURE_COPY;
      this.abortCurrent();
      this.settleFailed(message);
      return false;
    }

    if (token !== this.runToken) return false;
    this.abortCurrent();
    if (this.current.phase === "entering") {
      // Leave it. The navigation's own deadline is already armed.
      return true;
    }
    this.runToken += 1;
    this.clearTimer();
    this.emit(IDLE);
    this.opts.onLeave?.();
    return true;
  }

  /** Fail the current handshake from outside the runner (e.g. a GSI callback). */
  fail(message: string): void {
    if (this.current.phase === "idle") {
      this.emit({ phase: "failed", error: message || GENERIC_FAILURE_COPY, methodId: null });
      this.opts.onLeave?.();
      return;
    }
    this.abortCurrent();
    this.settleFailed(message);
  }

  /** Back to a pressable, error-free state. Cancels anything in flight. */
  reset(): void {
    this.runToken += 1;
    this.clearTimer();
    this.abortCurrent();
    this.emit(IDLE);
  }

  /** Release timers/listeners on unmount so a pending deadline cannot fire. */
  dispose(): void {
    this.runToken += 1;
    this.clearTimer();
    this.abortCurrent();
    this.listeners.clear();
  }
}
