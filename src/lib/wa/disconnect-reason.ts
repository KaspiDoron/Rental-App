// WHY A DEAD SESSION READ AS HEALTHY FOREVER.
//
// Evolution's connection.update carries the disconnect cause as a NUMBER -
// Baileys' DisconnectReason enum, which is a set of HTTP-ish status codes. The
// ingest matched it against WORDS:
//
//     /logged.?out|conflict|banned|forbidden|multidevice.?mismatch/
//         .test(String(statusReason).toLowerCase())
//
// `String(401).toLowerCase()` is `"401"`, which matches none of them, so the
// branch never fired. Two of the alternatives (`forbidden`, `conflict`) WOULD
// match a Boom payload string, but Evolution does not forward `lastDisconnect`
// on the webhook, so those fields are never populated either.
//
// The consequence was not a missing metric. Nothing anywhere wrote
// `wa_sessions.status = "close"`, so `isLinkedForUi` kept reporting linked,
// `/api/wa/status` kept reporting CONNECTED, `classifySafety`'s one red branch
// was unreachable, and the outbox kept retrying into a link that was gone for
// 24 hours before silently dropping. A banned traveller was told everything was
// fine.
//
// This module is the taxonomy, kept separate from the ingest so it is unit
// testable without a webhook.

/** Baileys DisconnectReason, by the numeric value that actually arrives. */
export const DISCONNECT_REASONS = {
  400: "badRequest",
  401: "loggedOut",
  403: "forbidden",
  408: "timedOut",
  411: "multideviceMismatch",
  428: "connectionClosed",
  440: "connectionReplaced",
  500: "badSession",
  503: "unavailableService",
  515: "restartRequired",
} as const;

export type DisconnectSeverity =
  /** The link is gone. Only re-pairing fixes it - stop queueing. */
  | "terminal"
  /** WhatsApp is refusing this client/account. Terminal AND risk-bearing. */
  | "enforcement"
  /** Normal churn: reconnect and carry on. */
  | "transient"
  /** We could not read a cause at all. */
  | "unknown";

export interface DisconnectVerdict {
  code: number | null;
  label: string;
  severity: DisconnectSeverity;
  /** Persist wa_sessions.status = "close" and stop pretending we are linked. */
  sessionDead: boolean;
  /** Enter ban-recovery. Strictly narrower than sessionDead. */
  banRisk: boolean;
}

/**
 * 401 is the ambiguous one and it is ambiguous in the WORST direction.
 *
 * It means loggedOut - a genuine ban or a "log out from linked devices" tap.
 * But Evolution also emits a 401 close as an ordinary beat of the pairing-code
 * handshake, immediately before the socket restarts with the real credentials.
 * Treating every 401 as a ban would pause a number the instant it links, which
 * is worse than the bug this file fixes.
 *
 * So 401 is resolved with the pairing window: inside it, this is handshake
 * churn; outside it, the link is genuinely gone. 515 (restartRequired) is
 * always handshake churn.
 */
const PAIRING_GRACE_MS = 120_000;

export function classifyDisconnect(
  raw: unknown,
  opts?: { pairingIssuedAt?: string | number | Date | null; now?: number }
): DisconnectVerdict {
  const code = coerceCode(raw);
  if (code === null) {
    return {
      code: null,
      label: "unknown",
      severity: "unknown",
      // UNKNOWN IS NOT DEAD. A cause we could not parse must never tear down a
      // working link - that is the mirror-image failure of the bug above, and
      // it would log users out on a malformed webhook.
      sessionDead: false,
      banRisk: false,
    };
  }

  const label = DISCONNECT_REASONS[code as keyof typeof DISCONNECT_REASONS] ?? `code-${code}`;

  if (code === 401) {
    const inPairing = withinPairingWindow(opts?.pairingIssuedAt, opts?.now);
    return {
      code,
      label,
      severity: inPairing ? "transient" : "terminal",
      sessionDead: !inPairing,
      // A logout we did not cause is the shape a restriction takes, but it is
      // also what "log out from linked devices" produces. Terminal, and worth
      // recording - the enforcement codes below are the ones that pause.
      banRisk: false,
    };
  }

  switch (code) {
    // WhatsApp is refusing this account or this client outright.
    case 403:
      return { code, label, severity: "enforcement", sessionDead: true, banRisk: true };
    // The account cannot run this client build. The link is unusable as-is.
    case 411:
      return { code, label, severity: "terminal", sessionDead: true, banRisk: false };
    // Another socket took the identity. The link still exists on the phone;
    // tearing our row down here would fight the other socket, not fix it.
    case 440:
      return { code, label, severity: "transient", sessionDead: false, banRisk: false };
    default:
      return { code, label, severity: "transient", sessionDead: false, banRisk: false };
  }
}

/** Accepts the number, the numeric string, or a Boom-ish payload object. */
function coerceCode(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (/^\d{3}$/.test(trimmed)) return Number(trimmed);
    // Evolution builds vary; some forward the word form. Map the ones that
    // correspond to a code so a string-emitting build is not silently ignored.
    const byName = Object.entries(DISCONNECT_REASONS).find(
      ([, name]) => name.toLowerCase() === trimmed.toLowerCase()
    );
    if (byName) return Number(byName[0]);
    return null;
  }
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    for (const key of ["statusCode", "status", "code"]) {
      const v = coerceCode(o[key]);
      if (v !== null) return v;
    }
    const output = o.output as Record<string, unknown> | undefined;
    if (output) return coerceCode(output.statusCode ?? output.status);
  }
  return null;
}

function withinPairingWindow(
  issuedAt?: string | number | Date | null,
  now = Date.now()
): boolean {
  if (issuedAt === null || issuedAt === undefined) return false;
  const ms =
    issuedAt instanceof Date
      ? issuedAt.getTime()
      : typeof issuedAt === "number"
        ? issuedAt
        : Date.parse(issuedAt);
  if (!Number.isFinite(ms)) return false;
  const age = now - ms;
  // A negative age is clock skew, not a live handshake we should trust.
  return age >= 0 && age < PAIRING_GRACE_MS;
}

/**
 * Pull the disconnect cause out of an Evolution connection.update payload,
 * trying every shape the builds emit rather than one.
 */
export function disconnectReasonFrom(data: unknown): unknown {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const last = d.lastDisconnect as Record<string, unknown> | undefined;
  const err = last?.error as Record<string, unknown> | undefined;
  return (
    d.statusReason ??
    d.statusCode ??
    (err?.output as Record<string, unknown> | undefined)?.statusCode ??
    err?.statusCode ??
    err?.message ??
    (err?.output as Record<string, unknown> | undefined)?.payload ??
    null
  );
}
