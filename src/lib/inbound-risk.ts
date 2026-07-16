// Inbound safety screen: shops' messages were never screened - a shop asking
// for a passport photo up front, a bank transfer before viewing, or pushing a
// shady link sailed straight through. This module flags those for the USER
// (alert card + push); it NEVER changes what the negotiation engine replies.
//
// Deterministic rules first (always on, keyless); an optional LLM look only
// upgrades/downgrades the wording, never suppresses a deterministic HIGH.
// (No "server-only" pin: the deterministic core is pure and unit-tested; the
// LLM half loads ./ai dynamically inside the server-called function.)

export interface InboundRisk {
  risk: "none" | "caution" | "high";
  reasons: string[];
}

const SAFE_LINK_HOSTS = [
  "wa.me",
  "whatsapp.com",
  "maps.google.com",
  "goo.gl",
  "maps.app.goo.gl",
  "g.co",
  "google.com",
  "facebook.com",
  "instagram.com",
];

export function screenInboundDeterministic(text: string): InboundRisk {
  const reasons: string[] = [];
  let risk: InboundRisk["risk"] = "none";
  const s = text.toLowerCase();
  if (!s.trim()) return { risk: "none", reasons };

  const bump = (level: "caution" | "high", why: string) => {
    reasons.push(why);
    if (level === "high" || risk === "high") risk = "high";
    else risk = "caution";
  };

  // 1. Documents up front: passport/ID photos before any rental exists.
  if (/(send|photo|picture|pic|copy|scan)[^.!?]{0,40}(passport|id card|identity|license|licence)/.test(s) ||
      /(passport|id card)[^.!?]{0,30}(photo|picture|pic|copy|scan|send)/.test(s)) {
    bump("high", "asked for a photo/copy of your passport or ID over chat - never send documents before you see the vehicle and the shop");
  }

  // 2. Money off-platform before viewing: transfers, crypto, gift cards.
  if (/(bank transfer|wire|western union|moneygram|revolut|paypal|crypto|usdt|bitcoin|gift ?card)/.test(s) &&
      /(deposit|pay|send|transfer|first|advance|before|book|secure|reserve)/.test(s)) {
    bump("high", "asked for money by transfer BEFORE you have seen the vehicle - pay only in person, on pickup");
  }
  if (/(pay|deposit|transfer)[^.!?]{0,40}(to hold|to reserve|to book|in advance|upfront|up front)/.test(s)) {
    bump("caution", "wants an advance payment to hold the vehicle - only do this with a shop you can verify");
  }

  // 3. Links to unknown places.
  const links = text.match(/https?:\/\/[^\s]+/gi) ?? [];
  for (const link of links.slice(0, 3)) {
    try {
      const host = new URL(link).hostname.replace(/^www\./, "");
      const safe = SAFE_LINK_HOSTS.some((h) => host === h || host.endsWith("." + h));
      if (!safe) {
        bump("caution", `sent a link to ${host} - don't enter card or account details on pages a chat sent you`);
      }
    } catch {
      /* unparseable link - ignore */
    }
  }

  // 4. Moving the conversation to another number/app (thread-hop scam smell).
  if (/(message|text|chat|call)[^.!?]{0,30}(this|other|another|new) (number|whatsapp)/.test(s) ||
      /\bcontact (me|us) (on|at) \+?\d{7,}/.test(s)) {
    bump("caution", "asked to switch to a different number - keep the deal in this thread so everything stays on record");
  }

  // 5. Card details over chat.
  if (/(card number|cvv|credit card)[^.!?]{0,30}(send|share|give|type)/.test(s) ||
      /(send|share|give)[^.!?]{0,30}(card number|cvv|credit card)/.test(s)) {
    bump("high", "asked for card details in chat - never share card numbers over WhatsApp");
  }

  return { risk, reasons };
}

/**
 * Full screen: deterministic core + optional LLM refinement (only to catch
 * phrasings the regexes miss - a deterministic HIGH can never be downgraded).
 */
export async function screenInbound(
  text: string,
  opts?: { llmAllowed?: boolean }
): Promise<InboundRisk> {
  const det = screenInboundDeterministic(text);
  if (det.risk === "high" || opts?.llmAllowed === false) return det;
  try {
    const { chat, extractJson } = await import("./ai");
    const out = await chat(
      [
        {
          role: "system",
          content:
            'You screen a rental shop\'s WhatsApp message for risks TO THE TRAVELLER (scams, document harvesting, off-platform payment pressure, phishing links). Reply ONLY JSON: {"risk":"none"|"caution"|"high","reasons":["short plain-language warning"...]}. Normal haggling, prices, deposits paid in person at pickup are NOT risks.',
        },
        { role: "user", content: text.slice(0, 800) },
      ],
      { maxTokens: 160, budgetMs: 6_000 }
    );
    if (out) {
      const j = extractJson<InboundRisk>(out);
      if (j && (j.risk === "high" || j.risk === "caution") && Array.isArray(j.reasons)) {
        // Merge: keep deterministic findings, add the model's (capped).
        const reasons = [...det.reasons, ...j.reasons.map(String)].slice(0, 4);
        const risk = det.risk === "caution" || j.risk === "high" ? j.risk : j.risk;
        return { risk: risk === "high" ? "high" : "caution", reasons };
      }
    }
  } catch {
    /* LLM screen is optional */
  }
  return det;
}
