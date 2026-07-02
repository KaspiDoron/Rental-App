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
   | `ADMIN_EMAILS` | `kaspidoron@gmail.com,doron@pristivo.com` |
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
