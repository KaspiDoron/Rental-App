"use client";

import { useState } from "react";
import { Modal } from "./Modal";
import { LegalDoc } from "./LegalDoc";
import {
  PRIVACY_SECTIONS,
  TERMS_SECTIONS,
  TERMS_VERSION,
} from "@/lib/legal";

// Terms of Use + Privacy Policy popup, rendered from the single legal source
// (lib/legal.ts) so it always matches the /terms and /privacy pages. Aggressive
// zero-liability tone; Israel / Tel Aviv governing law.
export function TermsModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<"terms" | "privacy">("terms");
  return (
    <Modal onClose={onClose} center>
      <div className="mb-3 flex gap-2">
        <button
          onClick={() => setTab("terms")}
          className={`btn btn-sm rounded-full px-3 py-1.5 text-[12px] font-bold ${
            tab === "terms" ? "bg-brandblue text-white" : "border border-line text-soft"
          }`}
        >
          Terms of Use
        </button>
        <button
          onClick={() => setTab("privacy")}
          className={`btn btn-sm rounded-full px-3 py-1.5 text-[12px] font-bold ${
            tab === "privacy" ? "bg-brandblue text-white" : "border border-line text-soft"
          }`}
        >
          Privacy Policy
        </button>
      </div>
      <div className="max-h-[60dvh] overflow-y-auto pr-1">
        {tab === "terms" ? (
          <LegalDoc title="Terms of Use" version={TERMS_VERSION} sections={TERMS_SECTIONS} />
        ) : (
          <LegalDoc title="Privacy Policy" version={TERMS_VERSION} sections={PRIVACY_SECTIONS} />
        )}
      </div>
      <button onClick={onClose} className="btn btn-primary mt-4 w-full rounded-2xl py-2.5 text-sm">
        I understand
      </button>
    </Modal>
  );
}
