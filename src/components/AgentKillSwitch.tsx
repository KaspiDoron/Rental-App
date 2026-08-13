"use client";

// AgentKillSwitch - the premium "Pause / Resume agent operations" control that
// lives in the Find Deals live-status area while a hunt is running. One tap
// flips the whole search session between ACTIVE (agents keep negotiating) and
// PAUSED (nothing is sent - replies still land and are stored, the agents just
// hold). The server side already enforces the pause HARD in two places
// (wa-guard rule 0.1 on the outbound path + the reply loop's pause gate), so
// this component is purely the missing, honest UI over the existing
// /api/session/pause route.
//
// Design: gradient-bordered glass card, a breathing state dot (green pulse when
// active, amber steady when paused), clear "Agents active" / "Agents paused"
// copy, and an optimistic-but-server-confirmed toggle that shows a spinner and
// disables itself mid-switch. On a failed toggle it reverts and says so - it
// must never claim "stopped" when the server did not confirm the hold.

import { useCallback, useMemo } from "react";
import { useI18n } from "@/lib/i18n";
import { useVersionedToggle } from "@/lib/client/versioned-toggle";
import { Icon } from "./icons";
import { LoadingDots } from "./LoadingDots";

export function AgentKillSwitch({
  className = "",
  serverPaused,
  serverPausedVersion,
}: {
  className?: string;
  /** Live pause state from the activity poll. This component used to read the
   * server ONCE on mount, so a session paused afterwards (by Will, by another
   * tab, by the phone in a pocket) kept showing "Agents active" above a queue
   * whose every row said "Paused by you". Following the poll makes the two
   * surfaces structurally incapable of disagreeing. */
  serverPaused?: boolean;
  /** The VERSION of that value. Pause state is cached 30s per server instance,
   * so right after a resume a different instance can answer the poll with the
   * pre-resume value - not wrong, just OLD. Without a version the switch applied
   * it and flipped back to "paused" on its own. */
  serverPausedVersion?: number;
}) {
  const { t } = useI18n();

  const read = useCallback(async (known: number) => {
    const r = await fetch(`/api/session/pause?known=${known}`, { cache: "no-store" });
    const d = await r.json().catch(() => ({}));
    return { value: Boolean(d?.paused), version: Number(d?.version) || 0 };
  }, []);

  const write = useCallback(async (next: boolean) => {
    const r = await fetch("/api/session/pause", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: next ? "pause" : "resume" }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d?.ok === false) return null; // the hold was NOT saved
    return { value: Boolean(d?.paused), version: Number(d?.version) || Date.now() };
  }, []);

  const incoming = useMemo(
    () =>
      typeof serverPaused === "boolean" && typeof serverPausedVersion === "number"
        ? { value: serverPaused, version: serverPausedVersion }
        : null,
    [serverPaused, serverPausedVersion]
  );

  const errorFor = useCallback(
    (next: boolean) =>
      next
        ? t("Could not pause - the agents may still be sending. Try again.")
        : t("Could not resume. Try again."),
    [t]
  );

  const { value: paused, busy, error, toggle } = useVersionedToggle({
    read,
    write,
    incoming,
    errorFor,
  });

  const isPaused = paused === true;
  const loading = paused === null;

  return (
    <div className={className}>
      <div
        className={`relative overflow-hidden rounded-2xl p-[1.5px] transition-colors ${
          isPaused
            ? "bg-gradient-to-r from-amber-400/70 via-orange-400/60 to-amber-400/70"
            : "bg-gradient-to-r from-emerald-400/70 via-brandblue/60 to-emerald-400/70"
        }`}
      >
        <button
          type="button"
          onClick={toggle}
          disabled={busy || loading}
          aria-pressed={isPaused}
          className="flex w-full items-center gap-3 rounded-[15px] bg-card px-3.5 py-3 text-left disabled:opacity-90"
        >
          {/* Breathing state dot */}
          <span className="relative flex h-3 w-3 shrink-0 items-center justify-center">
            {!isPaused && !loading && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" />
            )}
            <span
              className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
                loading ? "bg-faint" : isPaused ? "bg-amber-500" : "bg-emerald-500"
              }`}
            />
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[13px] font-extrabold text-strong">
              {loading
                ? t("Checking agent status…")
                : isPaused
                  ? t("Agents paused")
                  : t("Agents active")}
            </div>
            <div className="truncate text-[11px] font-semibold text-soft">
              {loading
                ? ""
                : isPaused
                  ? t("Nothing is being sent - replies still arrive")
                  : t("Negotiating for you across your shops")}
            </div>
          </div>

          {/* Action affordance */}
          <span
            className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-extrabold ${
              isPaused
                ? "bg-emerald-500 text-white"
                : "bg-card2 text-strong ring-1 ring-line"
            }`}
          >
            {busy ? (
              /* The second and last bare border spinner - same primitive as
                 everywhere else now. */
              <LoadingDots />
            ) : (
              <Icon name={isPaused ? "play" : "pause"} className="h-3 w-3" />
            )}
            {busy
              ? t("Working…")
              : isPaused
                ? t("Resume")
                : t("Pause")}
          </span>
        </button>
      </div>
      {error && (
        <p className="mt-1 px-1 text-[10px] font-bold text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}
