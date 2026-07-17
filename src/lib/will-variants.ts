// Response variety for Will. The same intent must never read the same way
// twice - a premium concierge varies wording, a bot repeats it. Golden replay
// never runs Will, so a random pick here is safe; it only affects tone.

export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] ?? arr[0];
}

// Pools for intents that carry no interpolated values.
const POOLS: Record<string, readonly string[]> = {
  open_feedback: [
    "Opening the feedback box - tell the team exactly what happened and they read every word.",
    "Let's get this to the humans. I'm opening feedback so you can describe it in your own words.",
    "Good call - I'm opening the feedback form. A real person reviews each one.",
    "On it. I'll open feedback so your report goes straight to the team.",
  ],
  clarify: [
    "I didn't quite catch that - want me to tweak the search (radius, budget, vehicle), compare offers, or tell you what's happening?",
    "Say the word and I'll act: change the radius or budget, filter by vehicle, compare the top shops, or give you a status.",
    "Not sure I follow yet - a change to the search, a comparison, or an update on the hunt?",
    "Help me aim: adjust the search, compare offers, open your deals, or hear what I'm doing right now?",
  ],
  hiccup: [
    "That one slipped - try me again in a second.",
    "Hmm, I lost that - mind saying it once more?",
    "Something hiccuped on my end - give it another go.",
  ],
  reconnect: [
    "I couldn't reach the server - check your connection and try again.",
    "No signal to my brain just now - one more try when you're back online.",
    "That didn't go through - looks like a connection blip. Try again in a moment.",
  ],
};

export function pickVariant(key: string): string {
  return pick(POOLS[key] ?? [""]);
}
