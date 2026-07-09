import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { chatDetailed, extractJson, aiEnabled } from "@/lib/ai";

// X (Twitter) post studio for the owner. The top-tier model drafts 5 ready-to-
// post options in WheelDeal's playful-yet-slick-professional voice, each with
// emojis, hashtags, a funny image idea and (where natural) a link CTA. The
// model is prompted to anchor posts to CURRENT travel / rental / deal trends
// and seasonal hooks so the feed feels timely.

export interface XPost {
  text: string;
  hashtags: string[];
  imageIdea: string;
  angle: string;
}

export async function POST(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!(await aiEnabled())) {
    return NextResponse.json(
      { error: "Add a top-tier AI key in Admin -> Keys first (Groq / DeepSeek / Gemini...)." },
      { status: 400 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const theme = String(body.theme ?? "").slice(0, 160).trim();
  const month = new Date().toLocaleString("en", { month: "long" });

  const system =
    "You are the social lead for WheelDeal - an app whose AI agents find and " +
    "bargain the cheapest car / motorbike / scooter rentals near a traveller's " +
    "hotel, in the shop's own language. Voice: playful, slick, a little cheeky, " +
    "confident but never cringe - think a witty travel-savvy founder. Write for X " +
    "(Twitter). Each post MUST: hook in the first line, be under 260 characters, " +
    "use 1-4 tasteful emojis, feel timely (lean on current travel/rental/deal " +
    "trends, viral money-saving angles, and seasonal hooks for " + month + "), and " +
    "sound human - never corporate. Vary the angles across the 5 (e.g. a hot take, " +
    "a relatable traveller pain, a flex on savings, a meme-y one, a myth-bust). " +
    "For each, also give 2-4 punchy hashtags and a funny/eye-catching image idea. " +
    'Reply ONLY as JSON: { "posts": [ { "text": string, "hashtags": string[], ' +
    '"imageIdea": string, "angle": string } ] } with EXACTLY 5 posts.';

  const user = theme
    ? `Make the 5 posts about: ${theme}`
    : "Give me 5 fresh, on-trend posts to grow the WheelDeal account.";

  // Two attempts: JSON-heavy prompts occasionally get truncated or a free-tier
  // host hiccups, so one silent retry makes the studio feel reliable.
  let out: string | null = null;
  let lastError: string | undefined;
  for (let attempt = 0; attempt < 2 && !out; attempt++) {
    const r = await chatDetailed(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { maxTokens: 1400 }
    );
    out = r.text;
    lastError = r.error;
  }
  if (!out) {
    return NextResponse.json(
      { error: lastError ? `AI provider error: ${lastError}` : "The AI provider did not respond - try again." },
      { status: 502 }
    );
  }
  const parsed = extractJson<{ posts: XPost[] }>(out);
  const posts = (parsed?.posts ?? [])
    .filter((p) => p && typeof p.text === "string")
    .slice(0, 5)
    .map((p) => ({
      text: p.text.trim(),
      hashtags: Array.isArray(p.hashtags) ? p.hashtags.slice(0, 5) : [],
      imageIdea: String(p.imageIdea ?? "").trim(),
      angle: String(p.angle ?? "").trim(),
    }));
  if (!posts.length) {
    return NextResponse.json({ error: "Could not parse suggestions - try again." }, { status: 502 });
  }
  return NextResponse.json({ posts });
}

// Vercel: allow slow AI/WhatsApp upstreams (Hobby default is ~10s - too short).
export const maxDuration = 60;
