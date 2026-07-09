// Popular-questions (FAQ) store. Questions + answers are kept as a JSON array in
// app_config ("faq_items"), so management can add / remove / AI-generate them
// without a redeploy. Seeded with global, country-neutral answers so the section
// is useful on day one anywhere in the world.

import "server-only";
import { getConfig, setConfig } from "./runtime-config";

export interface FaqItem {
  id: string;
  q: string;
  a: string;
}

const SEED: FaqItem[] = [
  {
    id: "how-it-works",
    q: "How does WheelDeal actually get me a cheaper price?",
    a: "You tell us the vehicle and dates. Our agents message real rental shops near your hotel, ask for their best daily price in the shop's own language, and bargain once - politely - anchored to the real local market rate. You just pick the best offer.",
  },
  {
    id: "who-messages",
    q: "Who sends the WhatsApp messages - is it my number?",
    a: "Messages go from your own connected WhatsApp so shops reply to a real person. We only ever message shops you are asking about - we never read or touch your personal chats.",
  },
  {
    id: "currency",
    q: "What currency are the prices in?",
    a: "Always the shop's local currency - the money you actually pay on the ground. We never secretly convert to dollars.",
  },
  {
    id: "deposit",
    q: "A shop asked for a deposit or my passport. Is that normal?",
    a: "Yes - most rental shops hold a cash deposit or a passport/ID copy during the rental. It is standard and is returned when you bring the vehicle back. WheelDeal only connects you; the agreement is directly with the shop.",
  },
  {
    id: "delivery",
    q: "Can they deliver the vehicle to my hotel?",
    a: "Many shops do, sometimes for a small fee. If you ask, your agent captures whether delivery is free or paid and to where, so you can compare it fairly against pickup.",
  },
  {
    id: "safety",
    q: "Is WheelDeal responsible for the rental?",
    a: "No - WheelDeal finds and negotiates, but the rental agreement, the vehicle, insurance and any deposit are strictly between you and the independent shop, at your own risk. Always check the vehicle and the terms before you pay.",
  },
];

export async function listFaq(): Promise<FaqItem[]> {
  try {
    const raw = await getConfig("faq_items");
    if (raw) {
      const parsed = JSON.parse(raw) as FaqItem[];
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    /* fall through to seed */
  }
  return SEED;
}

export async function saveFaq(items: FaqItem[]): Promise<void> {
  await setConfig("faq_items", JSON.stringify(items.slice(0, 60)));
}

export async function addFaq(q: string, a: string): Promise<FaqItem[]> {
  const items = await listFaq();
  const item: FaqItem = {
    id: `faq-${Date.now().toString(36)}`,
    q: q.trim().slice(0, 240),
    a: a.trim().slice(0, 1200),
  };
  const next = [...items, item];
  await saveFaq(next);
  return next;
}

export async function removeFaq(id: string): Promise<FaqItem[]> {
  const items = (await listFaq()).filter((i) => i.id !== id);
  await saveFaq(items);
  return items;
}
