"use client";

import { Modal } from "./Modal";

// Deliberately dense, maximally protective WhatsApp-linking terms. Small type,
// long single block - the user must scroll through it before accepting.
export function WaTermsModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal onClose={onClose} center>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[15px] font-extrabold text-strong">
          WhatsApp Linking - Terms, Waiver & Release of Liability
        </h2>
        <button onClick={onClose} className="btn btn-sm btn-ghost rounded-xl px-3" aria-label="Close">
          ✕
        </button>
      </div>
      <div className="max-h-[60dvh] overflow-y-auto rounded-2xl bg-card2 p-3 text-[9px] leading-[1.5] text-soft">
        <p>
          PLEASE READ THIS ENTIRE AGREEMENT CAREFULLY BEFORE LINKING ANY WHATSAPP
          ACCOUNT. BY TICKING THE ACCEPTANCE BOX AND/OR INITIATING THE LINKING
          PROCESS YOU IRREVOCABLY ACKNOWLEDGE, REPRESENT, WARRANT, COVENANT AND
          AGREE TO EACH AND EVERY PROVISION SET FORTH BELOW, WITHOUT RESERVATION,
          CONDITION OR EXCEPTION OF ANY KIND WHATSOEVER. 1. NATURE OF THE SERVICE.
          WheelDeal (the &quot;Service&quot;, and together with its owner, operator, founders,
          shareholders, directors, officers, employees, contractors, agents,
          affiliates, successors and assigns, the &quot;Released Parties&quot;) provides a
          purely optional, convenience-oriented software interface that, solely at
          and upon your own express instruction, drafts and transmits text messages
          to third-party rental businesses that you yourself select, using a
          connection to your own personal WhatsApp account that you yourself
          voluntarily establish. 2. UNOFFICIAL METHOD; NO AFFILIATION. You expressly
          understand and agree that the linking mechanism relies upon the
          unofficial &quot;WhatsApp Web&quot; multi-device protocol; that WhatsApp LLC, Meta
          Platforms, Inc. and their affiliates (collectively &quot;WhatsApp&quot;) do not
          authorize, sanction, endorse, support or permit the use of automated or
          programmatic tooling in connection with WhatsApp; that the Released
          Parties are not affiliated with, sponsored by, endorsed by, partnered
          with or connected to WhatsApp in any manner; and that your use may
          constitute a violation of WhatsApp&apos;s Terms of Service for which YOU, and
          you alone, bear sole and exclusive responsibility. 3. ASSUMPTION OF RISK.
          You knowingly, voluntarily and freely assume all risks of every kind and
          nature, whether known or unknown, foreseeable or unforeseeable, arising
          out of or in any way relating to the linking, connection, transmission or
          use contemplated herein, including without limitation the risk that your
          WhatsApp account and/or telephone number may be rate-limited, throttled,
          temporarily restricted, permanently suspended, banned, blocked, disabled,
          deleted, or otherwise rendered wholly or partially inoperative, with or
          without notice, by WhatsApp or by any other party, for any reason or for
          no reason at all. 4. TOTAL RELEASE AND WAIVER. To the maximum extent
          permitted by applicable law, you hereby fully, finally, forever and
          irrevocably RELEASE, ACQUIT, WAIVE, RELINQUISH, DISCHARGE and COVENANT NOT
          TO SUE the Released Parties from, against and with respect to any and all
          claims, demands, actions, causes of action, suits, damages, losses,
          liabilities, costs, expenses, penalties, fines and attorneys&apos; fees of any
          kind or nature whatsoever, whether at law or in equity, whether direct,
          indirect, incidental, special, consequential, exemplary or punitive,
          whether now existing or hereafter arising, and whether known or unknown,
          that you may have or claim to have against any of the Released Parties,
          arising out of, resulting from, or in any way connected with the linking
          of your WhatsApp account, the transmission of any message, the loss or
          impairment of your number or account, or any act or omission of any
          rental business or third party. 5. NO WARRANTIES. The Service is provided
          strictly on an &quot;AS IS&quot; and &quot;AS AVAILABLE&quot; basis, without warranties of any
          kind, express, implied, statutory or otherwise, including without
          limitation any implied warranties of merchantability, fitness for a
          particular purpose, title, non-infringement, accuracy, availability,
          uptime, deliverability or non-interruption, all of which are expressly
          disclaimed. 6. LIMITATION OF LIABILITY. In no event shall the aggregate
          liability of the Released Parties arising out of or relating to this
          agreement or the Service exceed zero (nil), and in no event shall the
          Released Parties be liable for any indirect, incidental, special,
          consequential, exemplary, punitive or enhanced damages of any kind. 7.
          INDEMNIFICATION. You shall indemnify, defend and hold harmless the
          Released Parties from and against any and all claims, liabilities,
          damages, losses and expenses arising out of or in any way connected with
          your use of the linking feature, your messages, or your breach of this
          agreement or of any third-party terms. 8. YOUR RESPONSIBILITY FOR
          CONDUCT. You represent and warrant that you will use the feature lawfully,
          will not transmit spam, bulk, harassing, deceptive, unlawful or abusive
          content, and will comply with all applicable laws and all third-party
          terms; and you acknowledge that any human-pace sending limits or
          bot-behaviour blocks applied by the Service are courtesy measures only,
          provided without warranty and without any assurance that they will
          prevent restriction or suspension of your account. 9. RECOMMENDATION. You
          acknowledge you have been advised, and hereby accept, that using a
          secondary or spare telephone number is strongly recommended and that any
          decision to link your primary number is made entirely at your own
          election and risk. 10. SEVERABILITY; ENTIRE AGREEMENT; SURVIVAL. If any
          provision hereof is held unenforceable, the remainder shall continue in
          full force and effect; this agreement constitutes the entire
          understanding between you and the Released Parties with respect to its
          subject matter; and the releases, waivers, disclaimers, limitations and
          indemnities herein shall survive indefinitely. BY PROCEEDING YOU CONFIRM
          THAT YOU HAVE READ, UNDERSTOOD AND AGREED TO ALL OF THE FOREGOING AND
          THAT YOU ARE ACCEPTING SOLE RESPONSIBILITY FOR ANY AND ALL CONSEQUENCES.
        </p>
      </div>
      <button
        onClick={onClose}
        className="btn btn-primary mt-3 w-full rounded-2xl py-2.5 text-sm"
      >
        I have read it
      </button>
    </Modal>
  );
}
