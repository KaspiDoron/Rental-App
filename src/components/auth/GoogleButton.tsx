"use client";

// Everything Google Identity Services, in one component.
//
// WHY THIS EXISTS
//
// GSI was 55 lines of inline useEffect on the login page, and every one of its
// failure modes was invisible:
//
//  - The effect had `[]` deps but its target div lived inside a ternary. Signing
//    up unmounted the div; "Use a different email" mounted a BRAND NEW empty one;
//    the effect never re-ran, so renderButton was never called again and the user
//    got an empty gap with no message at all. Fixed structurally by keying the
//    render effect on the NODE (a callback ref) rather than on mount, so any
//    remount re-renders the button.
//  - `initialize` was given no `error_callback`, which is GSI's only channel for
//    popup-blocked / popup-closed / FedCM-opted-out. Dismiss the popup and the
//    page state did not change by one bit. Now every one of those maps to copy.
//  - The credential callback was created inside the `[]` effect, so it pinned the
//    FIRST render's handler - which pinned the first render's currencyChoice,
//    still the literal "USD" before the restore effect ran. A Google signup could
//    therefore persist the wrong currency. useCallbackRef fixes that by design.
//  - `width: 320` was a literal. At the 320px viewport CLAUDE.md mandates, the
//    content box is 240px, so the iframe hung 40px off each edge and was clipped.
//    The width is now measured from the container.
//
// The component reports UPWARD when it turns out to be unusable
// (`onUnavailable`) instead of leaving a hole: the parent drops both this button
// AND the divider above it, which is what makes an orphaned "OR" impossible
// rather than merely unlikely.

import { useCallback, useEffect, useState } from "react";
import { Skeleton } from "../Skeleton";
import { LoadingDots } from "../LoadingDots";
import { useCallbackRef } from "../useCallbackRef";
import { useI18n } from "../../lib/i18n";
import { GsiLoadError, gsiButtonWidth, gsiFailureCopy, loadGsi } from "../../lib/auth/gsi";

/**
 * GSI paints nothing and logs to the console when this page's origin is missing
 * from the OAuth client's "Authorized JavaScript origins" - the classic
 * new-domain miss. There is no callback for it, so an empty container after the
 * button has had time to paint is the only available signal.
 */
const PAINT_PROBE_MS = 2500;

const ORIGIN_NOT_AUTHORIZED =
  "Google sign-in is not enabled for this domain yet (the site owner must authorize it in Google Cloud Console). Email login below works.";

/** GSI error codes that mean "the user or the browser stopped this attempt". */
function gsiPromptCopy(type: string | undefined): string {
  switch (type) {
    case "popup_closed_by_user":
      return "Sign-in was closed before it finished - tap the Google button to try again.";
    case "popup_failed_to_open":
      return "Your browser blocked the Google pop-up - allow pop-ups for this site, or use email below.";
    case "unknown":
    default:
      return "Google sign-in could not be completed - please try again or use email below.";
  }
}

export interface GoogleButtonProps {
  clientId: string;
  /** Receives the Google ID token. Wrapped so it can never go stale. */
  onCredential: (credential: string) => void;
  /**
   * Called once when this method turns out to be unusable on this device or
   * deployment. The parent removes the button AND the divider.
   */
  onUnavailable?: (reason: string) => void;
  /** Called for recoverable, user-facing GSI errors (popup closed/blocked). */
  onError?: (message: string) => void;
  /** Another method is mid-handshake - do not accept a second press. */
  disabled?: boolean;
  /** THIS method is mid-handshake - show its own pending state. */
  busy?: boolean;
}

export function GoogleButton({
  clientId,
  onCredential,
  onUnavailable,
  onError,
  disabled = false,
  busy = false,
}: GoogleButtonProps) {
  const { t } = useI18n();
  // Callback ref, NOT useRef: a remount hands us a new node and re-runs the
  // effect below, which is the whole fix for the vanishing-button bug.
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [painted, setPainted] = useState(false);

  // Stable identities, so the effect below never re-subscribes and the GSI
  // callback always reaches the LATEST handler rather than the first render's.
  const emitCredential = useCallbackRef(onCredential);
  const emitUnavailable = useCallbackRef((reason: string) => onUnavailable?.(reason));
  const emitError = useCallbackRef((message: string) => onError?.(message));

  const attach = useCallback((el: HTMLDivElement | null) => setNode(el), []);

  useEffect(() => {
    if (!node || !clientId) return;
    let cancelled = false;
    let probe: ReturnType<typeof setTimeout> | null = null;

    loadGsi()
      .then((gsi) => {
        if (cancelled) return;
        gsi.accounts.id.initialize({
          client_id: clientId,
          callback: (resp: { credential?: string }) => {
            if (resp?.credential) emitCredential(resp.credential);
          },
          // The channel that did not exist before: without it a blocked or
          // dismissed popup changed nothing on screen.
          error_callback: (err: { type?: string }) => {
            if (!cancelled) emitError(gsiPromptCopy(err?.type));
          },
        });
        const width = gsiButtonWidth(node.clientWidth);
        gsi.accounts.id.renderButton(node, {
          theme: "outline",
          size: "large",
          shape: "pill",
          text: "continue_with",
          logo_alignment: "center",
          ...(width ? { width } : {}),
        });
        // Painting is asynchronous inside GSI, so "did it work" can only be
        // answered a beat later - see PAINT_PROBE_MS.
        probe = setTimeout(() => {
          if (cancelled) return;
          if (node.childElementCount === 0) emitUnavailable(ORIGIN_NOT_AUTHORIZED);
          else setPainted(true);
        }, PAINT_PROBE_MS);
        (probe as unknown as { unref?: () => void }).unref?.();
        // A button that is already in the DOM should not wait for the probe to
        // drop its skeleton.
        if (node.childElementCount > 0) setPainted(true);
      })
      .catch((err) => {
        if (cancelled) return;
        emitUnavailable(
          err instanceof GsiLoadError ? err.message : gsiFailureCopy("script-error")
        );
      });

    return () => {
      cancelled = true;
      if (probe) clearTimeout(probe);
    };
  }, [node, clientId, emitCredential, emitUnavailable, emitError]);

  return (
    <div
      className={`relative flex w-full min-w-0 justify-center ${
        disabled && !busy ? "pointer-events-none opacity-50" : ""
      }`}
      aria-busy={busy || !painted}
    >
      {/* min-h keeps a 44px tap target reserved so nothing below jumps when the
          iframe lands, and overflow-hidden contains the GSI iframe at 320px. */}
      <div
        ref={attach}
        className={`flex min-h-[44px] w-full max-w-[360px] items-center justify-center overflow-hidden ${
          busy ? "pointer-events-none opacity-0" : ""
        }`}
      />
      {!painted && !busy && (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
          role="status"
          aria-label={t("Loading Google sign-in")}
        >
          <Skeleton className="h-11 w-full max-w-[360px]" rounded="rounded-full" />
        </div>
      )}
      {busy && (
        <div className="absolute inset-0 flex items-center justify-center">
          <LoadingDots label={t("Signing you in")} />
        </div>
      )}
    </div>
  );
}
