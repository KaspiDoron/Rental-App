// The ONE definition of "where is this WhatsApp pairing right now".
//
// Before this module the UI had no notion of an in-between state: WaConnect
// branched only on `connected`, so a screen could simultaneously show a pairing
// code, a rotating "Almost there..." reassurance, and a banner saying the server
// never handed out a code. Three mutually exclusive claims at once.
//
// The phase is DERIVED, never stored - it is a pure function of what the server
// last told us plus what the user can currently see. Keeping it pure means the
// transitions are unit-testable and the component cannot drift from the API.
//
// A note on AUTHENTICATING: Evolution reports `connecting` both BEFORE the user
// enters the code and WHILE WhatsApp verifies it - the two are genuinely
// indistinguishable from the connection state alone. We therefore treat the
// elapsed credential window as the signal: once the code we displayed has aged
// out and the instance is still `connecting`, the user has most likely entered
// it and verification is under way. That is the moment regeneration must stop.

export type ConnectionPhase =
  | "DISCONNECTED"
  | "GENERATING_QR"
  | "SCAN_PENDING"
  | "AUTHENTICATING"
  | "CONNECTED"
  | "FAILED";

export interface PhaseInput {
  /** Raw Evolution state: "open" | "connecting" | "disconnected" | "unknown". */
  state?: string | null;
  /** Durable pairing flag from wa_sessions (survives a socket blip). */
  paired?: boolean;
  /** A pairing code or QR is on screen right now. */
  hasCredential?: boolean;
  /** Milliseconds of life left in the displayed credential (null = unknown). */
  credentialMsLeft?: number | null;
  /** A /api/wa/connect request is in flight. */
  requesting?: boolean;
  /** The Evolution host itself is down/restarting. */
  hostDown?: boolean;
  /** Terminal give-up: overall deadline exceeded, or a hard error. */
  failed?: boolean;
}

/**
 * Map the raw signals onto exactly one phase. Order matters: the checks run
 * most-certain first so an ambiguous lower signal can never mask a definite one.
 */
export function deriveConnectionPhase(input: PhaseInput): ConnectionPhase {
  // 1. CONNECTED is unconditional - a live socket or a durable pairing outranks
  //    everything, including an error left over from an earlier attempt.
  if (input.state === "open" || input.paired === true) return "CONNECTED";

  // 2. Terminal failure states.
  if (input.failed === true) return "FAILED";
  if (input.hostDown === true) return "FAILED";

  // 3. A credential is on screen: either the user still has time to enter it,
  //    or its window lapsed and verification is presumed under way.
  if (input.hasCredential === true) {
    const left = input.credentialMsLeft;
    const lapsed = typeof left === "number" && left <= 0;
    if (lapsed && input.state === "connecting") return "AUTHENTICATING";
    if (lapsed) return "AUTHENTICATING";
    return "SCAN_PENDING";
  }

  // 4. No credential yet. An in-flight request is us minting one; a `connecting`
  //    instance with nothing on screen means the handshake outlived its code.
  if (input.requesting === true) return "GENERATING_QR";
  if (input.state === "connecting") return "AUTHENTICATING";

  return "DISCONNECTED";
}

/** Phases where the pairing credential must NOT be regenerated underneath the
 *  user - either they are mid-entry or WhatsApp is already verifying. */
export function isFrozen(phase: ConnectionPhase): boolean {
  return phase === "AUTHENTICATING" || phase === "CONNECTED";
}

/** Phases that mean "nothing is happening, offer the user a way to start". */
export function isIdle(phase: ConnectionPhase): boolean {
  return phase === "DISCONNECTED" || phase === "FAILED";
}

/** One honest sentence per phase. The component renders exactly this - it never
 *  composes its own competing status text. */
export function phaseHeadline(phase: ConnectionPhase): string {
  switch (phase) {
    case "CONNECTED":
      return "Connected";
    case "GENERATING_QR":
      return "Asking WhatsApp for your code...";
    case "SCAN_PENDING":
      return "Enter this code in WhatsApp";
    case "AUTHENTICATING":
      return "Verifying with WhatsApp - keep this screen open";
    case "FAILED":
      return "That didn't go through";
    case "DISCONNECTED":
    default:
      return "Not connected";
  }
}
