"use client";

import { Modal } from "./Modal";

// Generic Terms of Use popup. Plain-language liability disclaimer: WheelDeal
// is a discovery/communication tool and takes no responsibility for rentals.
export function TermsModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal onClose={onClose} center>
      <h2 className="mb-2 text-lg font-extrabold text-strong">Terms of Use</h2>
      <div className="max-h-[60dvh] space-y-3 overflow-y-auto pr-1 text-[13px] leading-relaxed text-soft">
        <p>
          <b className="text-strong">1. What WheelDeal is.</b> WheelDeal is a
          discovery and communication tool that helps travellers find local
          vehicle rental businesses and exchange messages with them. WheelDeal
          is not a rental company, broker, payment processor for rentals, or a
          party to any rental agreement.
        </p>
        <p>
          <b className="text-strong">2. No responsibility for rentals.</b> All
          rental agreements, payments, deposits, pricing, availability, vehicle
          condition, insurance, licensing and legal compliance are strictly
          between you and the rental business. WheelDeal, its owner, operators
          and affiliates accept no responsibility or liability whatsoever for
          any loss, damage, injury, death, theft, fraud, dispute, fine, cost or
          expense arising from or related to any rental, vehicle use, or
          interaction with any rental business found through the app.
        </p>
        <p>
          <b className="text-strong">3. Information accuracy.</b> Prices,
          availability, ratings, reviews, distances and other details are
          provided by third parties (including the businesses themselves and
          mapping providers) or estimated by automated assistants. They may be
          incomplete, outdated or wrong. Always confirm every detail directly
          with the rental business before paying or signing anything.
        </p>
        <p>
          <b className="text-strong">4. AI assistants.</b> Parts of the app use
          automated AI agents to structure requests, estimate market rates and
          draft messages. AI output can be inaccurate. You are responsible for
          reviewing anything sent on your behalf and for every decision you
          make based on it.
        </p>
        <p>
          <b className="text-strong">5. Your conduct.</b> You agree to use the
          app lawfully and respectfully, not to send spam or abusive content,
          and to comply with the terms of the messaging platforms you use
          (including WhatsApp). Accounts may be restricted at any time for
          misuse.
        </p>
        <p>
          <b className="text-strong">6. Your data.</b> Signup details (email,
          phone), searches, messages sent through the app, bookings and
          feedback are stored to operate and improve the service, including
          improving our automated assistants. We do not sell your personal
          data.
        </p>
        <p>
          <b className="text-strong">7. Service &quot;as is&quot;.</b> The app
          is provided &quot;as is&quot; and &quot;as available&quot;, without
          warranties of any kind, express or implied. To the maximum extent
          permitted by law, the total liability of WheelDeal and its owner for
          any claim related to the app is zero.
        </p>
        <p>
          <b className="text-strong">8. Membership.</b> Paid memberships are
          billed every 3 months, may include promotional pricing for a limited
          time, and can be cancelled before renewal. Fees already paid are
          non-refundable except where required by law.
        </p>
        <p>
          <b className="text-strong">9. Changes.</b> These terms may be updated
          at any time; continued use means acceptance of the latest version.
        </p>
      </div>
      <button onClick={onClose} className="btn btn-primary mt-4 w-full rounded-2xl py-2.5 text-sm">
        I understand
      </button>
    </Modal>
  );
}
