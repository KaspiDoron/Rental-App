"use client";

// The login screen's ONLY provider probe.
//
// WHY THIS EXISTS
//
// The old code asked /api/config/public - a force-dynamic endpoint that awaits
// five unrelated getConfig reads - with a bare `fetch` and no loading state. On a
// cold instance the first of those reads is a Supabase round trip bounded at 8s,
// and if the fetch itself stalled there was no client-side abort anywhere in the
// repo to save it. For that whole window the sign-in area rendered an "OR"
// divider above an empty gap, and on a stall it rendered that forever.
//
// Two rules make that unrepresentable:
//   1. The probe is BOUNDED and always reaches a terminal state. There is no code
//      path that leaves `state === "probing"`.
//   2. Failure is not blankness. A probe that times out or 500s resolves to an
//      email-only method list plus a surfaced reason, which is the truthful
//      answer anyway: we could not confirm the alternates, and email always
//      works. The layout then renders no divider, because there are no
//      alternates - the honest degradation falls out of the data, not out of a
//      special case.
//
// `probeAuthMethods` is exported separately from the hook because the rules
// above are what deserve tests, and they need no React to exercise.

import { useEffect, useState } from "react";
import { fetchJson } from "../../lib/client/fetch-json";
import {
  decodeAuthMethods,
  emailOnlyMethods,
  METHODS_UNREACHABLE_REASON,
  type AuthMethod,
} from "../../lib/auth/methods";

export type AuthMethodsState = "probing" | "ready" | "failed";

export interface AuthMethodsProbe {
  state: AuthMethodsState;
  methods: AuthMethod[];
  /** Set when state === "failed"; safe to show to a user. */
  error?: string;
}

/**
 * 6s, deliberately shorter than fetchJson's 10s default and than the 8s Supabase
 * deadline behind the endpoint. The sign-in area is the first thing a traveller
 * looks at, so we would rather show a working email form six seconds in than a
 * correct provider list twelve seconds in.
 */
export const AUTH_METHODS_TIMEOUT_MS = 6000;

export const AUTH_METHODS_URL = "/api/auth/methods";

/** The terminal, degraded answer. Never a blank list, never a thrown error. */
function degraded(error: string): AuthMethodsProbe {
  return { state: "failed", methods: emailOnlyMethods(error), error };
}

export async function probeAuthMethods(
  opts: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<AuthMethodsProbe> {
  const res = await fetchJson<{ methods?: unknown }>(AUTH_METHODS_URL, {
    timeoutMs: opts.timeoutMs ?? AUTH_METHODS_TIMEOUT_MS,
    signal: opts.signal,
    headers: { Accept: "application/json" },
  });

  if (res.aborted) {
    // The caller went away (unmount / navigation). Report the degraded shape so
    // the return type stays total; a caller that aborted ignores this anyway.
    return degraded(METHODS_UNREACHABLE_REASON);
  }
  if (!res.ok) {
    return degraded(res.error || METHODS_UNREACHABLE_REASON);
  }

  const methods = decodeAuthMethods(res.data);
  if (!methods) {
    // A 200 with a payload we cannot trust is a failure, not a success with an
    // empty list - the difference decides whether the user is told anything.
    return degraded(METHODS_UNREACHABLE_REASON);
  }
  return { state: "ready", methods };
}

const INITIAL: AuthMethodsProbe = { state: "probing", methods: [] };

export function useAuthMethods(): AuthMethodsProbe {
  const [probe, setProbe] = useState<AuthMethodsProbe>(INITIAL);

  useEffect(() => {
    const ctrl = new AbortController();
    let live = true;
    probeAuthMethods({ signal: ctrl.signal }).then((next) => {
      if (live) setProbe(next);
    });
    return () => {
      live = false;
      ctrl.abort();
    };
  }, []);

  return probe;
}
