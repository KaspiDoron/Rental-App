// THE ONE DEFINITION OF "THIS MESSAGE OPENS WITH A GREETING" (W4.7).
//
// Owner report 5, item 3, with three field screenshots of ONE thread:
//
//     us  12:04  "Hi! Do you have a spare scooter for 3 days?"
//     us  12:19  "Hi there! Just checking in - any chance on that better rate?"
//     us  12:41  "Hey there! ok so 250 works for me?"
//
// "The ai agents keep writing 'Hi' every new message in a single thread which
// makes the shop think it's an automatic bot; writing hi or hello more than one
// time is not humanize behavior."
//
// Three different greetings in three consecutive messages is not a person being
// warm - it is a machine rolling dice, and it was literally that: wa-guard's
// `humanizeVariant` matched a leading greeting and substituted a DIFFERENT
// random one on every send. It never removed one and it had no idea where in a
// thread it was.
//
// The regex the old repair used (orchestrator.GREETING_RX) had two holes this
// module closes:
//
//   1. "Hi again!"  ->  "Again! Just checking in..."   The alternation matched
//      the bare "Hi" and left the adverb behind as a sentence of its own. Both
//      hard-coded nudge templates in the app opened exactly that way, so every
//      momentum/recheck message that went through the repair was mangled.
//   2. "Hitting the road tomorrow"  ->  "Tting the road tomorrow".  The trailing
//      `[!,.]*\s*` could match EMPTY, so a greeting word had no right boundary
//      and any message starting with those letters was chopped.
//
// W4.7b - THE 45-AGENT AUDIT REPRODUCED THE OWNER'S SCREENSHOT ANYWAY, through
// three holes in THIS module (the fourth, the mid-thread position flip, is in
// wa-guard.hasMessagedShopBefore):
//
//   3. ONE PASS PER PATTERN. Each regex was visited exactly once with a
//      non-global replace, so a doubled or mixed opener survived the repair
//      and `hasLeadingGreeting` still answered true afterwards:
//        "Hi! Hi there, any chance on 250?"     -> "Hi there, any chance..."
//        "สวัสดีครับ Hi, ลด 250 ได้ไหม"          -> "Hi, ลด 250 ได้ไหม"
//      The Thai-then-English one is not a curiosity: it is exactly what
//      localizeMessage emits when it half-obeys "do NOT leave ANY English
//      words". The strip now runs to a FIXED POINT (bounded).
//   4. A LEADING EMOJI DEFEATED THE WHOLE RAIL. Both patterns anchored at
//      `^\s*`, and this app PRODUCES leading emoji itself: SPTE's prompt asks
//      for a warm register, and wa/persona.personaHumanize places its one warm
//      emoji LEADING about a fifth of the time it adds one - which is then
//      frozen into the parked body a drain re-guards. So "👋 Hi there! Any
//      chance on 250?" was ordinary output that passed through
//      humanizeForOutbound completely unchanged AND reported
//      hasLeadingGreeting() === false, so no detector upstream fired either.
//      A leading emoji / quote / zero-width run is now NOISE, skipped before
//      the greeting is looked for (and a bare wave IS a greeting).
//   5. FORMS THE ALTERNATIONS HAD NEVER HEARD OF: "Hiya!", "Morning!",
//      "Howdy,", "Greetings!" in English, and whole SCRIPTS in local - Khmer,
//      Lao and Burmese among them, which region.ts routes to the localizer.
//      Three real scooter-rental markets had a prompt as their first line of
//      defence and NOTHING as their second. LOCAL_GREETINGS is now keyed by
//      `LocalizedCountry` (region.ts's country map), so a new market cannot
//      compile until its greetings are covered.
//
// Everything here is deterministic and pure. It runs at the ONE choke point
// every outbound crosses (wa-guard.humanizeForOutbound), so no caller can
// forget it, and it is intentionally boring: the localizer is told the thread
// position too (agents.localizeMessage `greet`), because a regex over English
// can never remove a Thai greeting a translator was ASKED to add.

