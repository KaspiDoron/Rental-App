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

export async function GET(req: Request) {
  const session = await requireManagement();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const name = new URL(req.url).searchParams.get("name") ?? "";
  const value = (await getConfig(name))?.trim();
  if (!value && !name.startsWith("WHATSAPP")) {
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
