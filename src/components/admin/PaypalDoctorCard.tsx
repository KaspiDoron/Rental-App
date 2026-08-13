"use client";

// PAYPAL WEBHOOK DOCTOR card (management-only, wave 4.3). The webhook is the
// ONLY path that can lower a plan when someone cancels - and it was never
// registered. This card makes the state visible and the repair one button:
// Connect registers (or repairs) the webhook via PayPal's API using the
// credentials already in the vault and stores the id in PAYPAL_WEBHOOK_ID.
// Reconcile is the webhook-independent sweep: it asks PayPal per paid
// account whether any recorded subscription still entitles it.

import { useCallback, useEffect, useState } from "react";
import { LoadingDots } from "../LoadingDots";

interface Diagnosis {
  state: "unconfigured" | "unreadable" | "absent" | "mismatch" | "verified";
  expectedUrl: string | null;
  storedId: string | null;
  detail: string;
  error?: string;
}

interface ReconcileOut {
  checked: number;
  downgraded: string[];
  kept: number;
  unknown: number;
  error?: string;
}

const TONE: Record<Diagnosis["state"], string> = {
  verified: "border-savings bg-savings-soft text-savings",
  unconfigured: "border-line bg-card2 text-soft",
  unreadable: "border-brandyellow bg-brandyellow-soft text-warn",
  absent: "border-brandred bg-brandred-soft text-brandred",
  mismatch: "border-brandred bg-brandred-soft text-brandred",
};

export function PaypalDoctorCard() {
  const [diag, setDiag] = useState<Diagnosis | null>(null);
  const [busy, setBusy] = useState<"load" | "connect" | "reconcile" | null>("load");
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy("load");
    try {
      const d = (await (await fetch("/api/admin/paypal-doctor")).json()) as Diagnosis;
      setDiag(d);
    } catch {
      setDiag(null);
    } finally {
      setBusy(null);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function act(action: "connect" | "reconcile") {
    setBusy(action);
    setNote(null);
    try {
      const r = await fetch("/api/admin/paypal-doctor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const d = await r.json();
      if (action === "reconcile") {
        const out = d as ReconcileOut;
        setNote(
          out.error
            ? out.error
            : `Checked ${out.checked} paid account(s): ${out.downgraded.length} downgraded, ${out.kept} kept, ${out.unknown} left untouched (unreadable or not PayPal-granted).`
        );
      } else if (d?.error) {
        setNote(String(d.error));
      }
      await load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "network error");
      setBusy(null);
    }
  }

  return (
    <div className="surface rounded-blob p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[13px] font-extrabold text-strong">💳 PayPal webhook doctor</h3>
        <button onClick={() => void load()} className="btn btn-ghost btn-sm rounded-full px-2.5 py-1 text-[11px]">
          ↻
        </button>
      </div>
      {diag === null && busy === "load" ? (
        <LoadingDots label="Asking PayPal" />
      ) : diag === null ? (
        <p className="text-[12px] font-bold text-brandred">
          The doctor endpoint could not be reached - that is unknown, not healthy.
        </p>
      ) : (
        <div className="space-y-2">
          <div className={`rounded-2xl border-2 p-3 text-[12px] font-bold ${TONE[diag.state]}`}>
            <span className="uppercase">{diag.state}</span> - {diag.detail}
          </div>
          {diag.expectedUrl && (
            <p className="break-all text-[11px] font-bold text-faint">
              Expected URL: {diag.expectedUrl}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => void act("connect")}
              disabled={busy !== null || diag.state === "unconfigured"}
              className="btn btn-primary rounded-2xl px-3 py-2 text-[12px] disabled:opacity-60"
            >
              {busy === "connect" ? <LoadingDots light label="Connecting" /> : "Connect webhook"}
            </button>
            <button
              onClick={() => void act("reconcile")}
              disabled={busy !== null || diag.state === "unconfigured"}
              className="btn btn-ghost rounded-2xl px-3 py-2 text-[12px] disabled:opacity-60"
            >
              {busy === "reconcile" ? <LoadingDots label="Reconciling" /> : "Reconcile plans now"}
            </button>
          </div>
          {note && <p className="text-[11.5px] font-bold text-soft">{note}</p>}
        </div>
      )}
    </div>
  );
}