import type { LocalizedCountry } from "./region";

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/** Escape a literal greeting for use inside an alternation. */
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What may sit BEFORE a greeting without making it any less of a greeting:
 * whitespace, a leading emoji (with its modifiers), a quote/bracket, or an
 * invisible (zero-width joiner, BOM, direction marks). See hole 4 above - this
 * prefix is why "👋 Hi there!" is now seen at all.
 */
const NOISE =
  "(?:[\\s\"'“”‘’«»\\(\\[\\u200b-\\u200f\\u2060\\ufeff\\ufe0f]" +
  "|\\p{Extended_Pictographic}[\\u{1F3FB}-\\u{1F3FF}]?\\ufe0f?)*";

/**
 * The right boundary. `\s+` or punctuation or end-of-string - never EMPTY, or a
 * greeting word has no right edge and "Hitting" becomes "Tting" (hole 2).
 */
const BOUNDARY = "(?:[!,.…:;~\\-–—]+\\s*|\\s+|$)";
/** The stricter boundary for words that are also ordinary nouns: punctuation or
 * end only, so "Morning!" is a greeting and "Morning traffic is bad" is not. */
const PUNCT_BOUNDARY = "(?:[!,.…:;~\\-–—]+\\s*|$)";

/**
 * Unambiguous English openers. Longest form first - a regex alternation takes
 * the FIRST match, so "hey there" must be tried before "hey" or the swap eats
 * half a phrase ("Hi there!" -> "Hey there! there!", the original B2 defect).
 */
const EN_STRONG = [
  "good\\s+(?:morning|afternoon|evening|day)",
  "hey\\s+there", "hi\\s+there", "hello\\s+there", "top\\s+of\\s+the\\s+morning",
  "greetings", "howdy", "hiya", "heya", "hallo", "hullo", "hello", "hey", "hi",
  "g'?day", "yo", "aloha", "salutations",
].join("|");

/**
 * Words that ARE greetings when they stand as an opener but are ordinary nouns
 * otherwise. They only count in front of punctuation or end-of-string.
 */
const EN_WEAK = ["mornin[g']?", "afternoon", "evening", "sup", "what's\\s+up", "whats\\s+up"].join("|");

/** A bare wave is the same repeated-opener tell as a bare "Hi" - the persona
 * pass adds emoji, so a thread can end up waving on every single message. */
const WAVE = "[\\u{1F44B}\\u{1F64B}\\u{1F919}][\\u{1F3FB}-\\u{1F3FF}]?\\ufe0f?";

// ---------------------------------------------------------------------------
// LOCAL greetings, keyed by the country map that decides who gets localized
// ---------------------------------------------------------------------------
//
// Deliberately NOT "every language on earth": every entry here is a market
// `region.countryForShop` can return, which is exactly the set localizeMessage
// composes for. The type is `Record<LocalizedCountry, ...>`, so the coverage
// follows the country map BY CONSTRUCTION - adding a calling code to region.ts
// fails typecheck until the greetings land here (hole 5).
//
// English-speaking entries are deliberately empty: locale.isEnglishSpeaking
// short-circuits the localizer there, and the English rail above already covers
// what those shops are written. Native script AND the romanizations our own
// localizer produces are both listed - a Thai shop is as likely to receive
// "Sawasdee krub" as "สวัสดีครับ".

