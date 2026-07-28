import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AuthHandshake,
  AuthHandshakeError,
  GENERIC_FAILURE_COPY,
  PHASE_DEADLINE_MS,
  isBusyPhase,
  isTerminalPhase,
  type AuthPhase,
  type HandshakeRun,
} from "./handshake";

// WHY THIS FILE EXISTS
//
// Pressing the Google button used to change nothing on screen: the page modelled
// the whole sign-in with one `status` flag that only the EMAIL form ever set, and
// none of the provider awaits was bounded. So the two properties that matter are
// (a) every busy phase has a deadline and therefore always lands somewhere
// renderable, and (b) a second press cannot start a second exchange.

/** Never resolves. Stands in for a provider or server that stopped answering. */
const forever = () => new Promise<void>(() => {});

function machine(spy: { enter: () => void; leave: () => void }) {
  return new AuthHandshake({ onEnter: spy.enter, onLeave: spy.leave });
}

let spy: { enter: ReturnType<typeof vi.fn>; leave: ReturnType<typeof vi.fn> };

beforeEach(() => {
  vi.useFakeTimers();
  spy = { enter: vi.fn(), leave: vi.fn() };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the machine starts, reports and settles", () => {
  it("begins idle with nothing to show", () => {
    const m = machine(spy);
    expect(m.state).toEqual({ phase: "idle", error: null, methodId: null });
    expect(isBusyPhase("idle")).toBe(false);
  });

  it("run() immediately publishes a busy phase naming the method", async () => {
    const m = machine(spy);
    let seen: AuthPhase | null = null;
    m.subscribe((s) => {
      seen ??= s.phase;
    });
    const done = m.run("google", forever);
    expect(seen).toBe("starting");
    expect(m.state.methodId).toBe("google");
    expect(isBusyPhase(m.state.phase)).toBe(true);
    m.reset();
    await vi.advanceTimersByTimeAsync(0);
    void done;
  });

  it("walks starting -> awaiting-provider -> exchanging and back to idle", async () => {
    const m = machine(spy);
    const phases: AuthPhase[] = [];
    m.subscribe((s) => phases.push(s.phase));
    const ok = await m.run("google", async (ctl) => {
      ctl.phase("awaiting-provider");
      ctl.phase("exchanging");
    });
    expect(ok).toBe(true);
    expect(phases).toEqual(["starting", "awaiting-provider", "exchanging", "idle"]);
    expect(m.state.error).toBeNull();
  });

  it("stays in `entering` after a successful run - the page is leaving", async () => {
    const m = machine(spy);
    const ok = await m.run("google", async (ctl) => ctl.phase("entering"));
    expect(ok).toBe(true);
    expect(m.state.phase).toBe("entering");
    // The veil is raised exactly once and never cleared out from under the
    // navigation that is already in flight.
    expect(spy.enter).toHaveBeenCalledTimes(1);
    expect(spy.leave).not.toHaveBeenCalled();
  });
});

