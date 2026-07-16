// Single source of truth for WheelDeal's legal architecture. Pages AND modals
// render from here, so the Terms of Use, Privacy Policy and the mandatory
// signup checkboxes can never drift apart. Tone: aggressive protection of the
// developer (zero liability), plain-English MVP style.
//
// NOTE FOR THE OWNER: `OPERATOR_NAME` is the only place to insert a real legal
// entity (e.g. "WheelDeal Ltd."). Until then it reads as "the Operator".

export const TERMS_VERSION = "2026-07-15";
export const OPERATOR_NAME = "the Operator"; // TODO: replace with the legal entity name
export const GOVERNING_LAW = "the State of Israel";
export const JURISDICTION = "the competent courts of Tel Aviv, Israel";

// The three mandatory consents recorded at signup. Since 2026-07 they are
// collected through ONE clearly-labelled acceptance action (the label names
// the WhatsApp-connection and AI-assistant acknowledgements and links the
// full text; a plain-English summary sits right below it) - standard
// clickwrap. Each consent still stamps its own durable acceptance column on
// app_users, so consent stays provable per user, per version. The `label`
// strings below are the canonical legal wording of WHAT was accepted and are
// rendered inside the Terms (sections 2-3 cover the same ground).
export interface Consent {
  id: "terms" | "wa_risk" | "ai_responsibility";
  column: "terms_accepted_at" | "wa_risk_accepted_at" | "ai_responsibility_accepted_at";
  label: string;
}

export const CONSENTS: Consent[] = [
  {
    id: "terms",
    column: "terms_accepted_at",
    label:
      "I have read and accept the Terms of Use and Privacy Policy, including the liability cap, the class-action waiver, and that all disputes are governed by the laws of the State of Israel and resolved exclusively in the competent courts of Tel Aviv, Israel.",
  },
  {
    id: "wa_risk",
    column: "wa_risk_accepted_at",
    label:
      "I understand WheelDeal connects to WhatsApp using an unofficial, reverse-engineered method that Meta/WhatsApp do not permit for automation. Meta may block, suspend or PERMANENTLY BAN my phone number, and I assume 100% of that risk with zero liability to the Operator. Using a spare number is recommended.",
  },
  {
    id: "ai_responsibility",
    column: "ai_responsibility_accepted_at",
    label:
      "I understand the AI may make mistakes ('hallucinations'), send offensive content or false promises, and that I am SOLELY responsible for every message, contract and commitment it sends from my account. I confirm I have the legal right to process my contacts' messages, and I will not submit sensitive data (medical, payment-card, government-ID) or use the service for spam, harassment or any unlawful purpose.",
  },
];

export interface LegalSection {
  n: string;
  title: string;
  body: string;
}

// ---- Terms of Use --------------------------------------------------------------

