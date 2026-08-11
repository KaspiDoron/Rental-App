"use client";

import { Modal } from "./Modal";
import { useI18n } from "@/lib/i18n";

const CLAUSES: [string, string][] = [
  [
    "Nature of the service",
    "WheelDeal (the \"Service\", together with its owner, operators, founders, directors, employees, contractors, agents, affiliates, successors and assigns, the \"Released Parties\") provides a purely optional, convenience software interface that, solely upon your own express instruction, drafts and transmits text messages to third-party rental businesses that you yourself select, using a connection to your own personal WhatsApp account that you yourself voluntarily establish.",
  ],
  [
    "Unofficial method; no affiliation",
    "You expressly understand and agree that the linking mechanism relies on the unofficial \"WhatsApp Web\" multi-device protocol; that WhatsApp LLC, Meta Platforms, Inc. and their affiliates (\"WhatsApp\") do not authorize, endorse, support or permit automated or programmatic tooling in connection with WhatsApp; that the Released Parties are not affiliated with, sponsored by, endorsed by or connected to WhatsApp in any manner; and that your use may constitute a violation of WhatsApp's Terms of Service for which YOU, and you alone, bear sole and exclusive responsibility.",
  ],
  [
    "Assumption of risk",
    "You knowingly, voluntarily and freely assume all risks of every kind and nature, whether known or unknown, foreseeable or unforeseeable, arising out of or relating to the linking, connection, transmission or use contemplated herein, including without limitation the risk that your WhatsApp account and/or telephone number may be rate-limited, throttled, restricted, suspended, banned, blocked, disabled, deleted or otherwise rendered inoperative, with or without notice, by WhatsApp or any other party, for any reason or for no reason at all.",
  ],
  [
    "Total release and waiver",
    "To the maximum extent permitted by law, you fully, finally, forever and irrevocably RELEASE, ACQUIT, WAIVE, DISCHARGE and COVENANT NOT TO SUE the Released Parties from and against any and all claims, demands, actions, causes of action, suits, damages, losses, liabilities, costs, expenses, penalties, fines and attorneys' fees of any kind whatsoever, whether at law or in equity, direct, indirect, incidental, special, consequential, exemplary or punitive, now existing or hereafter arising, known or unknown, arising out of or connected with the linking of your WhatsApp account, the transmission of any message, the loss or impairment of your number or account, or any act or omission of any rental business or third party.",
  ],
  [
    "No warranties",
    "The Service is provided strictly on an \"AS IS\" and \"AS AVAILABLE\" basis, without warranties of any kind, express, implied, statutory or otherwise, including without limitation any implied warranties of merchantability, fitness for a particular purpose, title, non-infringement, accuracy, availability, uptime, deliverability or non-interruption, all of which are expressly disclaimed.",
  ],
  [
    "Limitation of liability",
    // A CAP THAT SURVIVES IS WORTH MORE THAN A CAP THAT IS STRUCK.
    //
    // This read "shall not exceed zero (nil)". A total exclusion of liability is
    // commonly severed under Israeli Standard Contracts Law 1982 and EU
    // unfair-terms rules - and a severed clause can take the rest of the section
    // with it, which is the opposite of what it was written to do. A nominal,
    // severable cap with an express carve-out is the version a court is likely
    // to leave standing.
    //
    // It also now matches TERMS_SECTIONS clause 9 rather than contradicting it:
    // two documents stating different caps is itself an argument that neither
    // was agreed. Posture, not an opinion on enforceability in any forum - get
    // counsel.
    "Except where such limitation is prohibited by applicable law, the total aggregate liability of the Released Parties arising out of or relating to this agreement or the Service is limited to the greater of (a) the amounts you actually paid for the Service in the three (3) months preceding the event giving rise to the claim, or (b) US$50. In no event shall the Released Parties be liable for any indirect, incidental, special, consequential, exemplary, punitive or enhanced damages of any kind. If any part of this limitation is held unenforceable, the remainder continues in full force.",
  ],
  [
    "Indemnification",
    "You shall indemnify, defend and hold harmless the Released Parties from and against any and all claims, liabilities, damages, losses and expenses arising out of or connected with your use of the linking feature, your messages, or your breach of this agreement or of any third-party terms.",
  ],
  [
    "Your responsibility for conduct",
    "You represent and warrant that you will use the feature lawfully, will not transmit spam, bulk, harassing, deceptive, unlawful or abusive content, and will comply with all applicable laws and all third-party terms; and you acknowledge that any human-pace sending limits or bot-behaviour blocks applied by the Service are courtesy measures only, provided without warranty and without assurance that they will prevent restriction or suspension of your account.",
  ],
  [
    "Recommendation",
    "You acknowledge you have been advised, and hereby accept, that using a secondary or spare telephone number is strongly recommended, and that any decision to link your primary number is made entirely at your own election and risk.",
  ],
  [
    "Severability; entire agreement; survival",
    "If any provision is held unenforceable, the remainder continues in full force; this agreement is the entire understanding between you and the Released Parties with respect to its subject matter; and the releases, waivers, disclaimers, limitations and indemnities survive indefinitely. BY PROCEEDING YOU CONFIRM THAT YOU HAVE READ, UNDERSTOOD AND AGREED TO ALL OF THE FOREGOING AND THAT YOU ACCEPT SOLE RESPONSIBILITY FOR ANY AND ALL CONSEQUENCES.",
  ],
];

