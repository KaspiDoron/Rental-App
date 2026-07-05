# WheelDeal - simple setup guide

Plain-English steps. You do not need to touch code. The app already works with
nothing configured (demo mode); each section below switches on a real feature.

---

## 1. Deploy the app (get your live link)

1. Go to **vercel.com** and sign in with GitHub.
2. **Add New -> Project -> Import** the `Rental-App` repo.
3. Branch: `claude/rental-negotiation-app-pc33ux` (or merge it to `main` first).
4. Framework: **Next.js** (auto-detected). Root: `./`. Leave build settings as-is.
5. Click **Deploy**. After ~1 minute you get a live URL like
   `https://rental-app-xxxx.vercel.app`.

That URL is your app. It works immediately in demo mode.

> Want it to feel like an App Store app (no browser bar)? On your phone open the
> link, tap the **Share** icon, then **Add to Home Screen**. It launches
> full-screen with the WheelDeal icon.

---

## 2. Turn on saving of keys (Supabase - do this once)

This lets you paste all other keys inside the app and have them stick.

1. Go to **supabase.com -> New project** (free). Pick any name/password.
2. Open **Project Settings -> API**. Copy these 3 values:
   - **Project URL**
   - **service_role** secret key
   - **anon** public key
3. In Vercel: **Settings -> Environment Variables** and add:
   | Name | Value |
   |---|---|
   | `SUPABASE_URL` | the Project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | the service_role key |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the anon key |
   | `SESSION_SECRET` | a long random string (see below) |
   | `OWNER_EMAIL` | `kaspidoron@gmail.com` (the owner - full control) |
   | `ADMIN_EMAILS` | `kaspidoron@gmail.com` |
4. Make a `SESSION_SECRET`: on a Mac/Linux terminal run `openssl rand -hex 32`
   and paste the result. (Set it once and never change it - it protects your
   saved keys.)
5. In Supabase, open **SQL Editor**, paste the contents of
   `supabase/schema.sql` from this repo, and click **Run**.
6. Back in Vercel, **Redeploy** so the new variables load.

Now sign in to your live app with `kaspidoron@gmail.com` (the owner signs in
with email only - no phone or terms needed), open **Admin -> Keys**, and you'll
see a green "Persistence is on" banner. Anything you paste here is saved
securely.

---

## 3. Turn on the real map data (Google Maps - highly recommended)

This switches the app from demo vendors to REAL rental places, precise
addresses, and real Google reviews.

1. Go to **console.cloud.google.com** -> create a project (free).
2. Open **APIs & Services -> Library** and enable these 3 APIs:
   - **Places API**
   - **Geocoding API**
   - (optional) **Maps JavaScript API**
3. Open **APIs & Services -> Credentials -> Create credentials -> API key**.
   Copy the key.
4. Google asks for a billing card, but gives a large free monthly usage credit -
   normal app usage stays free.
5. In your app: **Admin -> Keys -> Google Maps API Key** -> paste -> Apply.

Done - searches now return real rental businesses near the hotel, with photos,
open-now status, phone-based WhatsApp links and live Google reviews.

## 3b. Turn on "Continue with Google" sign-in

1. In the same Google Cloud project: **APIs & Services -> OAuth consent
   screen** -> External -> fill the 3 required fields -> Save.
2. **Credentials -> Create credentials -> OAuth client ID -> Web application**.
3. Under **Authorized JavaScript origins** add your live URL
   (e.g. `https://rental-app-xxxx.vercel.app`).
4. Copy the **Client ID** (ends with `.apps.googleusercontent.com`).
5. In your app: **Admin -> Keys -> Google OAuth Client ID** -> paste -> Apply.

The "Continue with Google" button now appears on the sign-in page.

---

## 4. Turn on the AI agents

You can paste these in **Admin -> Keys** (recommended) or add them in Vercel.

- `GROQ_TOKEN`, `GEMINI_TOKEN`, `OPENROUTER_TOKEN`, `CEREBRAS_TOKEN` - your AI
  gateway keys (use fresh ones; rotate any that were shared in chat).
- `AI_PROVIDER` - which to prefer, e.g. `groq`.

Without these the app still runs using built-in smart fallbacks.

---

## 5. Turn on WhatsApp (official Meta Cloud API)

This is optional. Without it, the app opens normal `wa.me` chat links instead.

1. Go to **developers.facebook.com -> My Apps -> Create App -> Business**.
2. Add the **WhatsApp** product. In the WhatsApp setup page you'll get:
   - a **Phone number ID**
   - a **temporary access token** (later create a permanent one)
3. In your app, **Admin -> Keys**, paste:
   - `WHATSAPP_PHONE_NUMBER_ID`
   - `WHATSAPP_ACCESS_TOKEN`
   - `WHATSAPP_VERIFY_TOKEN` - make up any phrase, e.g. `wheeldeal-verify-9f2`.
4. Set up the webhook so vendor replies come back:
   - In Meta's WhatsApp **Configuration -> Webhooks**, set **Callback URL** to
     `https://YOUR-APP-URL/api/webhooks/whatsapp`
   - **Verify token**: the exact same phrase you used for `WHATSAPP_VERIFY_TOKEN`.
   - Click **Verify and save**, then **Subscribe** to `messages`.
5. Only message vendors who have opted in. Agents identify themselves as
   automated assistants (this keeps you compliant and avoids bans).

---

## 6. Turn on feedback emails (Resend)