export const TERMS_SECTIONS: LegalSection[] = [
  {
    n: "1",
    title: "What WheelDeal is",
    body:
      "WheelDeal is a discovery and communication tool that helps travellers find local vehicle rental businesses and exchange messages with them, with the help of automated AI agents. WheelDeal is NOT a rental company, broker, insurer, payment processor for rentals, or a party to any rental agreement. Every rental is strictly between you and the independent rental business.",
  },
  {
    n: "2",
    title: "Unofficial WhatsApp method & account-ban liability",
    body:
      `You acknowledge that when you link your WhatsApp number, the service operates through unofficial, reverse-engineered WhatsApp Web protocols (e.g. open-source libraries such as whatsapp-web.js/Baileys), BYPASSING the official Meta/WhatsApp Business API, which Meta's terms do not permit for automation. ${OPERATOR_NAME} has ZERO liability if Meta or WhatsApp limits, blocks, suspends or PERMANENTLY BANS your phone number or account for any reason. You assume 100% of this risk. ${OPERATOR_NAME} may enforce human-pace sending limits and block bot-like behaviour, but gives NO guarantee of any kind. A spare number is strongly recommended.`,
  },
  {
    n: "3",
    title: "AI hallucinations & automation risks",
    body:
      `The service uses large language models to read messages and reply on your behalf. AI output can be wrong, offensive, misleading, or contain false promises ('hallucinations'). The AI has NO legal agency and cannot bind ${OPERATOR_NAME}. ${OPERATOR_NAME} is not responsible for any AI error, and YOU are entirely and solely responsible for any contract, commitment, price, booking, message or damage caused by automated replies sent from your account. You must review anything sent on your behalf.`,
  },
  {
    n: "4",
    title: 'Service "as is"; third-party dependencies; no SLA; no refunds',
    body:
      `The service is provided strictly "AS IS" and "AS AVAILABLE", without warranties of any kind, express or implied. It relies on third-party LLM providers (e.g. OpenAI/Anthropic/Google and others) and on Meta's web protocols. If Meta changes its code and breaks the open-source library, or an LLM provider revokes or throttles access, the service may degrade or STOP INSTANTLY. There is no uptime commitment or service-level agreement. No refunds are provided for downtime, broken infrastructure, or any interruption.`,
  },
  {
    n: "5",
    title: "Data, third-party consent & prohibition on sensitive data",
    body:
      `You explicitly grant ${OPERATOR_NAME} permission to read, process, store and transmit your WhatsApp messages (including messages from your contacts within those threads) to third-party AI servers for processing. You warrant that you have the legal right to process the messages of your contacts and to send automated replies to them. STRICT PROHIBITION: you must NOT use the bot to process highly sensitive data, including medical/health information (HIPAA), payment-card data (PCI), or government identification numbers. To the maximum extent permitted by law, ${OPERATOR_NAME} is not liable for any data breach, leak or loss. See the Privacy Policy for details.`,
  },
  {
    n: "6",
    title: "Spam, harassment & illegal activity",
    body:
      `You take SOLE responsibility for complying with all applicable anti-spam, telecommunication, consumer-protection and privacy laws in every jurisdiction that applies to you and your contacts. The bot must NOT be used for mass-marketing spam, phishing, harassment, deception, or any illegal activity. ${OPERATOR_NAME} reserves the right to immediately suspend or terminate your account without notice and without refund for any actual or suspected abuse.`,
  },
  {
    n: "7",
    title: "Assumption of risk, waiver & release",
    body:
      `You knowingly and voluntarily assume all risks of every kind arising from your use of the service, any rental, any vehicle, any message, and any interaction with any business or third party. To the maximum extent permitted by law you fully and irrevocably RELEASE, WAIVE and DISCHARGE ${OPERATOR_NAME}, its owner, founders, operators, employees, contractors, agents, affiliates, successors and assigns (the "Released Parties") from any and all claims, demands, causes of action, damages, losses, liabilities, costs and expenses of any kind, whether known or unknown, now existing or hereafter arising.`,
  },
  {
    n: "8",
    title: "Total indemnification (hold harmless)",
    body:
      `You agree to fully INDEMNIFY, DEFEND and HOLD HARMLESS the Released Parties from and against any and all claims, lawsuits, investigations, fines, penalties, liabilities, damages, losses, costs and expenses (including reasonable legal fees) arising out of or connected with your use of the service, your messages, your rentals, your breach of these terms, or your violation of any law or any third party's rights - including, without limitation, any claim by Meta/WhatsApp, and any claim by a third party for privacy violations, spam, or automated messaging.`,
  },
  {
    n: "9",
    title: "Liability cap & class-action waiver",
    body:
      `To the maximum extent permitted by law, the total aggregate liability of the Released Parties for any and all claims arising out of or relating to the service is strictly CAPPED at the total amount you actually paid ${OPERATOR_NAME} for the service in the ONE (1) MONTH immediately preceding the event giving rise to the claim. In no event will the Released Parties be liable for any indirect, incidental, special, consequential, exemplary or punitive damages. You WAIVE any right to bring or participate in any class, collective or representative action against the Released Parties; all claims must be brought individually.`,
  },
  {
    n: "10",
    title: "No responsibility for rentals",
    body:
      "All rental agreements, payments, deposits, pricing, availability, vehicle condition, insurance, licensing and legal compliance are strictly between you and the rental business. Prices, deposits, ratings, distances and other details are provided by third parties or estimated by automated assistants and may be incomplete, outdated or wrong. Always confirm every detail directly with the rental business before paying or signing anything. The Released Parties accept no responsibility or liability whatsoever for any loss, damage, injury, death, theft, fraud, dispute, fine or expense arising from any rental or vehicle use.",
  },
  {
    n: "11",
    title: "Governing law & exclusive jurisdiction",
    body:
      `These terms, and any dispute or claim arising out of or in connection with them or the service (including non-contractual disputes), are governed exclusively by the laws of ${GOVERNING_LAW}, without regard to conflict-of-law rules. Any dispute shall be resolved EXCLUSIVELY in ${JURISDICTION}, and you irrevocably submit to their exclusive jurisdiction.`,
  },
  {
    n: "12",
    title: "Changes, severability & survival",
    body:
      "These terms may be updated at any time; material changes require you to re-accept the latest version on your next sign-in. If any provision is held unenforceable, the remainder stays in full force. The releases, waivers, disclaimers, limitations, indemnities, the liability cap, the class-action waiver, and the governing-law and jurisdiction provisions survive termination indefinitely. BY CREATING AN ACCOUNT YOU CONFIRM YOU HAVE READ, UNDERSTOOD AND AGREED TO ALL OF THE FOREGOING.",
  },
];

