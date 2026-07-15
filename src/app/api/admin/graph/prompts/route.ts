import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { getPrompt, PROMPTS } from "@/lib/prompts";
import { getGraphSpec } from "@/lib/graph/engine";
import { directorSystemPrompt } from "@/lib/graph/director";
import { accentPrimerFor, TRANSCRIBE_SYSTEM } from "@/lib/graph/transcribe";

// The Backend inspector (owner/manager only): the REAL prompt of every agent,
// exactly as it goes to the LLM, presented Postman-style - method, endpoint,
// and the request body with the system prompt in full. No paraphrases: where a
// prompt is built in code, the same builder produces this preview.
export async function GET() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const spec = await getGraphSpec();
  const instr = (id: string) => spec.nodes.find((n) => n.id === id)?.instructions ?? "";

  const endpoint =
    "provider failover: groq -> cerebras -> sambanova -> deepseek -> together -> openrouter -> mistral -> huggingface -> gemini";

  const agents: {
    id: string;
    label: string;
    emoji: string;
    method: string;
    endpoint: string;
    system: string;
    userSample: string;
    note?: string;
  }[] = [
    {
      id: "director",
      label: "Negotiation Director",
      emoji: "🧠",
      method: "POST",
      endpoint,
      system: directorSystemPrompt(instr("director")),
      userSample:
        "THIS SEARCH SESSION (all shops):\n- Shop B: quoted 200 THB/day\n- Test Shop (THIS shop): 250 THB/day\n\nTHIS SHOP's thread:\nUs: Hi, need bike 125cc 3 days. Price?\nShop: 250 per day, high season now.\n\nShop's new message: 250 per day, high season now.\n\nNumbers: quoted 250 THB/day | our next target 200 | best rival offer 200 | real market floor 150 | bargain rounds used 0/3\nDeal fields still missing: deposit, fulfillment (delivery/pickup/on-shop)\n\nLEGAL MOVES (pick edgeId or wait/silent):\n- d-bargain: push toward the floor (round-aware) -> bargain\n- d-deposit-probe: price is settling - learn the deposit -> deposit-probe",
    },
    {
      id: "profiler",
      label: "Profiler - structures the traveller's request",
      emoji: "📝",
      method: "POST",
      endpoint,
      system: await getPrompt("profiler"),
      userSample: "125cc automatic scooter with a phone mount, under 20,000 km, for 3 days",
    },
    {
      id: "extract",
      label: "Offer Extractor (text + photos)",
      emoji: "🔎",
      method: "POST",
      endpoint: "Gemini vision -> Groq Llama-4 vision fallback (photos) / provider failover (text)",
      system:
        "(Built per request around the traveller's exact spec.) Core rules the code injects: " +
        "reply ONLY as JSON with found/pricePerDay/currency/matchesSpec/confidence/clarifyMessage/" +
        "deposit/delivers/deliveryFee/insuranceIncluded/kmLimitPerDay/fuelPolicy/imageKind/" +
        "pickupOffered/onShopOnly/shopFirm/shopTone/tags. TOTAL quotes divide into per-day " +
        "('900 for 3 day' = 300/day). PRICE-SHEET photos list many models - pick the row matching " +
        "the requested class + cc and return THAT price. Sheets can be in ANY language " +
        "('Letet: Utlevel vagy 3000 Baht' = deposit passport or 3000 baht). Odometer km is NEVER " +
        "a price. Bare numbers are the shop's LOCAL currency, never USD. Never guess deposits/terms." +
        (instr("extract") ? `\nOWNER INSTRUCTIONS: ${instr("extract")}` : ""),
      userSample: "(photo of a rental price board) + caption: 'this our price list'",
      note: "The full system prompt embeds the live RFQ + conversation history at runtime.",
    },
    {
      id: "transcribe",
      label: "Voice Transcriber (heavy accents)",
      emoji: "🎙️",
      method: "POST",
      endpoint: "https://api.groq.com/openai/v1/audio/transcriptions (whisper-large-v3) -> Gemini audio",
      system: `${TRANSCRIBE_SYSTEM}\n\nAccent primer (example for Chiang Mai):\n${accentPrimerFor("Chiang Mai, Thailand")}`,
      userSample: "(multipart form: file=note.ogg, model=whisper-large-v3, temperature=0, response_format=verbose_json, prompt=<accent primer>)",
    },
    {
      id: "coherence",
      label: "Media Coherence Validator",
      emoji: "🧿",
      method: "POST",
      endpoint,
      system:
        "You verify a machine interpretation of media (a voice-note transcript or an image " +
        "reading) from a vehicle rental shop against the WHOLE conversation. Flag ONLY real " +
        "inconsistencies: prices whose scale/currency contradicts the thread (a total read as " +
        "per-day), a vehicle that does not match what the traveller asked for, numbers that " +
        "contradict what the shop said earlier, or content clearly unrelated to this negotiation " +
        "(a mis-transcription). Mileage numbers on an odometer photo are NOT prices - never " +
        'confuse the two. Reply ONLY as JSON: { "coherent": boolean, "issues": string[], ' +
        '"correctedPricePerDay": number|null }.' +
        (instr("coherence") ? `\nOWNER INSTRUCTIONS: ${instr("coherence")}` : ""),
      userSample:
        "Traveller asked for: {\"vehicleClass\":\"motorbike\",\"engineSizeCc\":125,\"durationDays\":3}\nTypical local daily price: around 240.\nConversation so far:\nUs: ...\nShop: ...\n\nMedia kind: audio\nMachine interpretation: Hello, the bike is good condition, mileage is 35,000, come check it at shop\nStructured read: {\"pricePerDay\":null,...}",
    },
    {
      id: "bargain",
      label: "Bargainer (house rules + learned tactics)",
      emoji: "🥊",
      method: "POST",
      endpoint,
      system:
        (await getPrompt("bargain_directives")) +
        (instr("bargain") ? `\n\nOWNER INSTRUCTIONS (node): ${instr("bargain")}` : ""),
      userSample:
        "Round 2 ask. Quoted 250 THB/day, target 200, floor 150, rival offer 200 from another shop. Conversation history + the last 5 outbound messages (do-not-repeat list) are embedded at runtime.",
      note: "composeBargain adds: tactic script, training examples, persona voice, round directives, anti-repetition list.",
    },
    {
      id: "style-validator",
      label: "Style & Uniqueness Validator",
      emoji: "🎨",
      method: "POST",
      endpoint,
      system:
        "You review ONE draft WhatsApp message from a traveller to a rental shop before it is " +
        "sent. Read the whole conversation. The draft must: directly fit the shop's last message; " +
        "never repeat a question the shop already answered; never greet again mid-conversation; " +
        "NEVER imply a deal is accepted or a booking confirmed (only the traveller decides); stay " +
        "in the same language the conversation is already in; sound like a casual human, not a " +
        'bot. Reply ONLY as JSON: { "verdict": "ok"|"revise"|"veto", "revised": string, "reasons": string[] }.' +
        (instr("style-validator") ? `\nOWNER INSTRUCTIONS: ${instr("style-validator")}` : ""),
      userSample: "Conversation so far:\n...\nShop's last message: 250 per day\nDraft reply: Can you do 200? I rent 3 days 🙂",
      note: "Plus deterministic layers that always run: greeting strip, duplicate veto, global trigram uniqueness, one-emoji tone.",
    },
    {
      id: "safety",
      label: "Safety Gate",
      emoji: "🛡️",
      method: "POST",
      endpoint,
      system: await getPrompt("safety"),
      userSample: "Okay sounds good! What deposit do you need for it? 🙂",
    },
    {
      id: "judge",
      label: "Move Judge (scores every outbound)",
      emoji: "🏅",
      method: "POST",
      endpoint,
      system:
        "You are a strict evaluator of ONE WhatsApp message a rental-negotiation agent sent on a " +
        "traveller's behalf. Score three criteria from 1 (poor) to 5 (excellent), each with a " +
        "SHORT reason:\n- tacticFit: did the move fit the situation (e.g. probing the deposit " +
        "once a price is known, not pushing when the shop is firm, never implying acceptance)?\n" +
        "- tone: warm, human, casual, non-pushy, exactly one emoji, not too long?\n- uniqueness: " +
        "does it read as freshly written, not a canned template?\nReply ONLY as JSON: " +
        '{ "tacticFit": 1-5, "tone": 1-5, "uniqueness": 1-5, "why": string }.',
      userSample: "Move type: auto-bargain\nConversation so far:\n...\nThe agent's message: Can you make new model for 150? I rent 3 days, long time 🙂",
    },
  ];

  // Owner-editable core prompts registry (Admin has always been able to edit
  // these; shown here so the whole backend is visible in one place).
  const registry = await Promise.all(
    PROMPTS.map(async (p) => ({ id: p.id, label: p.label, text: await getPrompt(p.id) }))
  );

  return NextResponse.json({ agents, registry });
}

export const maxDuration = 60;