// Professional, numbered release of liability. Each clause on its own line,
// readable type, always left-to-right regardless of the app's language.
//
// WHY THE CLAUSES BELOW ARE NOT MACHINE-TRANSLATED, AND THE CHROME NOW IS.
//
// This shipped entirely in English - heading, explanation, buttons and all -
// which meant a traveller reading in Thai or Hebrew was asked to accept a
// release of liability with no indication in their language of what the
// document even was. That is the part that is straightforwardly wrong, and it
// is fixed: everything that FRAMES the document is translated.
//
// The numbered clauses themselves stay canonical English on purpose. This is
// the operative text of a waiver; a machine translation of it is not a
// convenience but a second, differently-worded agreement, and presenting that
// as the thing someone accepted is a worse problem than the one it solves.
// Presenting a translated frame around a canonical-language instrument is
// ordinary practice. The new line under the heading SAYS so, because a reader
// who cannot read the clauses is owed that fact rather than left to infer it.
//
// This is a deliberate posture, not legal advice - the owner should confirm it
// with counsel for the jurisdictions they operate in.
export function WaTermsModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Modal onClose={onClose} center>
      <div dir="ltr" className="text-left">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-[16px] font-extrabold text-strong">
            {t("WhatsApp Linking - Terms & Release of Liability")}
          </h2>
          <button onClick={onClose} className="btn btn-sm btn-ghost rounded-xl px-3" aria-label={t("Close")}>
            ✕
          </button>
        </div>
        <p className="mb-2 text-[12px] font-bold text-soft">
          {t("The full legal text, in one place. By ticking the box and linking your WhatsApp you agree to every clause below and accept responsibility for what is sent from your number.")}
        </p>
        <p className="mb-2 text-[11px] font-bold leading-snug text-faint">
          {t("The numbered clauses below are the binding agreement and are kept in English so their wording cannot shift in translation. If you would like them explained in your language before accepting, contact us first.")}
        </p>
        <ol className="max-h-[58dvh] list-none space-y-3 overflow-y-auto rounded-2xl bg-card2 p-3">
          {CLAUSES.map(([title, body], i) => (
            <li key={i} className="text-[12px] leading-relaxed text-soft">
              <span className="font-extrabold text-strong">
                {i + 1}. {title}.
              </span>{" "}
              {body}
            </li>
          ))}
        </ol>
        <button
          onClick={onClose}
          className="btn btn-primary mt-3 w-full rounded-2xl py-2.5 text-sm"
        >
          {t("I have read it")}
        </button>
      </div>
    </Modal>
  );
}