const ARABIC = [
  "مرحبا", "مرحباً", "السلام عليكم", "أهلا", "أهلاً", "صباح الخير", "مساء الخير",
  "marhaba", "marhaban", "salam", "salaam", "assalamu alaikum", "as-salamu alaykum", "ahlan",
  "sabah el kheir",
];
const FRENCH = ["bonjour", "bonsoir", "salut", "coucou", "bonne journée"];
const SPANISH = [
  "hola", "buenos días", "buenos dias", "buenas tardes", "buenas noches", "buenas",
  "qué tal", "que tal", "saludos",
];
const PORTUGUESE = ["olá", "ola", "oi", "bom dia", "boa tarde", "boa noite", "e aí", "e ai"];
const GERMAN = ["hallo", "guten tag", "guten morgen", "guten abend", "servus", "grüezi", "gruezi", "moin", "hoi"];
const SWAHILI = ["jambo", "hujambo", "habari", "habari yako", "mambo", "salama", "shikamoo", "hodi"];
const RUSSIAN = ["привет", "здравствуйте", "здравствуй", "добрый день", "доброе утро", "добрый вечер", "privet", "zdravstvuyte"];
const MALAY = [
  "hai", "helo", "halo", "apa khabar", "apa kabar",
  "selamat pagi", "selamat petang", "selamat tengah hari", "selamat malam", "selamat datang",
];
const CHINESE = ["你好", "您好", "大家好", "哈囉", "哈啰", "早安", "午安", "晚安", "你好吗", "你好嗎", "ni hao", "nihao"];

