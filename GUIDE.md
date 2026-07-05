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

## v10: Multi-host WhatsApp pool - 8 free servers, no user left behind

WhatsApp is the heart of WheelDeal. A single free host sleeps after ~15 min and
drops the connection - bad. The fix is a POOL: run the SAME Evolution API server
on 8+ free services, all pointed at the SAME Supabase Postgres database. Because
every WhatsApp (Baileys) credential lives in that shared database, ANY host can
resume ANY user's session. If one host is asleep or slow, the app instantly
fails the user over to a healthy host - with NO re-scanning, NO re-linking.

### How the app spreads users (built in - nothing to configure)

- On every send/connect the app health-checks all hosts in parallel (cached 15s).
- Each user "sticks" to one host (saved in `wa_sessions.host_url`) so their
  session stays warm; if that host is down, they migrate to the least-loaded
  healthy host automatically.
- A per-host cap (Admin -> Keys -> `EVOLUTION_MAX_PER_HOST`, default 40) stops
  any one free server from being overloaded - new users land on emptier hosts.
- Owner page -> Keys -> "WhatsApp host pool" shows a live green/red dot and the
  user count for every host. Tap "Test API" on `EVOLUTION_HOSTS` to ping them all.

### The ONE shared config every host needs (identical on all 8)

Set these environment variables the SAME on every host. The shared database +
shared API key is what makes failover seamless:

```
AUTHENTICATION_API_KEY   = <pick one long random string, SAME on all hosts>
DATABASE_ENABLED         = true
DATABASE_PROVIDER        = postgresql
DATABASE_CONNECTION_URI  = <your Supabase Postgres "Connection string" URI>
DATABASE_SAVE_DATA_INSTANCE     = true
DATABASE_SAVE_DATA_NEW_MESSAGE  = true
DATABASE_SAVE_DATA_MESSAGE_UPDATE = true
DATABASE_SAVE_DATA_CONTACTS     = true
DATABASE_SAVE_DATA_CHATS        = true
CACHE_LOCAL_ENABLED      = true
CACHE_REDIS_ENABLED      = false
CONFIG_SESSION_PHONE_CLIENT = WheelDeal
CONFIG_SESSION_PHONE_NAME   = Chrome
```

Docker image for every host: `atendai/evolution-api:v2.1.1` (newest stable v2 is
`:v2.2.3`), internal port `8080`. Enter it WITHOUT a `docker.io/` prefix - Render
(and some others) treat `docker.io/...` as a private registry and error with "No
public image found". Just type `atendai/evolution-api:v2.1.1`.

Where to get `DATABASE_CONNECTION_URI`: Supabase -> Project Settings ->
Database -> "Connection string" -> URI -> the **Session pooler** (port 5432).
That is the right one for Evolution (it keeps a long-lived connection). It looks
like:
`postgresql://postgres.<ref>:[YOUR-PASSWORD]@aws-1-<region>.pooler.supabase.com:5432/postgres`
Replace `[YOUR-PASSWORD]` with your Supabase database password (URL-encode any
special characters, e.g. `@` -> `%40`). No `?pgbouncer=true` needed on 5432 -
that flag is only for the 6543 transaction port. Paste the SAME URI on every host.

### Deploy on 8 free services (pick any, do 3-8 of them)

Each recipe ends with a public URL. Add every one to the pool as `url|key`.

**1) Render (render.com) - easiest.**
   a. New -> Web Service -> "Deploy an existing image".
   b. Image URL: `atendai/evolution-api:v2.1.1` (NO `docker.io/` prefix, or
      Render says "No public image found"). Instance: Free.
   c. Advanced -> add ALL the env vars above. Set `PORT=8080`.
   d. Create. Copy the `https://xxx.onrender.com` URL. (Sleeps at 15 min -
      the keep-awake cron below wakes it; the pool covers the wake gap.)

**2) Koyeb (koyeb.com) - one always-on free instance.**
   a. Create Service -> Docker -> image `atendai/evolution-api:v2.1.1`.
   b. Instance: Free (Nano). Region: pick nearest.
   c. Ports: expose `8080` (HTTP). Add all env vars. Deploy.
   d. Copy the `https://xxx.koyeb.app` URL. Free instance stays warm.

