"use client";

// THE ACCEPTANCE THAT ACTUALLY BLOCKS.
//
// The signup form collected three consents, which covered the person who signed
// up through that form on the day they did it - and nobody else, ever again. A
// Google sign-in stamped acceptedTerms server-side without ever showing the
// text. And when the terms themselves changed, TERMS_VERSION moved and not one
// user was asked anything, because nothing read it.
//
// This is the owner's decision made real: the terms are a MANDATORY first
// touch. It is not dismissable, there is no backdrop tap and no Escape - the
// app is behind it until the acceptance is recorded, and the record carries the
// version so the next bump asks again.
//
// It is deliberately NOT a wall of text with a tick box at the bottom. The six
// named risks each get their one-line summary (the same `summary` field the
// Terms render from, so the short version and the full version cannot drift),
// with the full document one tap away.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { INDEMNITY_CLAUSES, TERMS_VERSION, withOperatorText } from "@/lib/legal";
import { useI18n } from "@/lib/i18n";
import { TermsModal } from "./TermsModal";

interface MeResponse {
  session: { email: string } | null;
  profile: { needsTerms?: boolean; termsReason?: string } | null;
  operatorName?: string;
}

export function FirstTouchTerms() {
  const { t } = useI18n();
  const [show, setShow] = useState(false);
  const [reason, setReason] = useState<string>("first-time");
  const [operator, setOperator] = useState("");
  const [full, setFull] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: MeResponse | null) => {
        if (!alive || !d?.session || !d.profile?.needsTerms) return;
        setReason(d.profile.termsReason ?? "first-time");
        setOperator(d.operatorName ?? "");
        setShow(true);
      })
      .catch(() => {
        /* signed out, offline - the gate is server-decided, not guessed here */
      });
    return () => {
      alive = false;
    };
  }, []);

  // Scroll lock while the gate is up. Modal does this for itself; this one is
  // not a Modal precisely because Modal can be dismissed.
  useEffect(() => {
    if (!show) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [show]);

  if (!show) return null;

  const accept = async () => {
    setSaving(true);
    setFailed(false);
    try {
      const res = await fetch("/api/legal/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "terms" }),
      });
      // THE GATE ONLY OPENS ON A RECORDED ACCEPTANCE. Closing it optimistically
      // would put the user in the app with no record of the thing this whole
      // screen exists to record - which is the exact failure it replaces.
      if (!res.ok) {
        setFailed(true);
        return;
      }
      setShow(false);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  // TRANSLATE THE CANONICAL TEXT, THEN SUBSTITUTE THE OPERATOR.
  //
  // This used to call `withOperator` first, which rewrites the clause array
  // BEFORE render. A deployment with a custom operator name therefore produced
  // text that is not the canonical string, so it is not in the i18n catalogue,
  // so `t()` refuses it - and the clause shipped in English. Doing it the other
  // way round keeps the catalogue to one fixed set whatever the operator is
  // called. See withOperatorText for why that is safe.
  const clauses = INDEMNITY_CLAUSES;
  const op = (text: string) => withOperatorText(t(text), operator);

  const gate = (
    <div
      className="layer-veil fixed inset-0 flex items-end justify-center bg-black/60 p-3 backdrop-blur-sm sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={t("Terms of Use")}
    >
      <div className="surface w-full max-w-[420px] rounded-blob p-4 pb-safe shadow-2xl">
        <h2 className="text-[17px] font-extrabold leading-tight text-strong">
          {reason === "version-bump"
            ? t("The terms have changed")
            : t("Before your agents message anyone")}
        </h2>
        <p className="mt-1 text-[12px] font-bold leading-snug text-soft">
          {reason === "version-bump"
            ? t("A new version is in force. Please read what changed and accept to carry on.")
            : t("WheelDeal sends real WhatsApp messages from your own number. Six things can go wrong, and they are yours to carry.")}
        </p>

        <ul className="mt-3 max-h-[42dvh] space-y-2 overflow-y-auto rounded-2xl bg-card2 p-3">
          {clauses.map((c) => (
            <li key={c.anchor} className="text-[12px] leading-relaxed text-soft">
              <span className="font-extrabold text-strong">{op(c.title)}.</span> {op(c.summary)}
            </li>
          ))}
        </ul>

        <button
          onClick={() => setFull(true)}
          className="mt-2 w-full text-[11px] font-extrabold text-brandblue underline"
        >
          {t("Read the full Terms of Use and Privacy Policy")}
        </button>

        {failed && (
          <p className="mt-2 rounded-xl bg-warn-soft p-2 text-[11px] font-bold leading-snug text-warn">
            {t("We could not record your acceptance. Check your connection and try again - nothing is sent from your number until this is saved.")}
          </p>
        )}

        <button
          onClick={accept}
          disabled={saving}
          className="btn btn-primary mt-3 w-full rounded-2xl py-3 text-sm font-extrabold disabled:opacity-60"
        >
          {saving ? t("Saving...") : t("I have read and accept")}
        </button>
        <p className="mt-1.5 text-center text-[10px] font-bold text-soft">
          {t("Version")} {TERMS_VERSION}
        </p>
      </div>
      {full && <TermsModal onClose={() => setFull(false)} operatorName={operator} />}
    </div>
  );

  // Portalled for the same reason every other overlay is: an ancestor with a
  // backdrop-filter or a transform would become the containing block and pin a
  // "fixed" gate inside a scrolling panel.
  return typeof document === "undefined" ? gate : createPortal(gate, document.body);
}
