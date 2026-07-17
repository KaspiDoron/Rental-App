// Deterministic transcript ordering for the Ops console.
//
// The old merge sorted by timestamp alone; rows sharing a second kept their
// SPREAD order (all outbounds before all inbounds), so an agent's reply
// rendered ABOVE the shop message it answered - the "messages look merged /
// mixed up" confusion. Causality tiebreak: at equal timestamps the INBOUND
// came first (our outbound within the same second is the response to it),
// then numeric row id as the final stable key.

export interface TranscriptEntry {
  id: string; // "o<rowId>" | "i<rowId>"
  dir: "in" | "out";
  at: string;
}

export function sortTranscript<T extends TranscriptEntry>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    const ta = Date.parse(a.at);
    const tb = Date.parse(b.at);
    if (ta !== tb) return ta - tb;
    if (a.dir !== b.dir) return a.dir === "in" ? -1 : 1;
    // Stable last resort: numeric insert id (monotonic per table).
    return Number(a.id.slice(1)) - Number(b.id.slice(1));
  });
}