So real bug reports from users land in your inbox (spam is filtered out by AI).

1. Go to **resend.com** (free), create an API key.
2. In **Admin -> Keys**, paste:
   - `RESEND_API_KEY`
   - `FEEDBACK_FROM_EMAIL` - e.g. `WheelDeal <feedback@yourdomain.com>` (or leave
     blank to use Resend's test sender while trying it out).

Users tap the chat button in the bottom bar, pick a category, describe the issue
(optionally let AI write it), attach up to 5 screenshots, and submit. Only
genuine bugs get emailed to `ADMIN_EMAILS`; everything is also logged in Supabase.

---

## 7. Turn on payments (Stripe - preview for now)

Visible only to management (Admin -> Billing).

1. Go to **stripe.com**, get your **Secret key** (test mode is fine to start).
2. In **Admin -> Keys**, paste `STRIPE_SECRET_KEY`.
3. Open **Admin -> Billing** and click **Subscribe with Stripe** on a plan - it
   opens a real Stripe Checkout page. (Subscription management is a later pass.)

---

## Quick reference: where each key goes

- **Vercel env vars (once):** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SESSION_SECRET`, `OWNER_EMAIL`,
  `ADMIN_EMAILS`.
- **Admin -> Keys (in-app, any time):** `GOOGLE_MAPS_API_KEY`,
  `GOOGLE_OAUTH_CLIENT_ID`, all `GROQ/GEMINI/OPENROUTER/CEREBRAS` tokens,
  `AI_PROVIDER`, all `WHATSAPP_*`, `RESEND_API_KEY`, `FEEDBACK_FROM_EMAIL`,
  `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.

Always use freshly rotated keys - never ones that were shared in plain text.

## v4 additions (July 2026)

- Payments: Lemon Squeezy is now the primary provider (works for individuals
  in Israel; pays out via PayPal or bank wire). Create a store at
  lemonsqueezy.com, add two subscription products (Pro / Ultra, billed every
  3 months), then paste LEMONSQUEEZY_API_KEY, LEMONSQUEEZY_STORE_ID,
  LEMONSQUEEZY_VARIANT_PRO, LEMONSQUEEZY_VARIANT_ULTRA and
  LEMONSQUEEZY_WEBHOOK_SECRET in Admin -> Keys. Webhook URL:
  https://<your-domain>/api/webhooks/lemonsqueezy (event: order_created +
  subscription events).
- Personal WhatsApp: deploy Evolution API (self-hosted, free - see the
  step-by-step in the project chat/README), then paste EVOLUTION_API_URL and
  EVOLUTION_API_KEY in Admin -> Keys. Users connect their own number from
  Profile -> Your WhatsApp (QR scan). Strict anti-ban rate limits are
  enforced (15/hour, 60/day, 20s gap).
- Diagnostics: Admin -> Keys -> "Test Supabase" and "Test Google key" fire
  real requests and print the exact error + fix.
- Feedback: readable with zero setup in Admin -> Feedback (Supabase-backed).
  Resend email delivery stays optional.
- AdSense: set ADSENSE_CLIENT (ca-pub-...); free-tier pages show labelled ad
  slots (placeholder until Google approves the site). Paid plans are ad-free.

## v9: Multi-host WhatsApp pool (100% free, resilient)

Free hosts (Render/Koyeb/etc.) sleep and restart. To keep WhatsApp reliable on
free tiers, run SEVERAL Evolution servers that ALL point at the SAME Supabase
database, then list them in Admin -> Keys -> EVOLUTION_HOSTS (one "url|key" per
line). Because the Baileys credentials live in the shared database, ANY host can
resume a user's session - so if one host is asleep, the app fails the user over
to a healthy host with NO re-linking.

1. Deploy Evolution API v2 on 2-3 free hosts (see below). Give each the SAME
   env: DATABASE_ENABLED=true, DATABASE_PROVIDER=postgresql,
   DATABASE_CONNECTION_URI=<your Supabase Postgres URI>,
   DATABASE_SAVE_DATA_INSTANCE=true, DATABASE_SAVE_DATA_NEW_MESSAGE=true,
   DATABASE_SAVE_DATA_CHATS=true, CACHE_LOCAL_ENABLED=true,
   CACHE_REDIS_ENABLED=false, and a shared AUTHENTICATION_API_KEY.
2. In Admin -> Keys set EVOLUTION_HOSTS, e.g.:
     https://wd-wa-1.onrender.com|MYKEY
     https://wd-wa-2.koyeb.app|MYKEY
     https://wd-wa-3.fly.dev|MYKEY
   (Leave the single EVOLUTION_API_URL/KEY empty when using the pool.)
3. Keep-awake: point cron-job.org (and a second free cron pinger such as
   uptimerobot.com or a second cron-job.org account) at
   https://YOUR-APP.vercel.app/api/wa/ping every 5 minutes. That endpoint pings
   EVERY host for you and returns a tiny response.

Free hosts that run Evolution well (all have generous free tiers):
- Render (free web service) - sleeps after 15 min; keep-awake required.
- Koyeb (free instance) - one always-on free service.
- Fly.io (free allowance) - set min_machines_running for always-on.
- Northflank / Zeabur / Railway trial - additional shards.

Reality: free tiers are best-effort. The pool + shared-DB failover + keep-awake
makes it dramatically more reliable, but for guaranteed 24/7 a single ~$7/mo
always-on instance is the long-term ideal.
