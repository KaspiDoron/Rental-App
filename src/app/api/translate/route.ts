import { NextResponse } from "next/server";
import { chat, aiEnabled } from "@/lib/ai";
import { getConfig, setConfig } from "@/lib/runtime-config";
import { getSession } from "@/lib/session";

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
): Promise<(string | null)[] | null> {
  // The do-not-translate list is imported so the prompt and the VALIDATOR name
  // the same words - "Will" chief among them, the assistant's own name and a
  // high-frequency English auxiliary that a context-free localiser translates
  // every time.
  const { DO_NOT_TRANSLATE } = await import("@/lib/i18n-validate");
  const system =
    `You are a senior product localiser translating UI strings for "WheelDeal", a mobile app where AI agents bargain for vehicle rentals, from English to ${langName}. ` +
    "Rules: (1) translate MEANING, not word-by-word - use the natural phrasing a native mobile app in that language would use; " +
    "(2) match register: buttons/labels stay short and imperative, sentences stay friendly and simple; " +
    `(3) NEVER translate these brand/product words, keep them verbatim: ${DO_NOT_TRANSLATE.join(", ")}. "Will" is the name of the assistant, never the English verb; ` +
    "(4) keep emoji, numbers, currency symbols, punctuation and every {placeholder} token exactly as written, same spelling, same count; " +
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
      const { validateTranslation } = await import("@/lib/i18n-validate");
      // Per-element validation, NOT String() coercion. A rejected element
      // becomes null so the caller keeps the English source for that one string
      // - a wrong translation is worse than an untranslated one, because the
      // wrong one is invisible until a user complains and unfixable while it
      // sits in the shared cache. null (JSON or coerced) is the first thing
      // this rejects, so the "null" button-label bug cannot recur.
      return parsed.t.map((cand, i) => {
        const v = validateTranslation(texts[i], cand);
        return v.ok ? (cand as string).trim() : null;
      });
    }
  } catch {}
  return null;
}

export async function POST(req: Request) {
  // Signed-in only + a generous daily cap: the cache means real users almost
  // never hit the LLM (each string is translated once ever), but this stops
  // an anonymous caller from turning the endpoint into an open LLM faucet and
  // poisoning the durable translation cache.
  const session = await getSession();
  if (!session) return NextResponse.json({ map: {} }, { status: 401 });
  const { checkDailyLimit } = await import("@/lib/usage");
  const gate = await checkDailyLimit("translate", session.email, "LIMIT_TRANSLATE_PER_DAY");
  if (!gate.allowed) return NextResponse.json({ map: {} }, { status: 429 });

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
      // LAST WRITE WINS, AND EVERY OTHER WRITE IS LOST.
      //
      // The client fires its batches in parallel (i18n.tsx: one Promise.all over
      // 42-string chunks), and every one of them lands here. Each read the SAME
      // snapshot of the dictionary at the top of this handler, spent seconds in
      // the LLM, then wrote the whole object back - so N concurrent batches kept
      // only the translations of whichever finished last. The rest were paid for
      // and discarded, and the next user in that language paid for them again,
      // round after round, until the dictionary happened to converge.
      //
      // Re-read and merge immediately before the write. The window shrinks from
      // "the length of an LLM call" to "the length of one Supabase round trip",
      // and OURS wins on conflict for the keys we actually translated - a key
      // another batch wrote in the meantime is kept, not clobbered.
      let latest: Record<string, string> = {};
      try {
        latest = JSON.parse((await getConfig(cacheKey)) ?? "{}");
      } catch {
        /* an unreadable cache is an empty one; we still have our own work */
      }
      await setConfig(cacheKey, JSON.stringify({ ...latest, ...cached }));
    }
    // Count this LLM sweep against the daily cap (a cache hit costs nothing).
    const { recordApi } = await import("@/lib/usage");
    await recordApi("translate", 1, session.email);
  }

  return NextResponse.json({
    map: Object.fromEntries(
      texts.filter((t) => cached[t]).map((t) => [t, cached[t]])
    ),
  });
}

// maxDuration: lift the request-timeout ceiling for slow AI/WhatsApp upstreams.
export const maxDuration = 60;
