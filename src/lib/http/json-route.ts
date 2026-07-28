// EVERY ROUTE ANSWERS IN JSON. ALWAYS. EVEN WHEN IT BREAKS.
//
// The client's contract with every one of our API routes is "the body is JSON
// with a shape I know". Nothing enforced it. A route that threw got Next's
// error response; a route that outran the platform's request timeout got the
// gateway's HTML 504; a route that ran out of memory got nothing at all. In all
// three cases the browser did `await res.json()`, THAT threw, and the catch
// arm - written for a network failure - told the traveller
//
//     "Couldn't reach the server just now"
//
// ...while the server had in fact been reached, had often done the work, and
// had simply failed to say so in JSON. The message was wrong, the diagnosis was
// wrong, and every genuine server fault in the app looked like the user's wifi.
//
// This is the missing capability: a route's failure modes are part of its
// contract, not an accident of how it happened to die. `jsonRoute` guarantees
// three things for any handler it wraps:
//
//   1. A thrown exception becomes a JSON 500 carrying the reason.
//   2. Outrunning our own budget becomes a JSON 504 - BEFORE the platform's
//      HTML one - so a slow upstream is a state the UI can render, not a parse
//      error. The work is not cancelled: for a send route that means the
//      message may still land, and the reply says exactly that.
//   3. The body always carries `ok`, `error`, `transient` and `code`, so a
//      caller can tell "the server refused" from "the server stumbled" without
//      pattern-matching prose.
//
// Deliberately dependency-free (no `server-only`, no DB) so the shape is
// unit-testable, the same discipline as lib/vision-read.

/** Machine-readable failure kinds. Absent on a successful handler response. */
export type RouteFailureCode = "server-error" | "timeout";

export interface RouteFailureBody {
  ok: false;
  /**
   * USER-SAFE PROSE. The client's `fetchJson` surfaces `body.error` straight
   * into a banner, so this is copy, not a diagnostic - a traveller must never
   * read a connection string or a stack frame off a shop card.
   */
  error: string;
  /** The technical reason, for logs and Ops. Never rendered. */
  detail?: string;
  /** Worth retrying (a stumble) vs not (a refusal). Both are still JSON. */
  transient: boolean;
  code: RouteFailureCode;
}

/**
 * Our own budget, comfortably inside Next's `maxDuration = 60` and Cloud Run's
 * `--timeout 300`. The point is to always be the FIRST timer to fire, because
 * whoever fires first decides the content type of the response.
 */
export const ROUTE_BUDGET_MS = 45_000;

/** The exact body a failure produces. Exported so tests and the client agree. */
export function routeFailureBody(
  code: RouteFailureCode,
  error: string,
  detail?: string
): RouteFailureBody {
  return { ok: false, error, transient: true, code, ...(detail ? { detail } : {}) };
}

/** Never leak a stack trace or a connection string to a browser. */
export function safeReason(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? "unknown error");
  return raw.replace(/\s+/g, " ").trim().slice(0, 200) || "unknown error";
}

type Handler<A extends unknown[]> = (...args: A) => Promise<Response>;

/**
 * Wrap a route handler so it can only ever answer with JSON.
 *
 * @param name  Route label, used in the logged reason (never sent to the client
 *              as prose the user reads - the UI keys on `code`).
 */
export function jsonRoute<A extends unknown[]>(
  name: string,
  handler: Handler<A>,
  opts: { budgetMs?: number } = {}
): Handler<A> {
  const budgetMs = opts.budgetMs ?? ROUTE_BUDGET_MS;
  return async (...args: A): Promise<Response> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A race, not an abort: we do NOT cancel the handler. Half-cancelling a
      // send is worse than a slow one - the message may already be in flight,
      // and the idempotency claim makes the user's retry safe either way.
      const timeout = new Promise<Response>((resolve) => {
        timer = setTimeout(() => {
          resolve(
            jsonFailure(
              "timeout",
              `${name} is taking longer than usual - it is still working, and anything already sent is not lost.`,
              504
            )
          );
        }, budgetMs);
      });
      return await Promise.race([handler(...args), timeout]);
    } catch (e) {
      // The traveller gets copy; the reason goes in `detail`, for logs and Ops.
      // `fetchJson` renders `body.error` verbatim into a banner, so a raw
      // exception message here would put our internals on a shop card.
      return jsonFailure(
        "server-error",
        "Something broke on our side, not yours - nothing was lost. Try again in a moment.",
        500,
        `${name}: ${safeReason(e)}`
      );
    } finally {
      clearTimeout(timer);
    }
  };
}

function jsonFailure(
  code: RouteFailureCode,
  error: string,
  status: number,
  detail?: string
): Response {
  // Hand-built rather than NextResponse.json: this is the path that runs when
  // things are already going wrong, and it must not depend on anything that
  // could itself throw.
  return new Response(JSON.stringify(routeFailureBody(code, error, detail)), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
