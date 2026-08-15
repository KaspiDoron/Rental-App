import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { getConfig } from "@/lib/runtime-config";

// Universal "Test API" - fires ONE cheap real request against the service a
// key belongs to and reports the exact outcome. GET ?name=<KEY_NAME>.

type TestResult = { ok: boolean; detail: string };

async function testOpenAICompatible(
  endpoint: string,
  token: string,
  model: string,
  opts?: { reasoningSampler?: boolean }
): Promise<TestResult> {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      // OpenAI's newer models reject max_tokens (want max_completion_tokens) -
      // testing with the classic param would fail a perfectly good key.
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        ...(opts?.reasoningSampler ? { max_completion_tokens: 2 } : { max_tokens: 2 }),
      }),
    });
    if (res.ok) return { ok: true, detail: `OK - ${model} responded.` };
    // Surface the real error body (some providers return non-JSON on 404).
    const raw = await res.text().catch(() => "");
    let msg = raw.slice(0, 180);
    try {
      const j = JSON.parse(raw);
      msg = j?.error?.message ?? j?.message ?? msg;
    } catch {}
    return { ok: false, detail: `HTTP ${res.status}: ${msg || "no body"} (model: ${model})` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : "network error" };
  }
}

// A 1x1 PNG. The smallest artefact that is a legitimate image to every vision
// API, so "is this model id still alive on this key" costs a handful of tokens
// and no meaningful money. Content does not matter - the STATUS CODE does.
const PIXEL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * A ~0.25s silent 16kHz mono WAV, built here rather than checked in.
 *
 * Whisper accepts it, charges essentially nothing for it, and answers with an
 * empty transcription and HTTP 200 - which is exactly the signal wanted: the
 * key is valid FOR THE AUDIO SKU and the model id still exists. A chat-only
 * test could never say that.
 */
function silentWav(): Uint8Array<ArrayBuffer> {
  const sampleRate = 16_000;
  const samples = Math.round(sampleRate * 0.25);
  const dataBytes = samples * 2; // 16-bit mono
  const raw = new ArrayBuffer(44 + dataBytes);
  const bytes = new Uint8Array(raw);
  const view = new DataView(raw);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) bytes[offset + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  return bytes; // the samples stay zeroed - silence
}

/** Read an error body once and squeeze the most useful sentence out of it. */
async function briefError(res: Response): Promise<string> {
  const raw = await res.text().catch(() => "");
  try {
    const j = JSON.parse(raw);
    return String(j?.error?.message ?? j?.message ?? j?.error ?? raw).slice(0, 200);
  } catch {
    return raw.slice(0, 200) || "no body";
  }
}

