import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { connectionState, fetchChats, fetchMessages } from "@/lib/evolution";
import { chat, extractJson } from "@/lib/ai";
import { addTraining } from "@/lib/memory";
import { sbInsert } from "@/lib/runtime-config";

// Auto-teach the bargaining agents from the owner's OWN WhatsApp chats with
// rental shops. Zero manual work: connect WhatsApp, tap Import, and the app
// reads recent 1:1 chats, asks the AI which are vehicle-rental price
// negotiations, and stores the good ones as training transcripts.
//
// Bounded so it never runs away: at most MAX_CHATS chats, MAX_MSGS messages
// each, and only conversations with real back-and-forth.
const MAX_CHATS = 25;
const MAX_MSGS = 50;

export async function POST() {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  if ((await connectionState(session.email)) !== "open") {
    return NextResponse.json(
      { error: "Connect your WhatsApp first (Profile -> Your WhatsApp), then import." },
      { status: 400 }
    );
  }

  const chats = (await fetchChats(session.email)).slice(0, MAX_CHATS);
  if (chats.length === 0) {
    return NextResponse.json({ imported: 0, scanned: 0, note: "No individual chats found yet." });
  }

  let imported = 0;
  let scanned = 0;
  const samples: string[] = [];

  for (const c of chats) {
    const msgs = await fetchMessages(session.email, c.jid, MAX_MSGS);
    // Need a real conversation with both sides.
    const mine = msgs.filter((m) => m.fromMe).length;
    const theirs = msgs.filter((m) => !m.fromMe).length;
    if (msgs.length < 4 || mine < 2 || theirs < 2) continue;
    scanned += 1;

    const transcript = msgs
      .map((m) => `${m.fromMe ? "Me" : "Shop"}: ${m.text.replace(/\s+/g, " ").trim()}`)
      .join("\n")
      .slice(0, 3500);

    // Ask the AI to classify + clean it (skip if no AI provider).
    const out = await chat([
      {
        role: "system",
        content:
          "You review a WhatsApp chat transcript. Decide if it is a real negotiation " +
          "with a VEHICLE RENTAL shop about renting a car/scooter/motorbike (asking " +
          "price, haggling, availability). Reply ONLY as JSON: " +
          '{ "isRentalBargain": boolean, "cleanTranscript": string }. cleanTranscript ' +
          "keeps only the relevant negotiation lines, each prefixed 'Me:' or 'Shop:'. " +
          "If not a rental negotiation, set isRentalBargain false and cleanTranscript ''.",
      },
      { role: "user", content: transcript },
    ]);

    if (!out) {
      // No AI available: fall back to a keyword heuristic so it still works.
      const looksRental =
        /\b(rent|rental|scooter|motor|bike|car|per day|\/day|price|discount|deposit|helmet|cc)\b/i.test(
          transcript
        );
      if (looksRental) {
        const ex = addTraining(transcript, `WhatsApp: ${c.name ?? c.jid}`);
        await sbInsert("agent_training", [
          { text: ex.text, note: ex.note ?? null, added_by: session.email, source: "whatsapp" },
        ]);
        imported += 1;
        if (samples.length < 3) samples.push(c.name ?? "a shop");
      }
      continue;
    }

    const parsed = extractJson<{ isRentalBargain?: boolean; cleanTranscript?: string }>(out);
    if (parsed?.isRentalBargain && parsed.cleanTranscript && parsed.cleanTranscript.length > 30) {
      const ex = addTraining(parsed.cleanTranscript, `WhatsApp: ${c.name ?? c.jid}`);
      await sbInsert("agent_training", [
        { text: ex.text, note: ex.note ?? null, added_by: session.email, source: "whatsapp" },
      ]);
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
          }. The agents now bargain in your style.`
        : "Scanned your chats but found no clear rental negotiations to learn from yet.",
  });
}
