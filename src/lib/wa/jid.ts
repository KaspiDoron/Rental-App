import { digitsOnly } from "../phone";

/**
 * Does an Evolution message record's remoteJid belong to the requested chat?
 * PRIVACY-CRITICAL: this is the filter that stops the whole-inbox leak - if an
 * Evolution/Baileys version ignores the server-side `remoteJid` filter and
 * returns the entire instance inbox, this drops every record that isn't the
 * requested chat. Phone JIDs match on their numeric user part; privacy @lid
 * JIDs match ONLY by exact equality (their numeric part is NOT the phone
 * number, so they are never compared by digits - a wrong-contact match).
 */
export function jidMatches(recordJid: string, requestedJid: string): boolean {
  if (!recordJid || !requestedJid) return false;
  if (recordJid === requestedJid) return true;
  const isPhone = (j: string) => j.endsWith("@s.whatsapp.net") || j.endsWith("@c.us");
  if (isPhone(recordJid) && isPhone(requestedJid)) {
    return digitsOnly(recordJid.split("@")[0]) === digitsOnly(requestedJid.split("@")[0]);
  }
  return false;
}
