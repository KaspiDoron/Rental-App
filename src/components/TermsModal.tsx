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
          <b className="text-strong">4b. Connecting your WhatsApp.</b> If you
          link your own WhatsApp number, messages are sent through your account
          using the WhatsApp Web protocol, which WhatsApp&apos;s own terms do
          not officially permit for automation. Your number could be limited or
          banned by WhatsApp and you accept that risk entirely. WheelDeal
          enforces human-pace sending limits and blocks bot-like behaviour
          (bursts, mass messaging), and may suspend accounts that try to bypass
          them, but gives no guarantee of any kind. Using a spare number is
          recommended.
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
          <b className="text-strong">9. Assumption of risk, waiver &amp; release.</b>{" "}
          You knowingly and voluntarily assume all risks of every kind arising
          from your use of the app, any rental, any vehicle, and any interaction
          with any business or third party found through it. To the maximum
          extent permitted by law you fully and irrevocably RELEASE, WAIVE and
          DISCHARGE WheelDeal, its owner, operators, founders, employees,
          contractors, agents, affiliates, successors and assigns (the
          &quot;Released Parties&quot;) from any and all claims, demands, causes
          of action, damages, losses, liabilities, costs and expenses of any
          kind, whether known or unknown, now existing or hereafter arising.
        </p>
        <p>
          <b className="text-strong">10. Indemnification.</b> You agree to
          indemnify, defend and hold harmless the Released Parties from and
          against any claim, liability, damage, loss or expense (including
          reasonable legal fees) arising out of or connected with your use of
          the app, your messages, your rentals, your breach of these terms, or
          your violation of any law or any third party&apos;s rights.
        </p>
        <p>
          <b className="text-strong">11. Limitation of liability.</b> To the
          maximum extent permitted by law, in no event will the Released
          Parties&apos; total aggregate liability arising out of or relating to
          the app exceed the greater of the amount you paid us in the prior
          three months or ten US dollars, and in no event will they be liable
          for any indirect, incidental, special, consequential, exemplary or
          punitive damages.
        </p>
        <p>
          <b className="text-strong">12. No professional advice; third
          parties.</b> The app does not provide legal, insurance, safety,
          financial or travel advice. Mapping, messaging, AI and payment
          providers are independent third parties whose services and terms are
          outside our control and for which we are not responsible.
        </p>
        <p>
          <b className="text-strong">13. Binding arbitration; class-action
          waiver.</b> Any dispute arising out of or relating to the app or these
          terms shall be resolved exclusively by final and binding individual
          arbitration, and NOT in a court or before a jury. You and WheelDeal
          each waive any right to a jury trial and any right to bring or
          participate in a class, collective or representative action. Nothing
          prevents either party from seeking injunctive relief for intellectual
          property misuse.
        </p>
        <p>
          <b className="text-strong">14. Governing law; severability; entire
          agreement; survival.</b> These terms are governed by the laws of the
          owner&apos;s place of residence, without regard to conflict-of-law
          rules. If any provision is held unenforceable, the remainder stays in
          full force. These terms (with the WhatsApp Linking Terms where
          applicable) are the entire agreement between you and WheelDeal, and the
          releases, waivers, disclaimers, limitations, indemnities and
          arbitration provisions survive termination indefinitely.
        </p>
        <p>
          <b className="text-strong">15. Changes.</b> These terms may be updated
          at any time; continued use means acceptance of the latest version. BY
          CREATING AN ACCOUNT YOU CONFIRM YOU HAVE READ, UNDERSTOOD AND AGREED TO
          ALL OF THE FOREGOING.
        </p>
      </div>
      <button onClick={onClose} className="btn btn-primary mt-4 w-full rounded-2xl py-2.5 text-sm">
        I understand
      </button>
    </Modal>
  );
}
