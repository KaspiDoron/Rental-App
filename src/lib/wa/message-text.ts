// ONE READER FOR WHAT A WHATSAPP MESSAGE SAYS.
//
// THERE WERE TWO, AND THE LIVE PATH USED THE WEAKER ONE.
//
// `waMessageText` (this file, formerly private to evolution.ts) is the complete
// extractor: it peels every envelope WhatsApp wraps a payload in and reads
// every text-bearing subtype. It was wired ONLY to `fetchMessages` /
// `fetchMessagesRaw` - the wa-sync recovery sweep.
//
// The LIVE webhook path - `processEvolutionWebhook`, shared verbatim by the
// Next route and the BullMQ incoming worker, i.e. the code that handles every
// real shop reply as it arrives - had its own private `unwrap` + `extractText`
// that knew eight frame shapes and one envelope.
//
// So the recovery sweep could read a message the live path had already thrown
// away. A shop sent a sticker ("I'M SORRY", with "sorry tomorrow we closed and
// open again on 20th" beside it) and the agent saw nothing. Reactions, button
// and list replies, template replies, view-once media and edited messages were
// all silently dropped the same way.
//
// Both paths now share this file. The rule is: a message that arrived is never
// nothing. If we cannot read words, we say what kind of thing it was, so the
// agent knows a turn happened and the transcript is honest.

/** Every wrapper WhatsApp can nest a real payload inside. */
function innerEnvelope(message: Record<string, any>): Record<string, any> | null {
  return (
    message.ephemeralMessage?.message ??
    message.viewOnceMessage?.message ??
    message.viewOnceMessageV2?.message ??
    message.viewOnceMessageV2Extension?.message ??
    message.editedMessage?.message?.protocolMessage?.editedMessage ??
    message.documentWithCaptionMessage?.message ??
    null
  );
}

/**
 * Peel every envelope and return the payload that actually carries the content.
 *
 * The live path's old `unwrap` peeled ONLY `ephemeralMessage`, and it fed every
 * media detector - so a view-once photo or an edited message was not merely
 * unreadable, it was undetectable: `hasImageMessage` said false and the vision
 * job never ran.
 */
export function waUnwrap(data: any): Record<string, any> {
  let node: Record<string, any> = data?.message ?? data ?? {};
  // Bounded: WhatsApp nests a handful deep at most, and an unbounded loop on
  // attacker-shaped input is not a risk worth taking.
  for (let i = 0; i < 6; i += 1) {
    const inner = innerEnvelope(node);
    if (!inner) break;
    node = inner;
  }
  return node ?? {};
}

/**
 * Readable text for ANY Evolution/Baileys message, or a short placeholder for
 * media that carries no caption.
 *
 * A placeholder is deliberate, not a fallback: a photo-heavy price chat is a
 * real conversation, and a sticker is a real turn even though it has no words.
 */
export function waMessageText(message: any): string {
  if (!message || typeof message !== "object") return "";
  const m = waUnwrap(message);

  const text =
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    // Interactive replies. A shop tapping a button is answering us; treating
    // that as silence is how a thread looked abandoned when it was not.
    m.buttonsResponseMessage?.selectedDisplayText ??
    m.templateButtonReplyMessage?.selectedDisplayText ??
    m.listResponseMessage?.title ??
    m.reactionMessage?.text ??
    "";
  if (String(text).trim()) return String(text);

  if (m.imageMessage) return "[photo]";
  if (m.videoMessage) return "[video]";
  if (m.audioMessage) return "[voice note]";
  if (m.documentMessage) return "[document]";
  if (m.stickerMessage) return "[sticker]";
  if (m.locationMessage) return "[location]";
  if (m.contactMessage || m.contactsArrayMessage) return "[contact]";
  return "";
}

/**
 * The frame kind, for traces and for the "we saw something we cannot read"
 * path. Returns null when the payload is a plain text message.
 */
export function waMediaKind(message: any): string | null {
  const m = waUnwrap(message);
  if (m.imageMessage) return "image";
  if (m.videoMessage) return "video";
  if (m.audioMessage) return "audio";
  if (m.documentMessage) return "document";
  if (m.stickerMessage) return "sticker";
  if (m.locationMessage) return "location";
  if (m.contactMessage || m.contactsArrayMessage) return "contact";
  if (m.reactionMessage) return "reaction";
  if (m.pollCreationMessage || m.pollUpdateMessage) return "poll";
  return null;
}
