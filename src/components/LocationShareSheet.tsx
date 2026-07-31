"use client";

// "The shop asked where you are." - the traveller decides what to answer.
//
// This exists because a shop asking for a location is almost always asking a
// practical question ("can we deliver to you?"), but the app cannot answer it
// on the traveller's behalf: they may be at the hotel, on the way to it, or
// somewhere else entirely. So we show WHY they asked (their own words when we
// have them), then offer three honest choices: the saved stay, somewhere else
// from Maps, or where they are right now.
//
// PRIVACY INVARIANT (page.tsx:1497 documents the production leak this comes
// from): the browser NEVER posts coordinates. "Where I am now" is reverse
// geocoded into a NAMED place by PlaceAutocomplete through our own
// /api/geocode, and only that name travels; the server re-resolves it against
// Google before a single character reaches a shop.

import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { LoadingDots } from "./LoadingDots";
import { PlaceAutocomplete } from "./PlaceAutocomplete";
import { useI18n } from "@/lib/i18n";

export interface LocationShareResult {
  ok: boolean;
  reason?: string;
}

export function LocationShareSheet({
  shopName,
  askedQuote,
  onClose,
  onShare,
  searchOrigin,
}: {
  shopName: string;
  /** The shop's own question, when we have it - always better than a guess. */
  askedQuote?: string;
  onClose: () => void;
  /** `place` is a resolved place NAME, never coordinates. Omit to use the stay. */
  onShare: (place?: string) => Promise<LocationShareResult>;
  /** Where this search is centred (the town/area the traveller typed). A real,
   *  already-chosen place - the honest third answer when there is no saved stay
   *  and the traveller does not want to type another address. */
  searchOrigin?: string;
}) {
  const { t } = useI18n();
  const [picked, setPicked] = useState<string | null>(null);
  const [savedStay, setSavedStay] = useState<string | null>(null);
  // THREE ANSWERS, not two. Without the search origin a traveller with no
  // saved stay had exactly one option - type a new address - which is the
  // worst moment to ask for typing: the shop is waiting, and the app already
  // KNOWS an honest answer (the area they searched in).
  const [mode, setMode] = useState<"stay" | "origin" | "other">(
    searchOrigin ? "origin" : "other"
  );
  const [state, setState] = useState<"idle" | "sending" | "done" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);

  // The saved stay is the default answer when there is one - it is what the
  // agent would share anyway, and it is already server-verified.
  useEffect(() => {
    let alive = true;
    fetch("/api/profile/stay")
      .then((r) => r.json())
      .then((d) => {
        const label = typeof d?.stay?.label === "string" ? d.stay.label.trim() : "";
        if (!alive || !label) return;
        setSavedStay(label);
        setMode("stay");
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const canSend =
    state !== "sending" &&
    (mode === "stay"
      ? Boolean(savedStay)
      : mode === "origin"
        ? Boolean(searchOrigin)
        : Boolean(picked));

  async function send() {
    setState("sending");
    setError(null);
    const r = await onShare(
      mode === "other" ? picked ?? undefined : mode === "origin" ? searchOrigin : undefined
    );
    if (r.ok) {
      setState("done");
      setTimeout(onClose, 1200);
    } else {
      setState("failed");
      setError(
        r.reason === "no-stay"
          ? t("Add your hotel or address first - that's what we'd share.")
          : t("Could not share that just now. Try again in a moment.")
      );
    }
  }

  return (
    <Modal onClose={onClose}>
      <div className="space-y-3">
        <h3 className="text-[15px] font-extrabold text-strong">
          📍 {t("Share your location?")}
        </h3>
        <div className="rounded-2xl bg-card2 p-3">
          <p className="text-[12px] font-bold text-strong">
            {shopName} {t("asked where you are.")}
          </p>
          {askedQuote ? (
            <p className="mt-1 border-l-2 border-line pl-2 text-[11px] italic text-soft">
              &ldquo;{askedQuote}&rdquo;
            </p>
          ) : null}
          <p className="mt-1.5 text-[11px] text-soft">
            {askedQuote
              ? t("Shops usually ask this to check whether they can deliver the vehicle to you.")
              : t("They did not say why - it's most likely to check whether they can deliver the vehicle to you.")}
          </p>
        </div>

        {savedStay && (
          <button
            onClick={() => setMode("stay")}
            className={`w-full rounded-2xl border-2 p-3 text-left transition ${
              mode === "stay" ? "border-brandblue bg-brandblue-soft" : "border-line bg-card"
            }`}
          >
            <div className="text-[12px] font-extrabold text-strong">🏨 {t("Where I'm staying")}</div>
            <div className="mt-0.5 text-[11px] text-soft">{savedStay}</div>
          </button>
        )}

        {/* THE AREA THEY SEARCHED IN. Already chosen, already resolved, and
            the right answer far more often than typing a second address. */}
        {searchOrigin && (
          <button
            onClick={() => setMode("origin")}
            className={`w-full rounded-2xl border-2 p-3 text-left transition ${
              mode === "origin" ? "border-brandblue bg-brandblue-soft" : "border-line bg-card"
            }`}
          >
            <div className="text-[12px] font-extrabold text-strong">
              📍 {t("Where I'm searching")}
            </div>
            <div className="mt-0.5 text-[11px] text-soft">{searchOrigin}</div>
          </button>
        )}

        <div
          className={`rounded-2xl border-2 p-3 transition ${
            mode === "other" ? "border-brandblue bg-brandblue-soft" : "border-line bg-card"
          }`}
        >
          <button onClick={() => setMode("other")} className="w-full text-left">
            <div className="text-[12px] font-extrabold text-strong">
              🗺 {t("Somewhere else")}
            </div>
            <div className="mt-0.5 text-[11px] text-soft">
              {t("On your way to the hotel? Pick where you'd like to meet them.")}
            </div>
          </button>
          {mode === "other" && (
            <div className="mt-2">
              <PlaceAutocomplete
                placeholder={t("Search a place, or use where I am now")}
                showMyLocation
                value={picked ?? ""}
                onPick={(p) => setPicked(p.label)}
                // A REFUSED PERMISSION MUST NOT STRAND THE FLOW. The field
                // says so itself; here we also fall back to the pre-resolved
                // search origin, so the traveller can still answer the shop
                // with one tap instead of typing an address under pressure.
                onDenied={() => {
                  if (searchOrigin) setMode("origin");
                }}
              />
            </div>
          )}
        </div>

        <p className="text-[10px] leading-relaxed text-faint">
          {t("We only ever send the place name - never your live GPS position, and never to any shop you haven't messaged.")}
        </p>

        {error && <p className="text-[11px] font-bold text-brandred">{error}</p>}

        <div className="flex gap-2 pb-safe">
          <button
            onClick={onClose}
            className="btn btn-sm flex-1 rounded-2xl border-2 border-line py-2.5 text-[12px] font-extrabold text-soft"
          >
            {t("Not now")}
          </button>
          <button
            onClick={send}
            disabled={!canSend}
            className="btn btn-primary flex-[2] rounded-2xl py-2.5 text-[12px] font-extrabold disabled:opacity-50"
          >
            {state === "sending" ? (
              <LoadingDots light label={t("Sharing")} />
            ) : state === "done" ? (
              `✓ ${t("Shared")}`
            ) : (
              t("Share with this shop")
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
}
