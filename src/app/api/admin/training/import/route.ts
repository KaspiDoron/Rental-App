import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import {
  ensureConnected,
  fetchChats,
  fetchMessages,
  resolveChatJid,
  hasSessionRow,
} from "@/lib/evolution";
import { chat, extractJson } from "@/lib/ai";
import { addTraining } from "@/lib/memory";
import { sbInsert } from "@/lib/runtime-config";

// Teach the bargaining agents from the owner's OWN WhatsApp chats with rental
// shops. The owner PASTES the shops' WhatsApp numbers (the places they have
// really haggled with); the app reads ONLY those conversations, cleans them
// with the AI, and stores them as training transcripts. Nothing else is read -
// personal chats are never touched, because only the numbers you name are opened.
//
// If no numbers are given we fall back to scanning recent 1:1 chats and letting
// the AI keep only the genuine rental negotiations (older behaviour, kept as a
// convenience), but the number list is the intended, privacy-first path.
const MAX_NUMBERS = 50;
const MAX_CHATS = 25;
const MAX_MSGS = 60;

function toJid(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length < 7) return null; // not a real phone number
  return `${digits}@s.whatsapp.net`;
}

async function learnFromTranscript(
  transcript: string,
  label: string,
  email: string,
  trustRental: boolean
): Promise<boolean> {
  // Ask the AI to clean (and, when scanning, classify) the transcript.
  const out = await chat([
    {
      role: "system",
      content:
        "You review a WhatsApp chat transcript between a traveller and a vehicle " +
        "rental shop (car/scooter/motorbike). Return ONLY JSON: " +
        '{ "isRentalBargain": boolean, "cleanTranscript": string }. cleanTranscript ' +
        "keeps only the negotiation lines (price, discount, availability, deposit), " +
        "each prefixed 'Me:' or 'Shop:'. If it is clearly NOT a rental chat, set " +
        "isRentalBargain false and cleanTranscript ''.",
    },
    { role: "user", content: transcript },
  ]);

  if (!out) {
    // No AI provider: keep it if the owner named this number (trustRental) or it
    // reads like a rental chat.
    const looksRental =
      /\b(rent|rental|scooter|motor|bike|car|per day|\/day|price|discount|deposit|helmet|cc)\b/i.test(
        transcript
      );
    if (!trustRental && !looksRental) return false;
    const ex = addTraining(transcript.slice(0, 3500), label);
    await sbInsert("agent_training", [
      { text: ex.text, note: ex.note ?? null, added_by: email, source: "whatsapp" },
    ]);
    return true;
  }

  const parsed = extractJson<{ isRentalBargain?: boolean; cleanTranscript?: string }>(out);
  const clean = parsed?.cleanTranscript?.trim();
  // For owner-named numbers we trust it is a rental shop even if the AI is unsure,
  // as long as it produced a usable cleaned transcript.
  const keep = clean && clean.length > 30 && (trustRental || parsed?.isRentalBargain);
  if (!keep) return false;
  const ex = addTraining(clean, label);
  await sbInsert("agent_training", [
    { text: ex.text, note: ex.note ?? null, added_by: email, source: "whatsapp" },
  ]);
  return true;
}

