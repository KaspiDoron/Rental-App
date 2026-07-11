// Owner-editable negotiation funnel as an if/else tree (New#3/#10).
//
// This is a VISUAL, editable representation of how the agent negotiates: each
// node is a condition + the action/message the agent takes. The live funnel
// logic lives in agent-loop.ts; this tree lets the owner see it as a map, edit
// the wording/branches, get AI suggestions, and it auto-grows a branch when a
// shop gives a vague answer. Stored in Supabase config as `funnel_tree`.

import "server-only";
import { getConfig, setConfig } from "./runtime-config";

export interface FunnelNode {
  id: string;
  label: string; // short title of the step
  condition: string; // the "if" that leads here
  message: string; // what the agent does / says
  auto?: boolean; // true = auto-generated branch (e.g. from a vague reply)
  children: FunnelNode[];
}

let counter = 0;
const nid = () => `n${Date.now().toString(36)}${(counter++).toString(36)}`;

// A deeply-researched negotiation decision tree that covers the real edge cases
// a rental-shop chat throws at the agent: silence, vague replies, price above /
// at / below the floor, counter-offers, upsells, deposit/insurance/fuel terms,
// delivery, availability/out-of-stock, wrong vehicle offered, "come visit",
// language barriers, and rude/pushy shops. The agent's core rules never change:
// ask ONCE, never push, anchor to the local floor, stay warmly human, and quote
// only in the shop's own local currency.
export function defaultFunnel(): FunnelNode {
  const leaf = (label: string, condition: string, message: string): FunnelNode => ({
    id: nid(),
    label,
    condition,
    message,
    children: [],
  });
  return {
    id: "root",
    label: "Shop replies (or not)",
    condition: "After we send the first RFQ to the shop",
    message: "Read the whole thread and pick the ONE best next move.",
    children: [
      {
        id: nid(),
        label: "No reply yet",
        condition: "The shop has not answered our first message",
        message: "Wait patiently within business hours - do NOT double-text.",
        children: [
          leaf(
            "Still silent after a while",
            "No reply and their opening hours have passed",
            "Send at most ONE soft, friendly nudge next time they are open. Never spam."
          ),
          leaf(
            "Number not on WhatsApp",
            "Send fails / not a WhatsApp account",
            "Mark unreachable, drop it quietly, and lean on the other shops."
          ),
        ],
      },
      {
        id: nid(),
        label: "No clear price yet",
        condition: "They replied but gave no usable price for the exact vehicle",
        message: "Ask ONE friendly clarifying question - only once.",
        children: [
          leaf(
            "Wrong vehicle quoted",
            "They priced a different bike/car than we asked for",
            "Politely restate the exact vehicle + dates and ask for that price once."
          ),
          leaf(
            "Asks our dates/length first",
            "They need the rental length before quoting",
            "Give the dates and total days clearly, then let them quote."
          ),
          leaf(
            "Language barrier",
            "Reply is broken / in another language",
            "Switch to their local language, keep it short and simple, ask once."
          ),
        ],
      },
      {
        id: nid(),
        label: "Gave a price",
        condition: "Reply contains a usable daily price for the vehicle",
        message: "Compare it to the local market floor before doing anything.",
        children: [
          leaf(
            "At/under the floor",
            "Price is already at or below the local floor",
            "Thank them warmly WITHOUT committing (the traveller decides) - do NOT push."
          ),
          {
            id: nid(),
            label: "Above the floor",
            condition: "Price is above the local floor",
            message: "Make our ONE friendly ask at the floor-anchored target.",
            children: [
              leaf(
                "They accepted",
                "Shop agrees to our target (or close)",
                "Thank them warmly and stop - the traveller confirms the booking, never the agent."
              ),
              leaf(
                "Counter-offer",
                "They meet us partway with a new number",
                "If it is at/near the floor, accept gladly. Never grind for more."
              ),
              leaf(
                "Held firm",
                "They repeat their price / say no discount",
                "Thank them, keep the standing price, and stop. Never push twice."
              ),
            ],
          },
          {
            id: nid(),
            label: "Price has conditions",
            condition: "The quote hides deposit / insurance / fuel / mileage terms",
            message: "Surface the real all-in cost before comparing.",
            children: [
              leaf(
                "Big deposit / passport",
                "They want a large cash deposit or passport",
                "Note it as a tag for the traveller - do not haggle the deposit itself."
              ),
              leaf(
                "Insurance / fuel extra",
                "Insurance, fuel, or delivery is charged on top",
                "Confirm the true daily total, then compare THAT to the floor."
              ),
            ],
          },
          leaf(
            "Tried to upsell",
            "They push a pricier vehicle or add-ons",
            "Stay on the exact vehicle we asked for; decline extras politely."
          ),
        ],
      },
      {
        id: nid(),
        label: "Availability problem",
        condition: "Vehicle is out of stock or unavailable for our dates",
        message: "Ask once if anything equivalent is free on those dates; else close.",
        children: [
          leaf(
            "Equivalent offered",
            "They have a similar vehicle for the dates",
            "Treat it as a fresh quote: compare to the floor, then the ONE ask."
          ),
        ],
      },
      {
        id: nid(),
        label: "Vague / deflecting",
        condition: 'Reply is vague ("come to the shop", "depends", "DM later")',
        message: "Ask once for a ballpark daily price; log a funnel-gap; stay polite.",
        children: [
          leaf(
            "Insists on visiting",
            "They will only price in person",
            "Note 'quote in person' for the traveller and move on - never argue."
          ),
        ],
      },
      leaf(
        "Rude / pushy",
        "Shop is aggressive, rude, or spammy",
        "Stay calm and courteous, do not engage, close the thread cleanly."
      ),
    ],
  };
}

export async function getFunnel(): Promise<FunnelNode> {
  try {
    const raw = await getConfig("funnel_tree");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.id) return parsed;
    }
  } catch {
    /* fall through to default */
  }
  return defaultFunnel();
}

export async function saveFunnel(tree: FunnelNode): Promise<void> {
  await setConfig("funnel_tree", JSON.stringify(tree));
}

/** Add an auto-branch under the "vague answer" node (called when a shop dodges). */
export async function autoBranchVague(detail: string): Promise<void> {
  try {
    const tree = await getFunnel();
    const findVague = (n: FunnelNode): FunnelNode | null => {
      if (/vague/i.test(n.label)) return n;
      for (const c of n.children) {
        const hit = findVague(c);
        if (hit) return hit;
      }
      return null;
    };
    const vague = findVague(tree);
    if (!vague) return;
    // Don't duplicate: cap auto-branches so the tree doesn't grow forever.
    const autos = vague.children.filter((c) => c.auto);
    if (autos.length >= 8) return;
    if (vague.children.some((c) => c.message === detail.slice(0, 120))) return;
    vague.children.push({
      id: nid(),
      label: "New vague case",
      condition: detail.slice(0, 80),
      message: detail.slice(0, 120),
      auto: true,
      children: [],
    });
    await saveFunnel(tree);
  } catch {
    /* best-effort */
  }
}

export function newNode(): FunnelNode {
  return { id: nid(), label: "New step", condition: "If...", message: "Then...", children: [] };
}