export const LOCAL_GREETINGS: Record<LocalizedCountry, readonly string[]> = {
  // --- English-speaking: the English rail above IS the coverage ---------------
  "United States": [],
  "United Kingdom": [],
  Ireland: [],
  Australia: [],
  "New Zealand": [],
  Singapore: ["ni hao", "你好", "selamat pagi", "vanakkam"], // English-first, but a shop may answer in any of the four
  Malta: ["bonġu", "bongu", "ħello", "hello", "merħba", "merhba"],

  // --- Africa + MENA ----------------------------------------------------------
  Egypt: ARABIC,
  Morocco: [...ARABIC, ...FRENCH, "azul"],
  Algeria: [...ARABIC, ...FRENCH],
  Tunisia: [...ARABIC, ...FRENCH, "aslema"],
  Senegal: [...FRENCH, "nanga def", "salaam aleekum", "asalaa malekum"],
  Ghana: ["ete sen", "ɛte sɛn", "maakye", "maaha", "maadwo", "akwaaba"],
  Nigeria: ["sannu", "bawo ni", "kedu", "ndewo", "how far", "ẹ nlẹ"],
  Ethiopia: ["ሰላም", "ጤና ይስጥልኝ", "selam", "tena yistilign", "endemen neh", "endemen nesh"],
  Kenya: SWAHILI,
  Tanzania: SWAHILI,
  Uganda: [...SWAHILI, "oli otya", "wasuze otya"],
  "South Africa": ["hallo", "goeie dag", "goeiedag", "sawubona", "molo", "howzit", "dumela"],

  // --- Europe -----------------------------------------------------------------
  Greece: ["γεια", "γεια σας", "γεια σου", "καλημέρα", "καλησπέρα", "χαίρετε", "yia sas", "yiasou", "kalimera"],
  Netherlands: ["hallo", "hoi", "goedemorgen", "goedemiddag", "goedendag", "goeiedag", "dag"],
  Belgium: ["hallo", "hoi", "dag", "goedemiddag", ...FRENCH],
  France: FRENCH,
  Spain: SPANISH,
  Portugal: PORTUGUESE,
  Iceland: ["halló", "hallo", "góðan dag", "góðan daginn", "sæl", "sæll", "komdu sæl"],
  Cyprus: ["γεια", "γεια σας", "καλημέρα", "καλησπέρα", "yia sas", "kalimera"],
  Finland: ["hei", "moi", "terve", "moro", "hyvää päivää", "huomenta"],
  Bulgaria: ["здравей", "здравейте", "добър ден", "добро утро", "привет", "zdravei", "dobar den"],
  Hungary: ["szia", "sziasztok", "helló", "hello", "jó napot", "jó reggelt", "üdvözlöm"],
  Lithuania: ["labas", "sveiki", "laba diena", "labas rytas", "labas vakaras"],
  Latvia: ["sveiki", "sveiks", "labdien", "labrīt", "labvakar", "čau"],
  Estonia: ["tere", "tervist", "tere hommikust", "tere päevast", "tere õhtust"],
  Ukraine: ["привіт", "вітаю", "добрий день", "доброго дня", "добрий вечір", "pryvit", "dobryi den"],
  Croatia: ["bok", "zdravo", "dobar dan", "dobro jutro", "ćao", "cao", "pozdrav"],
  Slovenia: ["zdravo", "živjo", "zivjo", "dober dan", "dobro jutro", "pozdravljeni"],
  "North Macedonia": ["здраво", "добар ден", "добро утро", "zdravo", "dobar den"],
  Serbia: ["здраво", "добар дан", "zdravo", "dobar dan", "ćao", "cao", "pozdrav"],
  Montenegro: ["здраво", "zdravo", "dobar dan", "ćao", "cao"],
  Albania: ["përshëndetje", "pershendetje", "tungjatjeta", "tung", "ç'kemi", "c'kemi", "mirëdita", "miredita"],
  Italy: ["ciao", "salve", "buongiorno", "buon giorno", "buonasera", "buona sera"],
  Romania: ["bună", "buna", "salut", "bună ziua", "buna ziua", "bună dimineața"],
  Switzerland: [...GERMAN, ...FRENCH, "ciao", "buongiorno"],
  "Czech Republic": ["ahoj", "dobrý den", "dobry den", "čau", "cau", "zdravím", "dobré ráno"],
  Slovakia: ["ahoj", "dobrý deň", "dobry den", "čau", "cau", "zdravím"],
  Austria: [...GERMAN, "grüß gott", "gruess gott"],
  Denmark: ["hej", "hejsa", "goddag", "hallo", "godmorgen"],
  Sweden: ["hej", "hejsan", "tjena", "god dag", "god morgon"],
  Norway: ["hei", "hallo", "god dag", "god morgen", "heisann"],
  Poland: ["cześć", "czesc", "dzień dobry", "dzien dobry", "witam", "hej", "siema"],
  Germany: GERMAN,
  Russia: RUSSIAN,

  // --- Latin America + Caribbean ---------------------------------------------
  Peru: SPANISH,
  Mexico: [...SPANISH, "qué onda", "que onda"],
  Cuba: SPANISH,
  Argentina: SPANISH,
  Brazil: PORTUGUESE,
  Chile: SPANISH,
  Colombia: SPANISH,
  Venezuela: SPANISH,
  Guatemala: SPANISH,
  "El Salvador": SPANISH,
  Honduras: SPANISH,
  Nicaragua: SPANISH,
  "Costa Rica": [...SPANISH, "pura vida"],
  Panama: SPANISH,
  Bolivia: SPANISH,
  Ecuador: SPANISH,
  Paraguay: [...SPANISH, "mba'éichapa"],
  Uruguay: SPANISH,

  // --- Middle East + Caucasus + Central Asia ----------------------------------
  Turkey: ["merhaba", "selam", "selamlar", "günaydın", "gunaydin", "iyi günler", "iyi gunler", "iyi akşamlar"],
  Lebanon: [...ARABIC, "kifak", "kifik"],
  Jordan: ARABIC,
  Kuwait: ARABIC,
  "Saudi Arabia": ARABIC,
  Oman: ARABIC,
  "United Arab Emirates": ARABIC,
  Israel: ["שלום", "היי", "הי", "בוקר טוב", "ערב טוב", "אהלן", "shalom", "ahlan"],
  Bahrain: ARABIC,
  Qatar: ARABIC,
  Azerbaijan: ["salam", "salam əleyküm", "salam aleykum", "sabahınız xeyir"],
  Georgia: ["გამარჯობა", "სალამი", "gamarjoba", "gamarjobat"],
  Armenia: ["բարև", "բարև ձեզ", "barev", "barev dzez"],
  Uzbekistan: ["salom", "assalomu alaykum", "assalom", "xayrli kun"],

  // --- South Asia --------------------------------------------------------------
  India: ["नमस्ते", "नमस्कार", "हैलो", "namaste", "namaskar", "namaskaram", "vanakkam", "வணக்கம்", "sat sri akal"],
  Pakistan: ["السلام علیکم", "سلام", "assalam o alaikum", "salam", "adaab"],
  "Sri Lanka": ["ආයුබෝවන්", "හෙලෝ", "ayubowan", "ayubovan", "vanakkam", "வணக்கம்"],
  Bangladesh: ["নমস্কার", "হ্যালো", "আসসালামু আলাইকুম", "nomoshkar", "assalamu alaikum", "salam"],
  Nepal: ["नमस्ते", "नमस्कार", "namaste", "namaskar"],

  // --- Southeast + East Asia ---------------------------------------------------
  Malaysia: MALAY,
  Indonesia: [...MALAY, "selamat siang", "selamat sore", "permisi"],
  Philippines: [
    "kumusta", "kamusta", "kumusta po", "kamusta po", "musta",
    "magandang araw", "magandang umaga", "magandang hapon", "magandang gabi", "mabuhay",
  ],
  Thailand: [
    "สวัสดีครับ", "สวัสดีค่ะ", "สวัสดีคะ", "สวัสดี", "หวัดดี", "ยินดี",
    "sawasdee krub", "sawasdee ka", "sawasdee", "sawatdee krub", "sawatdee ka", "sawatdee", "sawadee",
  ],
  Vietnam: ["xin chào", "xin chao", "chào bạn", "chào anh", "chào chị", "chào", "chao ban", "alo"],
  Cambodia: ["សួស្តី", "សួស្ដី", "ជំរាបសួរ", "suosdei", "sousdey", "susadei", "chum reap suor"],
  Laos: ["ສະບາຍດີ", "ສະບາຍດີບໍ", "sabaidee", "sabaydee", "sabai dee"],
  Myanmar: ["မင်္ဂလာပါ", "မဂၤလာပါ", "ဟယ်လို", "mingalaba", "mingalabar", "mingala ba"],
  Japan: ["こんにちは", "こんばんは", "おはようございます", "おはよう", "もしもし", "はじめまして", "konnichiwa", "ohayou", "ohayo"],
  "South Korea": ["안녕하세요", "안녕하십니까", "안녕", "여보세요", "annyeonghaseyo", "annyeong"],
  China: CHINESE,
  Taiwan: CHINESE,
  Mongolia: ["сайн байна уу", "сайн уу", "байна уу", "sain baina uu", "sain uu"],
};
/** Scripts that do NOT separate words with spaces, so a greeting in them can be
 * followed immediately by the next word ("こんにちはバイクありますか"). They get a
 * loose right boundary; every space-separated script keeps the strict one. */