// ---- Privacy Policy ------------------------------------------------------------

export const PRIVACY_SECTIONS: LegalSection[] = [
  {
    n: "1",
    title: "Who we are",
    body:
      `This Privacy Policy explains how ${OPERATOR_NAME} ("we") handles data in the WheelDeal service. It forms part of, and is governed by the same terms as, the Terms of Use - including the governing law of ${GOVERNING_LAW} and exclusive jurisdiction in ${JURISDICTION}.`,
  },
  {
    n: "2",
    title: "Data we collect",
    body:
      "Account details (email, phone number), your searches, your device location when you allow it (including any location you choose to share with a rental shop for pickup), the content of WhatsApp messages in the rental-shop threads you open through the app - which may include messages written by your contacts (the shops) - any images or voice notes exchanged in those threads, bookings, feedback, and technical/usage logs.",
  },
  {
    n: "3",
    title: "How and why we process it",
    body:
      "We process this data to operate the service: to find shops near you, to let the AI agents read shop replies and negotiate on your behalf, to transcribe voice notes and read photos, to detect abuse, and to improve the service. Message content, images and voice notes are sent to third-party AI providers (large-language-model and speech/vision providers) for processing. Negotiation conversations and the agents' decision logs may additionally be reviewed internally by the operator for quality assurance and to improve the AI agents' behaviour; they are never shared with other users. Location you share for pickup is sent to the specific shop only after you explicitly consent on that shop's card.",
  },
  {
    n: "4",
    title: "Third-party AI providers & sub-processors",
    body:
      "The service relies on independent third-party providers, including LLM providers (for reading and drafting messages), speech-to-text providers (for voice notes), vision providers (for reading photos), mapping providers (for locations), messaging infrastructure, and cloud database hosting (Supabase). These providers process data under their own terms, which are outside our control.",
  },
  {
    n: "5",
    title: "Your responsibilities & third-party consent",
    body:
      "You warrant that you have the legal right to process the messages of your contacts and to have them read and replied to by automated agents and third-party AI providers. You are STRICTLY PROHIBITED from submitting highly sensitive data through the bot, including medical/health information, payment-card data, and government identification numbers.",
  },
  {
    n: "6",
    title: "Storage, retention & deletion",
    body:
      "Data is stored on cloud infrastructure (Supabase). We retain data for as long as needed to operate the service and as required by law. You may request deletion of your account data by contacting us; some records may be retained where required for legal, security or anti-abuse purposes.",
  },
  {
    n: "7",
    title: "Security & breach disclaimer",
    body:
      `We take reasonable measures to protect data, but no method of transmission or storage is fully secure, and the service is provided "AS IS". To the maximum extent permitted by law, ${OPERATOR_NAME} is not liable for any unauthorised access, breach, leak or loss of data.`,
  },
  {
    n: "8",
    title: "Not sold; changes",
    body:
      "We do not sell your personal data. This Privacy Policy may be updated; material changes require re-acceptance on your next sign-in.",
  },
];
