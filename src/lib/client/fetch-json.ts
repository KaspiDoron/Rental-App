"use client";

// The BROWSER twin of runtime-config's `timedFetch`.
//
// Every server-side outbound call in this app is bounded (runtime-config's
// timedFetch, google.ts, whatsapp.ts, ai.ts all carry an AbortController) - but
// until now not a single client-side `fetch` was. That asymmetry is what makes a
// login screen sit on an empty gap forever: `fetch()` has no default timeout in
// any browser, so a request that is ACCEPTED and then stalls (captive portal,
// carrier-grade NAT dropping the connection, a cold Cloud Run instance behind a
// slow Supabase round trip) never resolves and never rejects. The `catch` block
// the caller so carefully wrote is simply never reached, and the UI has no state
// to render because nothing ever happened.
//
// So this helper exists to make "a request that hangs" unrepresentable at the
// call site: it ALWAYS settles, it NEVER throws, and it reports which of the
// three failure shapes occurred (timed out / transport error / HTTP error with a
// body) so the caller can pick honest copy for each. Callers pattern-match on a
// result object instead of writing try/catch around an await that may not return.
//
// Deliberate design notes:
//   - We use AbortController + setTimeout rather than `AbortSignal.timeout()`.
//     The latter only shipped in Safari 16, and mobile Safari is the primary
//     target here; it also gives us no way to tell OUR deadline apart from a
//     caller's own abort, which the caller needs in order to distinguish "the
//     network died" from "the user navigated away".
//   - The deadline is NOT cleared when the response headers arrive. `fetch`
//     resolves as soon as headers land, but we then `await res.json()`, and that
//     body read shares the same signal. Clearing early would leave the body read
//     unbounded - the exact trap runtime-config's timedFetch documents.
//   - `data` is returned for non-2xx responses too. Every API route in this app
//     answers errors with a JSON body (`{ error }`, `{ needsSignup }`,
//     `{ betaBlocked }`), and the UI reads those, so throwing away the body on
//     `!res.ok` would lose the only useful information in the failure.

export interface FetchJsonResult<T> {
  /** True only for a 2xx response. Says nothing about whether `data` parsed. */
  ok: boolean;
  /** HTTP status, or 0 when the request never produced a response. */
  status: number;
  /** Parsed JSON body when there was one - present on error responses too. */
  data?: T;
  /** User-safe one-line explanation. Set whenever `ok` is false. */
  error?: string;
  /** Our deadline fired. Distinct from a transport failure. */
  timedOut?: boolean;
  /** The CALLER's signal aborted (navigation, unmount) - not a real failure. */
  aborted?: boolean;
}

export interface FetchJsonInit extends RequestInit {
  /** Hard deadline covering headers AND body. Default 10s. */
  timeoutMs?: number;
}

export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

const TIMEOUT_COPY = "This is taking longer than usual - please try again.";
const NETWORK_COPY = "Network error - please try again.";

/** Best-effort user-safe message for an HTTP error that carried a JSON body. */
function httpCopy(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const err = (body as { error?: unknown }).error;
    if (typeof err === "string" && err.trim()) return err.trim();
  }
  if (status === 429) return "Too many attempts - please wait a moment.";
  if (status >= 500) return "The server had a problem - please try again.";
  return "Something went wrong.";
}

/**
 * fetch + JSON parse that always settles within `timeoutMs` and never throws.
 *
 * A caller-supplied `signal` is honoured in addition to the deadline, so an
 * unmounting component can still cancel; the result then carries
 * `aborted: true`, which callers should treat as "no news", not as an error to
 * show, because the user has already moved on.
 */
export async function fetchJson<T = unknown>(
  url: string,
  init: FetchJsonInit = {}
): Promise<FetchJsonResult<T>> {
  const { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, signal: caller, ...rest } = init;

  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, Math.max(1, timeoutMs));
  // A pending timer must never hold a Node process open (SSR / tests).
  (timer as unknown as { unref?: () => void }).unref?.();

  const onCallerAbort = () => ctrl.abort();
  if (caller) {
    if (caller.aborted) ctrl.abort();
    else caller.addEventListener("abort", onCallerAbort, { once: true });
  }

  try {
    const res = await fetch(url, { ...rest, signal: ctrl.signal });
    let data: T | undefined;
    try {
      // 204/empty bodies are legitimate; a parse failure is not fatal on its own
      // because the status may already carry everything the caller needs.
      const text = await res.text();
      data = text ? (JSON.parse(text) as T) : undefined;
    } catch (err) {
      // ...but a body read that was ABORTED is a different animal: the response
      // never actually arrived, and reporting it as a successful empty body
      // would re-open the exact hang this helper exists to close (a server that
      // streams headers and then stalls mid-body).
      if (ctrl.signal.aborted) throw err;
      data = undefined;
    }
    if (res.ok) return { ok: true, status: res.status, data };
    return { ok: false, status: res.status, data, error: httpCopy(res.status, data) };
  } catch {
    // Only three things land here: our deadline, the caller's abort, or a real
    // transport failure. They read very differently to a user, so they are kept
    // apart rather than flattened into one "network error".
    if (timedOut) return { ok: false, status: 0, timedOut: true, error: TIMEOUT_COPY };
    if (caller?.aborted) return { ok: false, status: 0, aborted: true };
    return { ok: false, status: 0, error: NETWORK_COPY };
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener("abort", onCallerAbort);
  }
}