export async function GET(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const name = new URL(req.url).searchParams.get("name") ?? "";
  const value = (await getConfig(name))?.trim();
  // KEYS WHOSE TEST DOES NOT NEED THE KEY'S OWN VALUE. A blank vision/whisper
  // model id means "use the built-in default", which is the case most worth
  // testing; the WABA block and the Cloud API block are tested as a set; and
  // REDIS_URL is env-only, so refusing to probe it for being "unsaved" would
  // reproduce the exact invisibility this button exists to end.
  const testsWithoutOwnValue =
    name.startsWith("WHATSAPP") ||
    name.startsWith("WABA_") ||
    name === "REDIS_URL" ||
    name === "GROQ_WHISPER_MODEL" ||
    name.endsWith("_VISION_MODEL");
  if (!value && !testsWithoutOwnValue) {
    return NextResponse.json({ ok: false, detail: "No value saved for this key yet." });
  }

  // AI providers: test the EXACT endpoint + model the app will run (respecting
  // any <PROVIDER>_MODEL override), from the single source in lib/ai. This kills
  // the old bug where the test used a different, drifted model id than production
  // (e.g. Cerebras tested llama3.1-8b -> 404 while the app used llama-3.3-70b).
  {
    const { aiProviderTestTarget } = await import("@/lib/ai");
    const target = await aiProviderTestTarget(name);
    if (target) {
      if (target.gemini) {
        try {
          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${target.model}:generateContent?key=${value}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "ping" }] }], generationConfig: { maxOutputTokens: 2 } }),
            }
          );
          const d = await res.json().catch(() => ({}));
          return NextResponse.json(
            res.ok
              ? { ok: true, detail: `OK - Gemini responded (${target.model}).` }
              : { ok: false, detail: d?.error?.message ?? `HTTP ${res.status} (model: ${target.model})` }
          );
        } catch (e) {
          return NextResponse.json({ ok: false, detail: e instanceof Error ? e.message : "network error" });
        }
      }
      if (target.dialect === "anthropic") {
        // Anthropic's native grammar: x-api-key (not Bearer) + a required
        // version header + top-level max_tokens. Without this branch the test
        // button silently fell through to "No test available for this key."
        try {
          const res = await fetch(target.endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": value!,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: target.model,
              max_tokens: 2,
              messages: [{ role: "user", content: "ping" }],
            }),
          });
          const d = await res.json().catch(() => ({}));
          return NextResponse.json(
            res.ok
              ? { ok: true, detail: `OK - Anthropic responded (${target.model}).` }
              : { ok: false, detail: d?.error?.message ?? `HTTP ${res.status} (model: ${target.model})` }
          );
        } catch (e) {
          return NextResponse.json({ ok: false, detail: e instanceof Error ? e.message : "network error" });
        }
      }
      return NextResponse.json(
        await testOpenAICompatible(target.endpoint, value!, target.model, {
          reasoningSampler: target.sampler === "reasoning",
        })
      );
    }
  }

  let result: TestResult = { ok: false, detail: "No test available for this key." };

  switch (name) {
    // ---- REDIS: the dependency that had no button at all --------------------
    case "REDIS_URL": {
      const { redisDiagnostics } = await import("@/lib/rival-cache");
      const d = await redisDiagnostics();
      result = { ok: d.ok, detail: d.detail };
      break;
    }

    // ---- The SECOND Groq SKU, tested as itself ------------------------------
    case "GROQ_WHISPER_MODEL": {
      const token = (await getConfig("GROQ_TOKEN"))?.trim();
      if (!token) {
        result = { ok: false, detail: "Set GROQ_TOKEN first - the voice-note path uses the same key as Groq chat." };
        break;
      }
      const { whisperModel } = await import("@/lib/graph/transcribe");
      const model = await whisperModel();
      try {
        const fd = new FormData();
        fd.append("file", new Blob([silentWav()], { type: "audio/wav" }), "probe.wav");
        fd.append("model", model);
        fd.append("temperature", "0");
        const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: fd,
        });
        result = res.ok
          ? {
              ok: true,
              detail: `OK - Groq accepted a real transcription request on "${model}". This is the voice-note SKU, tested separately from Groq chat: both can fail independently on the same key.`,
            }
          : {
              ok: false,
              detail: `HTTP ${res.status}: ${await briefError(res)} (model: ${model}). Voice notes from shops will fall back to Gemini audio, which is measurably weaker on heavy accents.`,
            };
      } catch (e) {
        result = { ok: false, detail: e instanceof Error ? e.message : "network error" };
      }
      break;
    }

    // ---- The vision ladder: settable since Wave 2, testable from now on -----
    case "GEMINI_VISION_MODEL":
    case "GROQ_VISION_MODEL":
    case "ANTHROPIC_VISION_MODEL": {
      const { visionProviderTestTarget } = await import("@/lib/ai");
      const target = await visionProviderTestTarget(name);
      if (!target) {
        result = { ok: false, detail: "No vision provider is mapped to this key." };
        break;
      }
      if (!target.token) {
        result = { ok: false, detail: `Set ${target.tokenKey} first - the vision ladder uses the same key as this provider's text model.` };
        break;
      }
      const note = value
        ? `override "${value}"`
        : `built-in default "${target.model}" (no override set)`;
      try {
        let res: Response;
        if (target.provider === "gemini") {
          res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${target.model}:generateContent?key=${target.token}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [
                  {
                    role: "user",
                    parts: [
                      { text: "reply with the single word: ok" },
                      { inline_data: { mime_type: "image/png", data: PIXEL_PNG_B64 } },
                    ],
                  },
                ],
                generationConfig: { maxOutputTokens: 4 },
              }),
            }
          );
        } else if (target.provider === "groq") {
          res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${target.token}` },
            body: JSON.stringify({
              model: target.model,
              max_tokens: 4,
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "text", text: "reply with the single word: ok" },
                    { type: "image_url", image_url: { url: `data:image/png;base64,${PIXEL_PNG_B64}` } },
                  ],
                },
              ],
            }),
          });
        } else {
          res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": target.token,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: target.model,
              max_tokens: 4,
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "text", text: "reply with the single word: ok" },
                    {
                      type: "image",
                      source: { type: "base64", media_type: "image/png", data: PIXEL_PNG_B64 },
                    },
                  ],
                },
              ],
            }),
          });
        }
        result = res.ok
          ? { ok: true, detail: `OK - ${target.provider} read a real image with the ${note}.` }
          : {
              ok: false,
              detail: `HTTP ${res.status}: ${await briefError(res)} (model: ${target.model}). A retired multimodal id is the usual cause - paste a current one here, no redeploy needed.`,
            };
      } catch (e) {
        result = { ok: false, detail: e instanceof Error ? e.message : "network error" };
      }
      break;
    }

    case "GOOGLE_MAPS_API_KEY": {
      const { runMapsDiagnostics } = await import("@/lib/google");
      const d = await runMapsDiagnostics();
      result = {
        ok: d.placesNew.ok || d.placesLegacy.ok,
        detail:
          `Places(New): ${d.placesNew.detail} | Geocoding: ${d.geocoding.detail}` +
          // The keyless fallback is a production path (it carries geocoding
          // whenever Google is unset, over quota or restricted) and it is the
          // one most likely to be blocked on a datacenter IP - i.e. on any
          // scaled deployment. It is reported here as its own line.
          ` | OpenStreetMap fallback: ${d.nominatim.detail}`,
      };
      break;
    }
    case "GOOGLE_OAUTH_CLIENT_ID":
      result = /\.apps\.googleusercontent\.com$/.test(value!)
        ? { ok: true, detail: "Format looks right. Full check happens on a real Google sign-in." }
        : { ok: false, detail: "Should end with .apps.googleusercontent.com" };
      break;
    case "EVOLUTION_HOSTS":
    case "EVOLUTION_API_URL":
    case "EVOLUTION_API_KEY": {
      // Build the same host list the app uses, then test each one.
      const multi = (await getConfig("EVOLUTION_HOSTS")) ?? "";
      let hosts = multi
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((line) => {
          const [u, k] = line.split("|").map((x) => x?.trim());
          return u && k ? { url: u.replace(/\/$/, ""), key: k } : null;
        })
        .filter((h): h is { url: string; key: string } => h !== null);
      if (hosts.length === 0) {
        const [u, k] = await Promise.all([getConfig("EVOLUTION_API_URL"), getConfig("EVOLUTION_API_KEY")]);
        if (u && k) hosts = [{ url: u.trim().replace(/\/$/, ""), key: k.trim() }];
      }
      if (hosts.length === 0) {
        result = { ok: false, detail: "No hosts configured. Add EVOLUTION_HOSTS (url|key per line) or the single URL+key." };
        break;
      }
      const checks = await Promise.all(
        hosts.map(async (h) => {
          try {
            const res = await fetch(`${h.url}/instance/fetchInstances`, {
              headers: { apikey: h.key },
              cache: "no-store",
            });
            return `${h.url} -> ${res.ok ? "OK" : `HTTP ${res.status}`}`;
          } catch (e) {
            return `${h.url} -> ${e instanceof Error ? e.message : "unreachable"}`;
          }
        })
      );
      const okCount = checks.filter((c) => c.endsWith("OK")).length;
      result = {
        ok: okCount > 0,
        detail: `${okCount}/${hosts.length} host(s) healthy.\n${checks.join("\n")}`,
      };
      break;
    }
    case "RESEND_API_KEY": {
      try {
        const res = await fetch("https://api.resend.com/domains", {
          headers: { Authorization: `Bearer ${value}` },
        });
        result = res.ok
          ? { ok: true, detail: "OK - Resend accepted the key." }
          : { ok: false, detail: `Resend responded ${res.status} - re-copy the key.` };
      } catch (e) {
        result = { ok: false, detail: e instanceof Error ? e.message : "network error" };
      }
      break;
    }
    case "PAYPAL_CLIENT_ID":
    case "PAYPAL_CLIENT_SECRET":
    case "PAYPAL_PLAN_PRO":
    case "PAYPAL_PLAN_ULTRA":
    case "PAYPAL_WEBHOOK_ID":
    case "PAYPAL_ENV": {
      const [id, secret, pp, pu, webhookId, env] = await Promise.all([
        getConfig("PAYPAL_CLIENT_ID"),
        getConfig("PAYPAL_CLIENT_SECRET"),
        getConfig("PAYPAL_PLAN_PRO"),
        getConfig("PAYPAL_PLAN_ULTRA"),
        getConfig("PAYPAL_WEBHOOK_ID"),
        getConfig("PAYPAL_ENV"),
      ]);
      if (!id || !secret) {
        result = { ok: false, detail: "Set the Client ID and Client Secret first." };
        break;
      }
      const base =
        (env ?? "live").trim().toLowerCase() === "sandbox"
          ? "https://api-m.sandbox.paypal.com"
          : "https://api-m.paypal.com";
      try {
        const basic = Buffer.from(`${id.trim()}:${secret.trim()}`).toString("base64");
        const res = await fetch(`${base}/v1/oauth2/token`, {
          method: "POST",
          headers: {
            Authorization: `Basic ${basic}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: "grant_type=client_credentials",
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok || !d.access_token) {
          result = { ok: false, detail: d?.error_description ?? `PayPal ${res.status} - wrong Client ID or Secret (check live vs sandbox).` };
          break;
        }
        // THE WEBHOOK ID WAS ONLY CHECKED FOR PRESENCE.
        //
        // "Fully configured" meant a non-empty string, so a typo, a stale id
        // from a deleted webhook, or a sandbox id pasted into a live account
        // all reported green - and then every real event failed signature
        // verification and no plan was ever granted. The webhook id is THE
        // credential the whole billing grant path depends on; asking PayPal
        // whether it exists is one call.
        let webhookDetail = "";
        if (webhookId) {
          const listed = await fetch(`${base}/v1/notifications/webhooks`, {
            headers: { Authorization: `Bearer ${d.access_token}` },
            cache: "no-store",
          })
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null);
          // AN EMPTY LIST IS A FAILURE, NOT A PASS (wave 4.3). The old
          // `ids.length && !ids.includes(...)` skipped the check entirely
          // when the app had NO webhooks - precisely the broken state this
          // check exists to catch (an id that matches nothing can never
          // verify a signature). An unreadable list is reported as unknown
          // rather than silently waved through.
          const readable = Array.isArray(listed?.webhooks);
          const ids: string[] = readable
            ? listed.webhooks.map((w: { id?: string }) => String(w?.id ?? ""))
            : [];
          if (readable && !ids.includes(String(webhookId).trim())) {
            result = {
              ok: false,
              detail:
                `PAYPAL_WEBHOOK_ID is not a webhook on this PayPal app` +
                ` (${(env ?? "live").trim().toLowerCase() === "sandbox" ? "sandbox" : "live"}).` +
                ` Every event will fail signature verification and no plan will be granted.` +
                (ids.length === 0
                  ? ` The app has NO webhooks at all - open Admin -> Keys -> PayPal webhook doctor and press Connect.`
                  : ids.length === 1
                    ? ` The app's only webhook id is ${ids[0]}.`
                    : ""),
            };
            break;
          }
          webhookDetail = readable
            ? " - webhook id verified with PayPal"
            : " - webhook id COULD NOT be verified (webhook list unreadable)";
        }

        const missing = [
          !pp && "PLAN_PRO",
          !pu && "PLAN_ULTRA",
          !webhookId && "WEBHOOK_ID",
        ].filter(Boolean);
        result = {
          ok: missing.length === 0,
          detail:
            `PayPal credentials valid (${(env ?? "live").trim().toLowerCase() === "sandbox" ? "sandbox" : "live"})` +
            (missing.length
              ? ` - still missing: ${missing.join(", ")}.`
              : ` - checkout + webhook fully configured${webhookDetail}.`),
        };
      } catch (e) {
        result = { ok: false, detail: e instanceof Error ? e.message : "network error" };
      }
      break;
    }
    // ---- THE WHOLE WABA BLOCK, WHICH HAD NO TEST COVERAGE AT ALL ------------
    //
    // Eighteen keys governing a RENTED business account whose quality rating
    // cannot be bought back, and not one of them could be checked before the
    // first live send. Tested as a SET, because that is how they fail: a base
    // URL without a sender id, a sender id belonging to a different portfolio,
    // a tier string the owner typed months ago that no longer matches Meta.
    case "WABA_ENABLED":
    case "WABA_DRY_RUN":
    case "WABA_PROVIDER":
    case "WABA_BASE_URL":
    case "WABA_API_KEY":
    case "WABA_SENDER_ID":
    case "WABA_WEBHOOK_SECRET":
    case "WABA_TEMPLATE_FIRST_CONTACT":
    case "WABA_TEMPLATE_REENGAGE":
    case "WABA_LINK_BASE":
    case "WABA_QUALITY_RATING":
    case "WABA_TIER_UNIQUE_PER_DAY":
    case "WABA_TEMPLATE_COST_USD":
    case "WABA_KILL":
    case "WABA_DAILY_SPEND_CEILING_USD":
    case "WABA_AGENCY_COOLDOWN_HOURS":
    case "WABA_HOLD_TIMEOUT_MINUTES":
    case "WABA_EXPECTATION_TTL_HOURS": {
      const { wabaConfig, wabaBlockReason } = await import("@/lib/waba/config");
      const c = await wabaConfig();
      const blocked = wabaBlockReason(c);
      const lines: string[] = [];
      lines.push(
        `Flag: ${c.enabled ? "ENABLED" : "off"} · dry run: ${c.dryRun ? "ON (nothing is sent)" : "OFF - real sends"} · provider: ${c.provider}`
      );
      if (blocked) lines.push(`Blocked by: ${blocked}.`);

      // SHAPE first - a malformed base URL or a non-numeric sender id can be
      // caught without touching the network, and those are the common typos.
      const shapeProblems: string[] = [];
      if (c.baseUrl) {
        try {
          const u = new URL(c.baseUrl);
          if (u.protocol !== "https:") shapeProblems.push("WABA_BASE_URL must be https");
          if (/\/$/.test(c.baseUrl)) shapeProblems.push("WABA_BASE_URL should have no trailing slash");
        } catch {
          shapeProblems.push("WABA_BASE_URL is not a valid URL");
        }
      } else shapeProblems.push("WABA_BASE_URL is empty");
      if (!c.senderId) shapeProblems.push("WABA_SENDER_ID is empty");
      if (!c.apiKey) shapeProblems.push("WABA_API_KEY is empty");
      if (c.linkBase) {
        try {
          const u = new URL(c.linkBase);
          if (u.protocol !== "https:") shapeProblems.push("WABA_LINK_BASE must be https (it is an approved button target)");
        } catch {
          shapeProblems.push("WABA_LINK_BASE is not a valid URL");
        }
      }
      if (shapeProblems.length) {
        result = { ok: false, detail: [...lines, `Shape: ${shapeProblems.join("; ")}.`].join("\n") };
        break;
      }
      lines.push("Shape: base URL, sender id, key and link base all look right.");

      // REACHABILITY. On the Meta dialect the phone-number node is a real
      // read-only GET, so this is a genuine credential check that sends
      // nothing and spends no quality rating. It also returns the LIVE tier
      // and quality rating, which is the answer to the other problem here:
      // WABA_TIER_UNIQUE_PER_DAY and WABA_QUALITY_RATING are owner-typed
      // STRINGS that nothing ever reconciled with Meta, so the documented
      // ceiling could drift from the real one without a trace.
      try {
        const url =
          c.provider === "meta"
            ? `${c.baseUrl}/${c.senderId}?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier`
            : `${c.baseUrl}/${c.senderId}`;
        const headers: Record<string, string> =
          c.provider === "meta"
            ? { Authorization: `Bearer ${c.apiKey}` }
            : { Authorization: `App ${c.apiKey}` };
        const res = await fetch(url, { headers, cache: "no-store" });
        if (!res.ok) {
          result = {
            ok: false,
            detail: [
              ...lines,
              `Reachability: HTTP ${res.status} from ${c.provider === "meta" ? "Meta" : "the reseller"} - ${await briefError(res)}`,
              c.provider === "reseller"
                ? "Resellers vary: a 404 here can mean the endpoint simply is not a GET. Treat this as reachability only, not as proof the key is wrong."
                : "The key or the sender id does not belong to this portfolio.",
            ].join("\n"),
          };
          break;
        }
        const d = (await res.json().catch(() => ({}))) as {
          display_phone_number?: string;
          verified_name?: string;
          quality_rating?: string;
          messaging_limit_tier?: string;
        };
        lines.push(
          `Reachability: OK${d.display_phone_number ? ` - ${d.display_phone_number}${d.verified_name ? ` (${d.verified_name})` : ""}` : ""}.`
        );
        // DRIFT, stated as drift rather than left for the reader to spot.
        const storedQuality = ((await getConfig("WABA_QUALITY_RATING")) ?? "").trim().toUpperCase();
        const liveQuality = (d.quality_rating ?? "").trim().toUpperCase();
        if (liveQuality) {
          lines.push(
            storedQuality && storedQuality !== liveQuality
              ? `DRIFT: WABA_QUALITY_RATING says ${storedQuality}, Meta says ${liveQuality}. The vault value is what the governor reads - correct it.`
              : `Quality rating (live): ${liveQuality}.`
          );
        }
        const storedTier = ((await getConfig("WABA_TIER_UNIQUE_PER_DAY")) ?? "").trim();
        if (d.messaging_limit_tier) {
          const liveN = /TIER_(\d+)K?/i.exec(d.messaging_limit_tier);
          const liveUnique = liveN ? Number(liveN[1]) * (/K/i.test(d.messaging_limit_tier) ? 1000 : 1) : null;
          lines.push(
            liveUnique !== null && storedTier && Number(storedTier) !== liveUnique
              ? `DRIFT: WABA_TIER_UNIQUE_PER_DAY says ${storedTier}, Meta reports ${d.messaging_limit_tier} (${liveUnique}/24h). The spend estimate and the governor use the vault number.`
              : `Messaging tier (live): ${d.messaging_limit_tier}.`
          );
        } else if (storedTier) {
          lines.push(
            `Messaging tier: ${storedTier}/24h from the vault - the provider did not report one, so this number is owner-maintained and can drift.`
          );
        }
        result = { ok: true, detail: lines.join("\n") };
      } catch (e) {
        result = {
          ok: false,
          detail: [...lines, `Reachability: ${e instanceof Error ? e.message : "network error"}`].join("\n"),
        };
      }
      break;
    }

    case "WHATSAPP_ACCESS_TOKEN":
    case "WHATSAPP_PHONE_NUMBER_ID":
    case "WHATSAPP_VERIFY_TOKEN": {
      const [token, phoneId] = await Promise.all([
        getConfig("WHATSAPP_ACCESS_TOKEN"),
        getConfig("WHATSAPP_PHONE_NUMBER_ID"),
      ]);
      if (!token || !phoneId) {
        result = {
          ok: false,
          detail:
            "Optional official Meta path - needs a verified business. Most owners should use the Evolution connector instead and leave these empty.",
        };
        break;
      }
      try {
        const res = await fetch(`https://graph.facebook.com/v20.0/${phoneId.trim()}?fields=display_phone_number`, {
          headers: { Authorization: `Bearer ${token.trim()}` },
        });
        const d = await res.json().catch(() => ({}));
        result = res.ok
          ? { ok: true, detail: `OK - Cloud API number: ${d.display_phone_number ?? phoneId}` }
          : { ok: false, detail: d?.error?.message ?? `Graph API ${res.status}` };
      } catch (e) {
        result = { ok: false, detail: e instanceof Error ? e.message : "network error" };
      }
      break;
    }
    case "ADSENSE_CLIENT":
      result = /^ca-pub-\d{10,}$/.test(value!)
        ? { ok: true, detail: "Format OK. Approval status lives in your AdSense dashboard (Sites); ads appear only after Google approves the site. Our /ads.txt is served automatically." }
        : { ok: false, detail: "Should look like ca-pub-1234567890123456" };
      break;
    case "AI_PROVIDER":
      result = { ok: true, detail: `Preferred provider set to "${value}". Use the AI providers panel to switch.` };
      break;
    case "FEEDBACK_FROM_EMAIL":
    case "BREVO_SENDER":
      result = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value!)
        ? { ok: true, detail: "Valid email format. It becomes the visible From/sender address." }
        : { ok: false, detail: "Enter a valid email address (e.g. hello@yourdomain.com)." };
      break;
    case "BREVO_API_KEY": {
      try {
        const res = await fetch("https://api.brevo.com/v3/account", {
          headers: { "api-key": value!, Accept: "application/json" },
        });
        const d = await res.json().catch(() => ({}));
        result = res.ok
          ? { ok: true, detail: `OK - Brevo account: ${d?.email ?? "connected"}.` }
          : { ok: false, detail: d?.message ?? `Brevo responded ${res.status} - re-copy the key.` };
      } catch (e) {
        result = { ok: false, detail: e instanceof Error ? e.message : "network error" };
      }
      break;
    }
    case "GMAIL_USER":
      result = /^[^@\s]+@gmail\.com$/i.test(value!)
        ? { ok: true, detail: "Valid Gmail address. Pair it with a 16-char App Password (not your login password)." }
        : { ok: false, detail: "Enter your full Gmail address, e.g. you@gmail.com." };
      break;
    case "GMAIL_APP_PASSWORD": {
      const gu = await getConfig("GMAIL_USER");
      const clean = value!.replace(/\s+/g, "");
      if (clean.length !== 16) {
        result = { ok: false, detail: "A Google App Password is 16 characters (spaces are ignored). Generate one at myaccount.google.com/apppasswords." };
        break;
      }
      result = gu
        ? { ok: true, detail: "Format OK (16 chars). Live SMTP is verified on the first email sent." }
        : { ok: false, detail: "Set GMAIL_USER (your Gmail address) as well." };
      break;
    }
    case "EVOLUTION_PROXY": {
      // Validate the proxy URL shape (socks5/http). Live SOCKS cannot be probed
      // from a fetch, but a malformed URL is the common mistake we can catch.
      try {
        const u = new URL(value!);
        const okScheme = /^(socks5?|https?):$/.test(u.protocol);
        result = okScheme && u.hostname && u.port
          ? { ok: true, detail: `Format OK - ${u.protocol}//${u.hostname}:${u.port}. Evolution injects it per instance; a bad proxy shows as a failed connect on link.` }
          : { ok: false, detail: "Use scheme://user:pass@host:port (e.g. socks5://user:pass@1.2.3.4:1080)." };
      } catch {
        result = { ok: false, detail: "Not a valid URL. Use scheme://user:pass@host:port." };
      }
      break;
    }
    case "EVOLUTION_PROXY_POOL": {
      const lines = value!.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
      const bad: string[] = [];
      for (const l of lines) {
        try {
          const u = new URL(l);
          if (!/^(socks5?|https?):$/.test(u.protocol) || !u.hostname || !u.port) bad.push(l);
        } catch {
          bad.push(l);
        }
      }
      result = lines.length === 0
        ? { ok: false, detail: "Add one proxy URL per line (scheme://user:pass@host:port)." }
        : bad.length === 0
        ? { ok: true, detail: `OK - ${lines.length} proxy(ies). Each user is pinned to one for a stable residential IP.` }
        : { ok: false, detail: `${bad.length} malformed line(s): ${bad.slice(0, 2).join(" ; ")}` };
      break;
    }
    case "EVOLUTION_MAX_PER_HOST": {
      const n = Number(value);
      result = Number.isInteger(n) && n > 0
        ? { ok: true, detail: `OK - up to ${n} WhatsApp users per host before failover to the next.` }
        : { ok: false, detail: "Enter a positive whole number (e.g. 40)." };
      break;
    }
    case "TWITTER_HANDLE":
      result = /^@?[A-Za-z0-9_]{1,15}$/.test(value!)
        ? { ok: true, detail: `Handle format OK (${value!.startsWith("@") ? value : "@" + value}).` }
        : { ok: false, detail: "An X handle is 1-15 letters/numbers/underscores, e.g. @wheeldeal." };
      break;
    case "NEXT_PUBLIC_SUPABASE_URL":
    case "SUPABASE_SERVICE_ROLE_KEY":
    case "SESSION_SECRET": {
      if (name === "SESSION_SECRET") {
        result = value && value.length >= 16
          ? { ok: true, detail: "Set and long enough to sign sessions securely." }
          : { ok: false, detail: "Set a long random secret (>= 16 chars) in the environment." };
        break;
      }
      const { supabaseDiagnostics } = await import("@/lib/runtime-config");
      const d = await supabaseDiagnostics();
      result = { ok: d.reachable && d.appConfigOk, detail: d.detail };
      break;
    }
  }

  return NextResponse.json(result);
}

// maxDuration: lift the request-timeout ceiling for slow AI/WhatsApp upstreams.
export const maxDuration = 60;