export async function POST(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Try to bring the live socket up, but do NOT hard-block on it: on a cold
  // free-tier server a genuinely-linked session can take longer than the probe
  // budget to report "open". As long as the user has EVER linked (a session row
  // exists) we proceed and attempt the read - a transient wake-up must never be
  // mistaken for "not connected" (this was why teaching failed while connected).
  const conn = await ensureConnected(session.email, 9000);
  if (!conn.ok && !(await hasSessionRow(session.email))) {
    return NextResponse.json(
      { error: "Connect your WhatsApp first (Profile -> Your WhatsApp), then import." },
      { status: 400 }
    );
  }
  const waking = !conn.ok; // linked, but the socket was still coming up

  const body = await req.json().catch(() => ({}));
  const rawNumbers: string[] = Array.isArray(body?.numbers)
    ? body.numbers
    : typeof body?.numbers === "string"
    ? String(body.numbers).split(/[\n,]+/)
    : [];
  const rawList = rawNumbers
    .map((n) => String(n).trim())
    .filter((n) => n.replace(/[^\d]/g, "").length >= 7)
    .slice(0, MAX_NUMBERS);

  let imported = 0;
  let scanned = 0;
  const notFound: string[] = [];
  const samples: string[] = [];

  if (rawList.length > 0) {
    // PRIVACY-FIRST PATH: read only the shop numbers the owner pasted.
    for (const raw of rawList) {
      // Resolve to WhatsApp's canonical JID first (handles format differences
      // and the new @lid privacy JIDs) - this is what fixes "no chat found".
      const jid = (await resolveChatJid(session.email, raw)) ?? toJid(raw);
      if (!jid) continue;
      let msgs = await fetchMessages(session.email, jid, MAX_MSGS);
      // Retry with the plain digits JID if the canonical one was empty.
      if (msgs.length < 2 && !jid.endsWith("@s.whatsapp.net")) {
        const alt = toJid(raw);
        if (alt) msgs = await fetchMessages(session.email, alt, MAX_MSGS);
      }
      if (msgs.length < 2) {
        notFound.push(raw);
        continue; // no real conversation with this number
      }
      scanned += 1;
      const transcript = msgs
        .map((m) => `${m.fromMe ? "Me" : "Shop"}: ${m.text.replace(/\s+/g, " ").trim()}`)
        .join("\n")
        .slice(0, 3500);
      const number = jid.replace("@s.whatsapp.net", "");
      if (await learnFromTranscript(transcript, `WhatsApp: +${number}`, session.email, true)) {
        imported += 1;
        if (samples.length < 5) samples.push(`+${number}`);
      }
    }
    return NextResponse.json({
      imported,
      scanned,
      notFound,
      note:
        imported > 0
          ? `Learned from ${imported} shop chat${imported === 1 ? "" : "s"}${
              samples.length ? ` (${samples.join(", ")})` : ""
            }.${notFound.length ? ` Couldn't find a chat for: ${notFound.join(", ")}.` : ""} The agents now bargain in your style.`
          : `No readable conversation found for: ${notFound.join(", ") || "those numbers"}. ${
              waking
                ? "Your WhatsApp was still waking up on the server - give it ~30 seconds and tap import again."
                : "This WhatsApp needs a moment to finish syncing your chat history after connecting - wait ~1 minute and try again, and double-check you chatted with them on THIS number."
            }`,
    });
  }

  // FALLBACK: no numbers given - scan recent 1:1 chats and let the AI keep only
  // genuine rental negotiations.
  const chats = (await fetchChats(session.email)).slice(0, MAX_CHATS);
  if (chats.length === 0) {
    return NextResponse.json({ imported: 0, scanned: 0, note: "No individual chats found yet." });
  }
  for (const c of chats) {
    const msgs = await fetchMessages(session.email, c.jid, MAX_MSGS);
    const mine = msgs.filter((m) => m.fromMe).length;
    const theirs = msgs.filter((m) => !m.fromMe).length;
    if (msgs.length < 4 || mine < 2 || theirs < 2) continue;
    scanned += 1;
    const transcript = msgs
      .map((m) => `${m.fromMe ? "Me" : "Shop"}: ${m.text.replace(/\s+/g, " ").trim()}`)
      .join("\n")
      .slice(0, 3500);
    if (await learnFromTranscript(transcript, `WhatsApp: ${c.name ?? c.jid}`, session.email, false)) {
      imported += 1;
      if (samples.length < 3) samples.push(c.name ?? "a shop");
    }
  }
  return NextResponse.json({
    imported,
    scanned,
    note:
      imported > 0
        ? `Learned from ${imported} real rental chat${imported === 1 ? "" : "s"}${
            samples.length ? ` (e.g. ${samples.join(", ")})` : ""
          }. Tip: paste the shops' numbers above for exact, private control.`
        : "Scanned your chats but found no clear rental negotiations. Try pasting the shops' numbers above.",
  });
}

// Vercel: allow slow AI/WhatsApp upstreams (Hobby default is ~10s - too short).
export const maxDuration = 60;
