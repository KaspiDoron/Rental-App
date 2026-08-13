// Inbound safety screen: shops' messages were never screened - a shop asking
// for a passport photo up front, a bank transfer before viewing, or pushing a
// shady link sailed straight through. This module flags those for the USER
// (alert card + push); it NEVER changes what the negotiation engine replies.
//
// Deterministic rules first (always on, keyless); an optional LLM look only
// upgrades/downgrades the wording, never suppresses a deterministic HIGH.
// (No "server-only" pin: the deterministic core is pure and unit-tested; the
// LLM half loads ./ai dynamically inside the server-called function.)

import { claimsIn } from "./thread/claims";

export interface InboundRisk {
  risk: "none" | "caution" | "high";
  reasons: string[];
  /** Hosts the deterministic allow-list already cleared. The LLM half is told
   *  about these so it cannot re-flag a link we have positively judged safe. */
  clearedHosts?: string[];
  /** The shop asked us to stop messaging them. Deterministic, multilingual,
   *  and PERMANENT once the caller stamps it - so precision beats recall here:
   *  a missed opt-out costs one more annoyed message; a false one mutes a live
   *  negotiation forever. Never affects `risk` - a shop saying "leave me alone"
   *  is not a scam, it is a boundary. */
  optOut?: boolean;
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

/**
 * Is this message the shop stating its DEPOSIT or HANDOVER terms, rather than
 * asking the traveller for anything? Read as typed claims (lib/thread/claims),
 * so "we don't take a deposit, just your passport at pickup" is what it plainly
 * is: two claims about terms, one of them a denial - and not a document ask.
 *
 * A message that also demands a scan is NOT excused: the caller still requires
 * its own scan-and-document evidence, and a request verb next to a document
 * word overrides this. This only stops TERMS from reading as a demand.
 */
function describesTerms(text: string): boolean {
  const claims = claimsIn(text, "shop", 0);
  const termClaim = claims.some((c) => c.subject === "deposit" || c.subject === "handover");
  if (!termClaim) return false;
  // An explicit ask ("send me your passport") is a demand no matter what else
  // the message says.
  return !/\b(send|share|forward|upload|give me)\b[^.!?]{0,30}\b(passports?|id cards?|licen[cs]es?)\b/i.test(
    text
  );
}

// A DOCUMENT WORD IS A NOUN. A DEMAND NEEDS A VERB. (Module scope so the LLM
// half below holds the model to the SAME grammar - in the field the model
// called a shop's standard passport-deposit terms "SUSPICIOUS" and the code
// accepted that verdict with only a link filter, which is how the Bigman chat
// got a red banner, a frozen composer and a lost ฿1,100 discount.)
const DOC = /\b(passports?|id cards?|identity|licen[cs]es?)\b/;
const TRANSMIT =
  /\b(send|sends|sending|share|shares|sharing|forward|upload|uploads|submit|submits|attach|mail|whats ?app|dm|e-?mail)\b/;
const DEMAND = new RegExp(
  `${TRANSMIT.source}[^.!?]{0,40}${DOC.source}|${DOC.source}[^.!?]{0,30}${TRANSMIT.source}`
);
/** Does the model's stated reason hinge on documents/IDs? */
const DOC_REASON = /\b(passport|id card|identity|licen[cs]e|document)/i;

// "STOP MESSAGING ME" IS A COMMAND, NOT A NEGOTIATION SIGNAL.
//
// WhatsApp's single strongest ban input is a recipient who reports or blocks a
// number - and the message before a block is almost always some spelling of
// "stop writing to me". Honouring it is both the decent thing and the
// anti-ban keystone: guardOutbound turns the stamp this detection produces
// into a PERMANENT refusal (manual sends and future hunts included).
//
// DETERMINISTIC AND NARROW BY DESIGN. Every pattern is an imperative aimed at
// the sender ("don't message me", "תפסיק לשלוח", "อย่าส่งข้อความ") - never a
// bare keyword. "stop" alone only counts as the WHOLE message (the SMS
// convention), because "you can stop by the shop" and "we stop at 6pm" are
// ordinary rental talk. The languages are the funnel's live markets: EN, HE,
// TH, ES, PT, FR, ID/MS, VI, DE, RU, TR, AR, ZH, HI.
const OPT_OUT_EXACT = /^\s*(?:stop|stop it|please stop|stop please|unsubscribe|no more messages?)\s*[.!]*\s*$/i;
const OPT_OUT_PHRASES: RegExp[] = [
  // English
  /\b(?:do not|don'?t|dont|never)\s+(?:message|text|write(?:\s+to)?|contact|whatsapp|call)\s+(?:me|us)\b/i,
  /\bstop\s+(?:messaging|texting|writing|contacting|sending|spamming)\b/i,
  /\b(?:remove|delete)\s+(?:me|us|my number|this number)\b/i,
  /\bleave\s+(?:me|us)\s+alone\b/i,
  /\bunsubscribe\b/i,
  // Hebrew
  /אל תכתו?בו? ל(?:י|נו)|אל תשלחו? ל?(?:י|נו)|תפסיקו? לשלוח|די לשלוח|תמחקו? אות(?:י|נו)|הסירו? אות(?:י|נו)|עז[וב]ב? אות(?:י|נו) בשקט/,
  // Thai
  /หยุดส่ง|อย่าส่งข้อความ|อย่าติดต่อ|เลิกส่ง|อย่าทักมา/,
  // Spanish
  /no me escrib(?:as|a|an)|deja de escribir|no me env[ií]e[sn]? m[aá]s|no me contacte[sn]?|no me molestes/i,
  // Portuguese
  /n[aã]o me escreva|pare de enviar|n[aã]o me mande mais|me tire da lista|n[aã]o me incomode/i,
  // French
  /ne m'?[ée]cri(?:s|vez) plus|arr[eê]te[zr]? de m'?[ée]crire|ne me contacte[zr]? plus/i,
  // Indonesian / Malay
  /jangan (?:kirim pesan|chat|hubungi) (?:saya|aku|lagi)|berhenti mengirim|jangan ganggu saya/i,
  // Vietnamese
  /đừng nhắn tin|đừng liên hệ|ngừng gửi|đừng làm phiền/i,
  // German
  /schreib(?:en sie)? mir nicht mehr|h[oö]r(?:en sie)? auf zu schreiben|kontaktier(?:e|en sie) mich nicht/i,
  // Russian
  /не пиши(?:те)? (?:мне|нам)|перестань(?:те)? писать|хватит писать/i,
  // Turkish
  /mesaj atma(?:y[ıi]n)?|bana yazma(?:y[ıi]n)?|beni rahat b[ıi]rak/i,
  // Arabic
  /لا ترسل|توقف عن (?:المراسلة|الإرسال)|لا تتواصل مع/,
  // Chinese
  /不要再发|别再发|停止发送|不要联系我|别烦我/,
  // Hindi (Devanagari + common Latin transliteration)
  /(?:message|मैसेज|संदेश)\s*(?:मत|mat)\s*(?:करो|भेजो|karo|bhejo)|मत भेजो|परेशान मत करो/i,
];

/** Is this inbound message the shop telling us to stop messaging them? */
export function detectOptOutIntent(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  if (OPT_OUT_EXACT.test(t)) return true;
  return OPT_OUT_PHRASES.some((rx) => rx.test(t));
}

export function screenInboundDeterministic(text: string, vendorName?: string): InboundRisk {
  const reasons: string[] = [];
  const cleared: string[] = [];
  let risk: InboundRisk["risk"] = "none";
  const s = text.toLowerCase();
  if (!s.trim()) return { risk: "none", reasons };
  const ownSlugs = shopNameSlugs(vendorName);
  const optOut = detectOptOutIntent(text);

  const bump = (level: "caution" | "high", why: string) => {
    reasons.push(why);
    if (level === "high" || risk === "high") risk = "high";
    else risk = "caution";
  };

  // 1. Documents up front: passport/ID photos before any rental exists.
  //
  // WORD BOUNDARIES ARE LOAD-BEARING HERE. Unanchored, `pic` matched inside
  // "pickup", so "no deposit, just your passport at pickup" - the best terms in
  // the whole thread - was flagged HIGH RISK for document harvesting. Being
  // handed the vehicle IS the pickup; it is the opposite of a demand for a
  // scan over chat.
  // A DOCUMENT WORD IS A NOUN. A DEMAND NEEDS A VERB.
  //
  // The old rule fired on CO-OCCURRENCE: any of send/photo/picture/copy/scan
  // near any of passport/id/licence. But "copy" and "photo" are nouns as often
  // as they are verbs, and every rental shop in Thailand writes its deposit
  // terms exactly that way - "Deposits (2 options): 1) Original passport
  // 2) Copy passport + 3000 THB". That is a shop telling you what it holds at
  // the counter, and it was being shown to travellers as a scam warning.
  //
  // What actually distinguishes a demand is a TRANSMISSION VERB aimed at the
  // traveller: send / share / upload / forward / submit / mail it to me. You
  // cannot describe a deposit policy with those words, and you cannot ask
  // someone to transmit a document without one. So the act is the signal, and
  // the noun is only the object of it. (DOC/TRANSMIT/DEMAND live at module
  // scope now - the LLM half is held to the same grammar.)
  if (
    DEMAND.test(s) &&
    // ...and it must not be the shop DESCRIBING its terms. A typed claim about
    // the deposit or the handover is terms, not a demand for documents - the
    // structural half of the same fix, so a phrasing the boundaries miss still
    // cannot turn friendly terms into a red banner.
    !describesTerms(text)
  ) {
    bump(
      "high",
      "asked you to send a photo or copy of your passport or ID over chat. Never send documents before you have seen the vehicle and the shop."
    );
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

  return { risk, reasons, clearedHosts: cleared, ...(optOut ? { optOut: true } : {}) };
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
            'You screen a rental shop\'s WhatsApp message for risks TO THE TRAVELLER (scams, document harvesting, off-platform payment pressure, phishing links). Reply ONLY JSON: {"risk":"none"|"caution"|"high","reasons":["short plain-language warning"...]}. Normal haggling, prices, deposits paid in person at pickup are NOT risks. Holding a passport (or a passport photocopy + cash) as the rental deposit AT THE COUNTER is STANDARD practice across Southeast Asia - a shop STATING those terms is never a risk; only an instruction to TRANSMIT a document over chat ("send me a photo of your passport") is. A link to the shop\'s OWN website' +
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
        //
        // AND HOLD IT TO THE DOCUMENT GRAMMAR. The deterministic half learned
        // (F1) that a document DEMAND needs a transmit verb and that stated
        // deposit/handover terms are never a demand - but the model's verdict
        // used to bypass both, so the exact message the regexes were taught to
        // pass ("Deposit: original passport, or copy + 3000") came back as a
        // red banner via this path. A model reason built on documents is
        // accepted ONLY when the message itself carries a transmit-verb demand
        // and is not the shop describing its terms.
        const textDemandsDoc = DEMAND.test(text.toLowerCase()) && !describesTerms(text);
        const modelReasons = j.reasons
          .map(String)
          .filter((r) => !cleared.some((h) => r.toLowerCase().includes(h.toLowerCase())))
          .filter((r) => !DOC_REASON.test(r) || textDemandsDoc);
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
        // The opt-out signal is deterministic-only and rides through untouched:
        // a model verdict about scam risk must never eat "stop messaging me".
        return { risk, reasons, clearedHosts: cleared, ...(det.optOut ? { optOut: true } : {}) };
      }
    }
  } catch {
    /* LLM screen is optional */
  }
  return det;
}