describe("no phase can hang - every busy phase has a deadline", () => {
  const busy: AuthPhase[] = ["starting", "awaiting-provider", "exchanging", "entering"];

  it("declares a finite deadline for every non-resting phase", () => {
    for (const p of busy) expect(PHASE_DEADLINE_MS[p]).toBeGreaterThan(0);
    expect(PHASE_DEADLINE_MS.idle).toBe(0);
    expect(PHASE_DEADLINE_MS.failed).toBe(0);
  });

  for (const phase of busy) {
    it(`times out of "${phase}" with copy to show`, async () => {
      const m = machine(spy);
      const done = m.run("google", async (ctl) => {
        if (phase !== "starting") ctl.phase(phase);
        await forever();
      });
      await vi.advanceTimersByTimeAsync(PHASE_DEADLINE_MS[phase]);
      expect(m.state.phase).toBe("failed");
      expect((m.state.error ?? "").length).toBeGreaterThan(0);
      expect(isTerminalPhase(m.state.phase)).toBe(true);
      // A failure always takes the navigation veil back down with it.
      expect(spy.leave).toHaveBeenCalled();
      void done;
    });
  }

  it("aborts the in-flight work when the deadline fires", async () => {
    const m = machine(spy);
    let signal: AbortSignal | null = null;
    const done = m.run("google", async (ctl) => {
      signal = ctl.signal;
      await forever();
    });
    expect(signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(PHASE_DEADLINE_MS.starting);
    expect(signal!.aborted).toBe(true);
    void done;
  });

  it("advancing a phase re-arms the clock rather than inheriting the old one", async () => {
    const m = machine(spy);
    const done = m.run("google", async (ctl) => {
      ctl.phase("awaiting-provider");
      await forever();
    });
    // A human typing a Google password gets a minute, not the 8s the SDK load
    // gets - which is the distinction one shared `loading` flag cannot make.
    await vi.advanceTimersByTimeAsync(PHASE_DEADLINE_MS.starting + 1000);
    expect(m.state.phase).toBe("awaiting-provider");
    await vi.advanceTimersByTimeAsync(PHASE_DEADLINE_MS["awaiting-provider"]);
    expect(m.state.phase).toBe("failed");
    void done;
  });

  it("a timed-out run cannot later resurrect itself", async () => {
    const m = machine(spy);
    let ctl!: HandshakeRun;
    let release!: () => void;
    const done = m.run("google", async (c) => {
      ctl = c;
      await new Promise<void>((r) => {
        release = r;
      });
    });
    await vi.advanceTimersByTimeAsync(PHASE_DEADLINE_MS.starting);
    expect(m.state.phase).toBe("failed");
    expect(ctl.stale).toBe(true);
    // The abandoned runner finishing must not wipe the error off the screen.
    ctl.phase("entering");
    release();
    expect(await done).toBe(false);
    expect(m.state.phase).toBe("failed");
  });
});

describe("failure is always visible and always recoverable", () => {
  it("uses the runner's copy when it throws AuthHandshakeError", async () => {
    const m = machine(spy);
    const ok = await m.run("google", async () => {
      throw new AuthHandshakeError("Google sign-in failed.");
    });
    expect(ok).toBe(false);
    expect(m.state.phase).toBe("failed");
    expect(m.state.error).toBe("Google sign-in failed.");
  });

  it("never leaks an internal exception message to the user", async () => {
    const m = machine(spy);
    await m.run("google", async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'accounts')");
    });
    expect(m.state.error).toBe(GENERIC_FAILURE_COPY);
  });

  it("fail() can be driven from outside the runner (a GSI popup callback)", () => {
    const m = machine(spy);
    m.fail("Your browser blocked the Google pop-up.");
    expect(m.state.phase).toBe("failed");
    expect(m.state.error).toBe("Your browser blocked the Google pop-up.");
    expect(spy.leave).toHaveBeenCalled();
  });

  it("a failed handshake can be retried - failed is startable", async () => {
    const m = machine(spy);
    await m.run("google", async () => {
      throw new AuthHandshakeError("nope");
    });
    expect(m.state.phase).toBe("failed");
    const ok = await m.run("google", async () => {});
    expect(ok).toBe(true);
    expect(m.state.phase).toBe("idle");
    expect(m.state.error).toBeNull();
  });

  it("reset() clears the error and cancels anything in flight", async () => {
    const m = machine(spy);
    let signal: AbortSignal | null = null;
    const done = m.run("google", async (ctl) => {
      signal = ctl.signal;
      await forever();
    });
    m.reset();
    expect(m.state).toEqual({ phase: "idle", error: null, methodId: null });
    expect(signal!.aborted).toBe(true);
    void done;
  });
});

describe("a second press cannot start a second exchange", () => {
  it("refuses a concurrent run and leaves the first one alone", async () => {
    const m = machine(spy);
    let runs = 0;
    const first = m.run("google", async () => {
      runs += 1;
      await forever();
    });
    const second = await m.run("google", async () => {
      runs += 1;
    });
    expect(second).toBe(false);
    expect(runs).toBe(1);
    expect(m.state.phase).toBe("starting");
    void first;
  });

  it("refuses a new run once the page is entering", async () => {
    const m = machine(spy);
    await m.run("google", async (ctl) => ctl.phase("entering"));
    expect(await m.run("google", async () => {})).toBe(false);
  });
});

describe("subscribers", () => {
  it("are not woken by a no-op transition", async () => {
    const m = machine(spy);
    const seen: AuthPhase[] = [];
    m.subscribe((s) => seen.push(s.phase));
    await m.run("google", async (ctl) => {
      ctl.phase("exchanging");
      ctl.phase("exchanging");
    });
    expect(seen).toEqual(["starting", "exchanging", "idle"]);
  });

  it("stop hearing anything after dispose, and no deadline can still fire", async () => {
    const m = machine(spy);
    const seen: AuthPhase[] = [];
    const done = m.run("google", forever);
    m.subscribe((s) => seen.push(s.phase));
    m.dispose();
    await vi.advanceTimersByTimeAsync(PHASE_DEADLINE_MS["awaiting-provider"] * 2);
    expect(seen).toEqual([]);
    void done;
  });
});
