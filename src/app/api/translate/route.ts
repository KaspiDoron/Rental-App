import { NextResponse } from "next/server";
import { chat, aiEnabled } from "@/lib/ai";
import { getConfig, setConfig } from "@/lib/runtime-config";

// AI translation for the app UI. Uses the configured AI providers (with
// automatic failover) - real context-aware translation, not word-by-word.
// Results are cached per language in Supabase (app_config) so each string is
// translated exactly once, ever.

const LANG_RX = /^[a-z]{2}(-[A-Z]{2})?$/;
const MAX_TEXTS = 500;
// Small chunks = higher translation quality (the model sees each string with
// full attention) and safer JSON output.
const CHUNK = 14;

async function translateChunk(
  langName: string,
  texts: string[]
): Promise<string[] | null> {
  const system =
    `You are a senior product localiser translating UI strings for "WheelDeal", a mobile app where AI agents bargain for vehicle rentals, from English to ${langName}. ` +
    "Rules: (1) translate MEANING, not word-by-word - use the natural phrasing a native mobile app in that language would use; " +
    "(2) match register: buttons/labels stay short and imperative, sentences stay friendly and simple; " +
    "(3) NEVER translate brand/product words: WheelDeal, Ultra, Pro, WhatsApp, Google, AI; " +
    "(4) keep emoji, numbers, currency symbols, punctuation and placeholders exactly; " +
    "(5) no explanations, no quotes added. " +
    'Reply ONLY as JSON: { "t": ["..."] } with translations in the exact same order and count.';
  const out = await chat([
    { role: "system", content: system },
    { role: "user", content: JSON.stringify(texts) },
  ]);
  if (!out) return null;
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    const parsed = JSON.parse(out.slice(start, end + 1)) as { t?: unknown };
    if (Array.isArray(parsed.t) && parsed.t.length === texts.length) {
      return parsed.t.map((s) => String(s));
    }
  } catch {}
  return null;
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const lang = String(body.lang ?? "").trim();
  const langName = String(body.langName ?? lang).slice(0, 40);
  const texts: string[] = Array.isArray(body.texts)
    ? body.texts.slice(0, MAX_TEXTS).map((t: unknown) => String(t).slice(0, 300))
    : [];

  if (!LANG_RX.test(lang)) {
    return NextResponse.json({ error: "Invalid language." }, { status: 400 });
  }
  if (lang === "en" || texts.length === 0) {
    return NextResponse.json({ map: {} });
  }

  const cacheKey = `I18N_${lang}`;
  let cached: Record<string, string> = {};
  try {
    cached = JSON.parse((await getConfig(cacheKey)) ?? "{}");
  } catch {}

  const missing = texts.filter((t) => !cached[t]);

  if (missing.length > 0) {
    if (!(await aiEnabled())) {
      return NextResponse.json({
        map: Object.fromEntries(
          texts.filter((t) => cached[t]).map((t) => [t, cached[t]])
        ),
        error:
          "AI translation needs at least one AI provider key (Admin -> Keys). Showing English for now.",
      });
    }
    let learned = false;
    for (let i = 0; i < missing.length; i += CHUNK) {
      const chunk = missing.slice(i, i + CHUNK);
      const out = await translateChunk(langName, chunk);
      if (out) {
        chunk.forEach((src, j) => {
          if (out[j]) cached[src] = out[j];
        });
        learned = true;
      }
    }
    if (learned) {
      // Persist the growing dictionary (best effort - works without Supabase too).
      await setConfig(cacheKey, JSON.stringify(cached));
    }
  }

  return NextResponse.json({
    map: Object.fromEntries(
      texts.filter((t) => cached[t]).map((t) => [t, cached[t]])
    ),
  });
}