// Thai, Lao, Burmese, Khmer, CJK (incl. kana + fullwidth) and Hangul.
const UNSPACED_SCRIPT_RX =
  /[\u0E00-\u0EFF\u1000-\u109F\u1780-\u17FF\u3000-\u30FF\u3400-\u9FFF\uAC00-\uD7AF\uFF00-\uFFEF]/;
/** The loose boundary: any run of spacing/CJK punctuation, possibly empty. */
const LOOSE_BOUNDARY = "[\\s!,.…~、，。！？：；]*";

/** Trailing politeness particles that ride a local greeting ("สวัสดีครับ",
 * "kumusta po") and the "X again" adverb both nudge templates used. */
const LOCAL_TAIL = "(?:\\s*(?:again|krub|krap|kha|ka|po|na|lah))?";

const byLengthDesc = (a: string, b: string) => b.length - a.length;

const localEntries = Array.from(new Set(Object.values(LOCAL_GREETINGS).flat()));
const unspaced = localEntries.filter((g) => UNSPACED_SCRIPT_RX.test(g)).sort(byLengthDesc).map(esc);
const spaced = localEntries.filter((g) => !UNSPACED_SCRIPT_RX.test(g)).sort(byLengthDesc).map(esc);

// ---------------------------------------------------------------------------
// The two exported patterns
// ---------------------------------------------------------------------------

