// The guide content model (wave 4.4). Deliberately DATA, not MDX: it is
// typed, one import feeds the hub, the detail route, the sitemap and the
// JSON-LD, so a guide cannot exist without being listed or be listed without
// existing - and MDX would break exactly that derivation.

/** One renderable block. The renderer is an exhaustive switch over `kind`. */
export type GuideBlock =
  | { kind: "p"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "table"; headers: string[]; rows: string[][] }
  | { kind: "callout"; text: string };

export interface GuideSection {
  heading: string;
  blocks: GuideBlock[];
}

export interface GuideFaq {
  q: string;
  a: string;
}

export type GuideCategory =
  | "prices"
  | "deposits-paperwork"
  | "licence-insurance"
  | "risk-safety"
  | "negotiation-logistics";

export const GUIDE_CATEGORY_LABELS: Record<GuideCategory, string> = {
  prices: "What things really cost",
  "deposits-paperwork": "Deposits & paperwork",
  "licence-insurance": "Licences & insurance",
  "risk-safety": "Risk & safety",
  "negotiation-logistics": "Negotiation & logistics",
};

export interface Guide {
  slug: string;
  title: string;
  /** One line for the hub card and the meta description. */
  summary: string;
  /** ISO date (YYYY-MM-DD) - feeds the Article JSON-LD dateModified. */
  updated: string;
  category: GuideCategory;
  /** Slugs of related guides, rendered as the per-article Related rail. */
  related: string[];
  sections: GuideSection[];
  /** Optional FAQ - rendered on the page AND emitted as FAQPage JSON-LD. */
  faq?: GuideFaq[];
}

/** Every visible word in a guide, for the substance floor in tests. */
export function guideText(g: Guide): string {
  const parts: string[] = [g.title, g.summary];
  for (const s of g.sections) {
    parts.push(s.heading);
    for (const b of s.blocks) {
      if (b.kind === "p" || b.kind === "callout") parts.push(b.text);
      else if (b.kind === "list") parts.push(...b.items);
      else parts.push(...b.headers, ...b.rows.flat());
    }
  }
  for (const f of g.faq ?? []) parts.push(f.q, f.a);
  return parts.join(" ");
}
