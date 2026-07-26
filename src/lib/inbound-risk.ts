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
  /** Hosts the deterministic allow-list already cleared. The LLM half is told
   *  about these so it cannot re-flag a link we have positively judged safe. */
  clearedHosts?: string[];
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
  // A shop answering "where are you?" with a pin is the single most common link
  // in these threads. Apple/OSM/Waze pins are the same answer in a different app.
  "maps.apple.com",
  "openstreetmap.org",
  "osm.org",
  "waze.com",
  "line.me",
  "t.me",
  "youtu.be",
  "youtube.com",
];

/**
 * A LOCATION link is an answer, not a lure. A shop that sends a map pin is
 * telling us where it is - flagging that as "don't enter card details on pages a
 * chat sent you" is noise that trains the traveller to ignore the real warnings.
 */
const MAP_LINK_RX =
  /(?:maps\.app\.goo\.gl|maps\.google\.|goo\.gl\/maps|maps\.apple\.com|openstreetmap\.org|osm\.org|waze\.com|\/maps\/)/i;
export function isLocationLink(url: string): boolean {
  return MAP_LINK_RX.test(url || "");
}

/**
 * Slugs of the shop's own name ("CityGlide Scooter Rental Chiang Mai" ->
 * ["cityglide", "cityglidescooter"]). A link whose host contains the shop's
 * own name is their website, not phishing - flagging a shop's real site
 * ("cityglide.co.th may be a phishing site") destroys trust in the screen.
 * Advisory only: this never whitelists payment/document asks.
 */
function shopNameSlugs(vendorName?: string): string[] {
  const words = (vendorName ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !["rental", "rent", "shop", "motorbike", "scooter", "bike", "car"].includes(w));
  const out = new Set<string>();
  for (const w of words) out.add(w);
  if (words.length >= 2) out.add(words.slice(0, 2).join(""));
  return [...out].filter((s) => s.length >= 5);
}

export function screenInboundDeterministic(text: string, vendorName?: string): InboundRisk {
  const reasons: string[] = [];
  const cleared: string[] = [];
  let risk: InboundRisk["risk"] = "none";
  const s = text.toLowerCase();
  if (!s.trim()) return { risk: "none", reasons };
  const ownSlugs = shopNameSlugs(vendorName);

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
      const safe =
        SAFE_LINK_HOSTS.some((h) => host === h || host.endsWith("." + h)) ||
        // A map pin is an ANSWER to "where are you", whoever hosts it.
        isLocationLink(link) ||
        // The shop's own website (host carries the shop's name).
        ownSlugs.some((slug) => host.replace(/[^a-z0-9]/g, "").includes(slug));
      if (safe) cleared.push(host);
      else {
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

  return { risk, reasons, clearedHosts: cleared };
}

/**
 * Full screen: deterministic core + optional LLM refinement (only to catch
 * phrasings the regexes miss - a deterministic HIGH can never be downgraded).
 */
export async function screenInbound(
  text: string,
  opts?: { llmAllowed?: boolean; vendorName?: string }
): Promise<InboundRisk> {
  const det = screenInboundDeterministic(text, opts?.vendorName);
  if (det.risk === "high" || opts?.llmAllowed === false) return det;
  try {
    const { chat, extractJson } = await import("./ai");
    const cleared = det.clearedHosts ?? [];
    const out = await chat(
      [
        {
          role: "system",
          content:
            'You screen a rental shop\'s WhatsApp message for risks TO THE TRAVELLER (scams, document harvesting, off-platform payment pressure, phishing links). Reply ONLY JSON: {"risk":"none"|"caution"|"high","reasons":["short plain-language warning"...]}. Normal haggling, prices, deposits paid in person at pickup are NOT risks. A link to the shop\'s OWN website' +
            (opts?.vendorName ? ` (the shop is "${opts.vendorName}")` : "") +
            " is NOT a risk. A MAP LINK (Google/Apple Maps, a location pin) is the shop answering where it is - that is NEVER a risk." +
            // Telling the model what we already cleared stops it re-raising a
            // link the allow-list positively judged safe.
            (cleared.length
              ? ` These links are already verified safe, do NOT flag them: ${cleared.join(", ")}.`
              : ""),
        },
        { role: "user", content: text.slice(0, 800) },
      ],
      { maxTokens: 160, budgetMs: 6_000 }
    );
    if (out) {
      const j = extractJson<InboundRisk>(out);
      if (j && (j.risk === "high" || j.risk === "caution") && Array.isArray(j.reasons)) {
        // Drop any model reason that only re-raises a host we already cleared -
        // the model does not get to overrule a positive deterministic judgement.
        const modelReasons = j.reasons
          .map(String)
          .filter((r) => !cleared.some((h) => r.toLowerCase().includes(h.toLowerCase())));
        // NOTHING LEFT means the model's only objection was a cleared link, so
        // the deterministic verdict stands. The old code here read
        // `det.risk === "caution" || j.risk === "high" ? j.risk : j.risk` - both
        // branches were `j.risk`, so ANY model caution overrode a deterministic
        // "none" and the next line could never return it. That tautology is why
        // an allow-listed Google Maps pin was flagged as risky in a live thread.
        if (!modelReasons.length) return det;
        const reasons = [...det.reasons, ...modelReasons].slice(0, 4);
        // Escalate only: the model can raise the floor, never lower it.
        const risk: InboundRisk["risk"] = j.risk === "high" ? "high" : "caution";
        return { risk, reasons, clearedHosts: cleared };
      }
    }
  } catch {
    /* LLM screen is optional */
  }
  return det;
}