/**
 * A leading English greeting, with noise tolerance and a right boundary.
 *
 * `(?:\s+again)?` is the "X again!" form both nudge templates used; the closing
 * group forces punctuation, whitespace or end-of-string after the greeting word
 * so "Hitting", "Hola" inside a word, or "Yohan" can never be clipped.
 */
export const LEADING_GREETING_RX = new RegExp(
  `^${NOISE}(?:` +
    `(?:${EN_STRONG})(?:\\s+again)?${BOUNDARY}` +
    `|(?:${EN_WEAK})(?:\\s+again)?${PUNCT_BOUNDARY}` +
    `|${WAVE}${LOOSE_BOUNDARY}` +
    `)`,
  "iu"
);

/**
 * The same question for a message we did NOT write in English.
 *
 * A SECOND line of defence: the first is telling `localizeMessage` not to write
 * a greeting at all when the thread is already open. Built from LOCAL_GREETINGS,
 * which is keyed by region.ts's country map - so this can never fall behind the
 * markets the app localizes into (hole 5).
 */
export const LEADING_LOCAL_GREETING_RX = new RegExp(
  `^${NOISE}(?:` +
    `(?:${unspaced.join("|")})${LOCAL_TAIL}${LOOSE_BOUNDARY}` +
    `|(?:${spaced.join("|")})${LOCAL_TAIL}${BOUNDARY}` +
    `)`,
  "iu"
);

/** Does this message open with a greeting (English or one of the local ones)? */
export function hasLeadingGreeting(text: string): boolean {
  return LEADING_GREETING_RX.test(text ?? "") || LEADING_LOCAL_GREETING_RX.test(text ?? "");
}

/**
 * Remove a leading greeting - the deterministic repair for a message that is
 * NOT the first thing we have ever said to this shop.
 *
 * RUNS TO A FIXED POINT (hole 3). One pass per pattern left "Hi! Hi there, any
 * chance on 250?" and "สวัสดีครับ Hi, ลด 250 ได้ไหม" still greeted - the second is
 * what localizeMessage produces when it half-obeys "no English words". The loop
 * is bounded (a strip that removes nothing stops it, and 4 is far past any real
 * message) so this can never spin.
 *
 * Never strips a message down to nothing: a bare "Hi!" is a poor message but a
 * blank one is a lost turn, so the last non-empty form survives. The first
 * letter is re-capitalised because the greeting carried the sentence's capital.
 */
export function stripLeadingGreeting(text: string): string {
  const original = String(text ?? "");
  let out = original;
  for (let pass = 0; pass < 4; pass++) {
    let next: string | null = null;
    for (const rx of [LEADING_GREETING_RX, LEADING_LOCAL_GREETING_RX]) {
      if (!rx.test(out)) continue;
      next = out.replace(rx, "");
      break;
    }
    if (next === null) break; // nothing left that opens with a greeting
    if (!next.trim()) break; // never strip a message down to nothing
    out = next;
  }
  if (out === original) return original;
  // A separator the removed greeting was leaning on ("Hello! Good morning - is
  // 250 ok?" left "- is 250 ok?"): the dash belonged to the greeting, not to
  // the sentence. Only ever runs after something WAS stripped, and never to
  // nothing.
  const unhinged = out.replace(/^[\s\-–—,.:;·|]+/, "");
  if (unhinged.trim()) out = unhinged;
  return out.charAt(0).toUpperCase() + out.slice(1);
}
