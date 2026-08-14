"use client";

import { useState } from "react";
import { Modal } from "./Modal";
import { useI18n } from "@/lib/i18n";
import { LegalDoc } from "./LegalDoc";
import {
  PRIVACY_SECTIONS,
  TERMS_SECTIONS,
  TERMS_VERSION,
  withOperator,
} from "@/lib/legal";

// Terms of Use + Privacy Policy popup, rendered from the single legal source
// (lib/legal.ts) so it always matches the /terms and /privacy pages. Aggressive
// zero-liability tone; Israel / Tel Aviv governing law.
export function TermsModal({
  onClose,
  operatorName,
}: {
  onClose: () => void;
  /**
   * The legal entity from the Key Vault. The clauses interpolate a placeholder
   * ("the Operator") and the owner sets the real name in Admin -> Keys; the
   * substitution happens here so there is still one copy of the text.
   */
  operatorName?: string;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"terms" | "privacy">("terms");
  const terms = withOperator(TERMS_SECTIONS, operatorName);
  const privacy = withOperator(PRIVACY_SECTIONS, operatorName);
  return (
    <Modal onClose={onClose} center>
      <div className="mb-3 flex gap-2">
        <button
          onClick={() => setTab("terms")}
          className={`btn btn-sm rounded-full px-3 py-1.5 text-[12px] font-bold ${
            tab === "terms" ? "bg-brandblue text-white" : "border border-line text-soft"
          }`}
        >
          {t("Terms of Use")}
        </button>
        <button
          onClick={() => setTab("privacy")}
          className={`btn btn-sm rounded-full px-3 py-1.5 text-[12px] font-bold ${
            tab === "privacy" ? "bg-brandblue text-white" : "border border-line text-soft"
          }`}
        >
          {t("Privacy Policy")}
        </button>
      </div>
      <div className="max-h-[60dvh] overflow-y-auto pr-1">
        {tab === "terms" ? (
          <LegalDoc title={t("Terms of Use")} version={TERMS_VERSION} sections={terms} />
        ) : (
          <LegalDoc title={t("Privacy Policy")} version={TERMS_VERSION} sections={privacy} />
        )}
      </div>
      <button onClick={onClose} className="btn btn-primary mt-4 w-full rounded-2xl py-2.5 text-sm">
        {t("I understand")}
      </button>
    </Modal>
  );
}
