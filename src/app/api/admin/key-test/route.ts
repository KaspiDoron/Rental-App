import { NextResponse } from "next/server";
import { requireManagement } from "@/lib/session";
import { getConfig } from "@/lib/runtime-config";

// Universal "Test API" - fires ONE cheap real request against the service a
// key belongs to and reports the exact outcome. GET ?name=<KEY_NAME>.

type TestResult = { ok: boolean; detail: string };

async function testOpenAICompatible(endpoint: string, token: string, model: string): Promise<TestResult> {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 2 }),
    });
    if (res.ok) return { ok: true, detail: "OK - model responded." };
    const d = await res.json().catch(() => ({}));
    return { ok: false, detail: d?.error?.message ?? `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : "network error" };
  }
}

export async function GET(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const name = new URL(req.url).searchParams.get("name") ?? "";
  const value = (await getConfig(name))?.trim();
  if (!value && !name.startsWith("WHATSAPP")) {
    return NextResponse.json({ ok: false, detail: "No value saved for this key yet." });
  }

  let result: TestResult = { ok: false, detail: "No test available for this key." };

  switch (name) {
    case "GROQ_TOKEN":
      result = await testOpenAICompatible("https://api.groq.com/openai/v1/chat/completions", value!, "llama-3.3-70b-versatile");
      break;
    case "OPENROUTER_TOKEN":
      result = await testOpenAICompatible("https://openrouter.ai/api/v1/chat/completions", value!, "meta-llama/llama-3.1-8b-instruct");
      break;
    case "CEREBRAS_TOKEN":
      result = await testOpenAICompatible("https://api.cerebras.ai/v1/chat/completions", value!, "llama-3.3-70b");
      break;
    case "MISTRAL_TOKEN":
      result = await testOpenAICompatible("https://api.mistral.ai/v1/chat/completions", value!, "mistral-small-latest");
      break;
    case "HUGGINGFACE_TOKEN":
      result = await testOpenAICompatible("https://router.huggingface.co/v1/chat/completions", value!, "meta-llama/Llama-3.1-8B-Instruct");
      break;
    case "GEMINI_TOKEN": {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${value}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "ping" }] }], generationConfig: { maxOutputTokens: 2 } }),
          }
        );
        const d = await res.json().catch(() => ({}));
        result = res.ok ? { ok: true, detail: "OK - Gemini responded." } : { ok: false, detail: d?.error?.message ?? `HTTP ${res.status}` };
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
        detail: `Places(New): ${d.placesNew.detail} | Geocoding: ${d.geocoding.detail}`,
      };
      break;
    }
    case "GOOGLE_OAUTH_CLIENT_ID":
      result = /\.apps\.googleusercontent\.com$/.test(value!)
        ? { ok: true, detail: "Format looks right. Full check happens on a real Google sign-in." }
        : { ok: false, detail: "Should end with .apps.googleusercontent.com" };
      break;
    case "EVOLUTION_API_URL":
    case "EVOLUTION_API_KEY": {
      const [url, key] = await Promise.all([getConfig("EVOLUTION_API_URL"), getConfig("EVOLUTION_API_KEY")]);
      if (!url || !key) {
        result = { ok: false, detail: "Set BOTH the Evolution URL and API key first." };
        break;
      }
      try {
        const res = await fetch(`${url.trim().replace(/\/$/, "")}/instance/fetchInstances`, {
          headers: { apikey: key.trim() },
          cache: "no-store",
        });
        result = res.ok
          ? { ok: true, detail: "OK - Evolution API reachable and the key is accepted." }
          : { ok: false, detail: `Evolution responded ${res.status} - check the URL and AUTHENTICATION_API_KEY.` };
      } catch (e) {
        result = { ok: false, detail: `Could not reach Evolution: ${e instanceof Error ? e.message : "network error"}` };
      }
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
    case "LEMONSQUEEZY_API_KEY":
    case "LEMONSQUEEZY_STORE_ID":
    case "LEMONSQUEEZY_VARIANT_PRO":
    case "LEMONSQUEEZY_VARIANT_ULTRA":
    case "LEMONSQUEEZY_WEBHOOK_SECRET": {
      const [key, store, vp, vu, secret] = await Promise.all([
        getConfig("LEMONSQUEEZY_API_KEY"),
        getConfig("LEMONSQUEEZY_STORE_ID"),
        getConfig("LEMONSQUEEZY_VARIANT_PRO"),
        getConfig("LEMONSQUEEZY_VARIANT_ULTRA"),
        getConfig("LEMONSQUEEZY_WEBHOOK_SECRET"),
      ]);
      if (!key || !store) {
        result = { ok: false, detail: "Set the API key and Store ID first." };
        break;
      }
      try {
        const res = await fetch(`https://api.lemonsqueezy.com/v1/stores/${String(store).trim()}`, {
          headers: { Accept: "application/vnd.api+json", Authorization: `Bearer ${key.trim()}` },
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) {
          result = { ok: false, detail: d?.errors?.[0]?.detail ?? `Lemon Squeezy ${res.status} - wrong API key or store ID.` };
          break;
        }
        const storeName = d?.data?.attributes?.name ?? "store";
        const missing = [
          !vp && "VARIANT_PRO",
          !vu && "VARIANT_ULTRA",
          !secret && "WEBHOOK_SECRET",
        ].filter(Boolean);
        result = {
          ok: missing.length === 0,
          detail:
            `Connected to "${storeName}"` +
            (missing.length ? ` - still missing: ${missing.join(", ")}.` : " - checkout + webhook fully configured. (Test mode until Lemon Squeezy verifies your store.)"),
        };
      } catch (e) {
        result = { ok: false, detail: e instanceof Error ? e.message : "network error" };
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
      result = { ok: true, detail: "Used as the From address once Resend is connected." };
      break;
  }

  return NextResponse.json(result);
}
