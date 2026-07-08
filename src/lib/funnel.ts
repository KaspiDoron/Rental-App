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

export function defaultFunnel(): FunnelNode {
  return {
    id: "root",
    label: "Shop replies",
    condition: "The shop answers our first message",
    message: "Read the reply and decide the ONE next move.",
    children: [
      {
        id: nid(),
        label: "No clear price yet",
        condition: "Reply has no price for the exact vehicle",
        message: "Ask ONE friendly clarifying question (only once).",
        children: [],
      },
      {
        id: nid(),
        label: "Gave a price",
        condition: "Reply contains a usable daily price",
        message: "Compare to the local market floor.",
        children: [
          {
            id: nid(),
            label: "Already at the floor",
            condition: "Price is at/under the local floor",
            message: "Thank them and close warmly - do NOT push.",
            children: [],
          },
          {
            id: nid(),
            label: "Above the floor",
            condition: "Price is above the local floor",
            message: "Make our ONE friendly ask at the floor-anchored target.",
            children: [
              {
                id: nid(),
                label: "They answered our ask",
                condition: "Shop replies to our single ask",
                message: "Thank them and stop, whatever they said. Never push again.",
                children: [],
              },
            ],
          },
        ],
      },
      {
        id: nid(),
        label: "Vague answer",
        condition: "Reply is vague (\"come to the shop\", \"depends\"...)",
        message: "Log a funnel-gap, notify the owner, and stay polite.",
        children: [],
      },
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