**3) Fly.io (fly.io) - free allowance, can be always-on.**
   a. Install flyctl, `fly launch --image atendai/evolution-api:v2.1.1
      --no-deploy`.
   b. In `fly.toml` set `internal_port = 8080` and
      `[http_service] min_machines_running = 1` (keeps it awake).
   c. `fly secrets set AUTHENTICATION_API_KEY=... DATABASE_CONNECTION_URI=...`
      (and the rest). `fly deploy`.
   d. URL is `https://YOURAPP.fly.dev`.

**4) Northflank (northflank.com) - free project.**
   a. New Service -> Deployment -> External image
      `docker.io/atendai/evolution-api:v2.1.1`.
   b. Free plan resources. Networking: add public port `8080` (HTTP).
   c. Add env vars (Northflank has a "Secrets" tab - paste there). Deploy.
   d. Copy the generated `https://xxx.code.run` URL.

**5) Back4App Containers (containers.back4app.com) - free container.**
   a. New App -> "Containers as a Service" -> deploy from a public image.
   b. Image `atendai/evolution-api:v2.1.1`, port `8080`.
   c. Add env vars. Deploy. Copy the `https://xxx.b4a.run` URL.

**6) Zeabur (zeabur.com) - free serverless containers.**
   a. New Project -> Deploy -> "Prebuilt image" ->
      `atendai/evolution-api:v2.1.1`.
   b. Add the env vars in Variables. Networking -> expose port `8080`.
   c. Generate a domain. Copy the `https://xxx.zeabur.app` URL.

**7) Google Cloud Run (cloud.google.com/run) - generous always-free requests.**
   a. Cloud Run -> Deploy container -> Container image URL
      `docker.io/atendai/evolution-api:v2.1.1`.
   b. Allow unauthenticated invocations. Container port `8080`.
   c. Variables & Secrets -> add all env vars. Set Min instances = 0 (free)
      or 1 (warmer, still cheap). Deploy. Copy the `https://xxx.run.app` URL.

**8) Oracle Cloud - Always Free VM (the truly 24/7 one).**
   a. Create an "Always Free" Ampere ARM VM (Ubuntu). Open port `8080` in the
      security list.
   b. `sudo apt install docker.io -y`, then
      `sudo docker run -d --restart always -p 8080:8080 --env-file evo.env
      atendai/evolution-api:v2.1.1` (put the env vars in `evo.env`).
   c. Point a free domain / use the public IP as `http://IP:8080`. This one
      never sleeps - make it your anchor host.

Bonus interchangeable options: Okteto, Leapcell, Railway trial, Sevalla - same
recipe (public image, port 8080, shared env). Add as many as you like.

### Wire the pool into WheelDeal

1. Owner page -> Keys -> `EVOLUTION_HOSTS`. Paste ONE `url|apikey` per line
   (the box is a multi-line editor):

   ```
   https://wd-wa-1.onrender.com|MYSHAREDKEY
   https://wd-wa-2.koyeb.app|MYSHAREDKEY
   https://wd-wa-3.fly.dev|MYSHAREDKEY
   https://wd-wa-4.code.run|MYSHAREDKEY
   https://wd-wa-5.b4a.run|MYSHAREDKEY
   https://wd-wa-6.zeabur.app|MYSHAREDKEY
   https://wd-wa-7.run.app|MYSHAREDKEY
   http://ORACLE-IP:8080|MYSHAREDKEY
   ```
   Leave single-host `EVOLUTION_API_URL`/`EVOLUTION_API_KEY` empty when using
   the pool. Tap "Apply pool", then "Test API" to confirm `8/8 host(s) healthy`.

2. (Optional) `EVOLUTION_MAX_PER_HOST` - users per host before spilling to the
   next. 40 is a safe free-tier number; raise it if your hosts are beefier.

3. Keep-awake (covers the sleepy hosts): create a free cron at cron-job.org
   (and a second pinger such as uptimerobot.com for redundancy) hitting
   `https://YOUR-APP.vercel.app/api/wa/ping` every 5 minutes. That ONE endpoint
   pings EVERY host in your pool and returns a tiny response (so cron-job.org
   won't disable it for "output too large").

### Reality check (honest)

The pool + shared-DB failover + keep-awake makes free-tier WhatsApp
dramatically more reliable - a sleeping host no longer strands a user, because
another host resumes their session from the shared database. Include the Oracle
Always Free VM (#8) as your anchor and you effectively have 24/7 coverage at
zero cost. If you ever want a single guaranteed always-on box, any ~$7/mo
instance running the same image and env is a drop-in replacement.
