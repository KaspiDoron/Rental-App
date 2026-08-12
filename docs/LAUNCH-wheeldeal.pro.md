# Launching on wheeldeal.pro

Everything in this file that could be done in code **has been done in code**.
What is left is the set of things that only exist inside somebody else's
console, where a repository has no reach. Each one is a click path.

Nothing here needs a terminal.

---

## 1. What changed in the repo

### The site now has ONE identity

`src/lib/site.ts` is the single owner of the domain. Before this, the brand host
was a bare literal in three unrelated modules - the root layout's metadata base,
the Web Push sender identity, and the geocoder User-Agent - written in three
different shapes, each with its own fallback chain. That is why changing the
domain used to be an audit rather than an edit.

```
SITE_DOMAIN = "wheeldeal.pro"
SITE_ORIGIN = "https://wheeldeal.pro"
```

Resolution order, written once and shared by every consumer:

1. `APP_DOMAIN` in the Key Vault (Admin -> Keys) - **wins, no redeploy needed**
2. `NEXT_PUBLIC_SITE_URL` from the build environment
3. `APP_DOMAIN` from the host environment
4. `SITE_ORIGIN` - the brand default

Consumers converted: `src/app/layout.tsx` (canonical + OpenGraph + Twitter),
`src/lib/push.ts` (VAPID sender identity), `src/lib/google.ts` (Nominatim
User-Agent), plus the two new files below. A test walks every file under `src/`
and fails the build if any module hard-codes a brand domain again.

### New: robots.txt and sitemap.xml

Neither existed. Both are prerequisites for Search Console and for the AdSense
review, and both derive their origin from the resolver above.

- `src/app/robots.ts` - opens the public pages, closes `/api/`, `/admin`,
  `/profile`, `/deals`, `/login`, points at the sitemap, and explicitly welcomes
  `Mediapartners-Google` (the ad crawler is a different bot from Googlebot).
- `src/app/sitemap.ts` - lists `/welcome`, `/pricing`, `/terms`, `/privacy`
  only. A test cross-checks this list against the auth middleware matcher, so a
  gated route can never be advertised to a crawler as content.

### AdSense, wired to be verifiable on a cold anonymous fetch

Google's reviewer is not signed in and has none of our environment variables. So
none of the three proofs of ownership is conditional any more:

| Proof | Where | Was |
|---|---|---|
| Site tag `<script ...adsbygoogle.js?client=ca-pub-4965894186804157>` | `src/app/layout.tsx` `<head>`, unconditional | Rendered only if `ADSENSE_CLIENT` was set |
| `<meta name="google-adsense-account" content="ca-pub-4965894186804157">` | `src/app/layout.tsx`, every page | Did not exist |
| `/ads.txt` | `public/ads.txt`, static | A dynamic route that served `# Set ADSENSE_CLIENT` whenever the env var was missing - a failed verification, not a graceful fallback. Removed. |

The publisher id is a public constant (`ADSENSE_PUBLISHER` in `src/lib/site.ts`)
because it ships in the page source, in `ads.txt` and in every ad request - it
is not a secret. `ADSENSE_CLIENT` in the Key Vault still overrides it if you
ever point the app at a different account.

Also fixed: `AdBanner` was injecting a **second** copy of the AdSense SDK. Two
copies is a policy violation and makes slots fail to fill. The layout loads it
once; the component only claims its slot.

### Fixed while inspecting the webhook: cancellations could not downgrade anyone

The PayPal webhook read `resource.custom_id` for an `email|plan` pair. The
in-app subscribe button creates subscriptions with `plan_id` alone, so
`custom_id` is **empty on every subscription this app has ever created**. The
webhook therefore had a cancellation it could not attribute to an account, and a
traveller who cancelled kept their tier indefinitely.

`src/lib/billing/subscription-link.ts` closes it: at activation we already write
a server-verified audit row naming the signed-in traveller, so the webhook now
resolves the account from **our own evidence** rather than from anything the
client sent. The tier likewise comes from PayPal's `plan_id` matched against
your configured plan ids; a renewal that names no plan is looked up directly
with PayPal rather than being dropped.

---

## 2. External console checklist - only you can do these

### 2.1 Point the domain at the app (do this first)

1. **GCP Console -> Cloud Run -> your web service -> "Manage custom domains"**
   -> Add mapping -> `wheeldeal.pro` (and `www.wheeldeal.pro` if you want it).
2. Copy the DNS records Google shows you into your registrar's DNS panel
   (usually 4 `A` records and 4 `AAAA` records for the apex, or a `CNAME` for
   `www`). Certificate provisioning takes ~15-60 minutes.
3. Confirm `https://wheeldeal.pro` loads the app before doing anything below -
   every remaining step registers that URL somewhere.

### 2.2 Tell the app its own name

**Admin -> Keys -> "Public app domain" (`APP_DOMAIN`)** -> paste
`https://wheeldeal.pro` -> Save. Takes effect within ~30 seconds, no redeploy.

This one field drives share previews, canonical URLs, `robots.txt`, the sitemap,
the geocoder identity and the push sender identity. If you never set it, the
code default is already `https://wheeldeal.pro`, so this is belt-and-braces -
but set it, because it is also what the gateway reads for CORS.

### 2.3 Google Cloud, the rest

- **Cloud Run -> your service -> Variables & Secrets**: set `APP_DOMAIN` to
  `https://wheeldeal.pro` so the gateway's CORS origin locks to the real
  frontend instead of `*`.
- **APIs & Services -> Credentials -> your Maps API key -> Application
  restrictions -> HTTP referrers**: add `https://wheeldeal.pro/*` and
  `https://www.wheeldeal.pro/*`. Leave the old Cloud Run URL in place until you
  have confirmed the new domain works, then remove it.
- **APIs & Services -> Credentials -> OAuth 2.0 Client ID** (the Google sign-in
  button):
  - *Authorized JavaScript origins*: add `https://wheeldeal.pro`
  - *Authorized redirect URIs*: add `https://wheeldeal.pro` (the app uses
    Google Identity Services, which posts back to the origin)
- **OAuth consent screen**: set the *Application home page* to
  `https://wheeldeal.pro`, and the privacy/terms links to
  `https://wheeldeal.pro/privacy` and `https://wheeldeal.pro/terms`.

### 2.4 Supabase

**Supabase -> your project -> Authentication -> URL Configuration**

- *Site URL*: `https://wheeldeal.pro`
- *Redirect URLs*: add `https://wheeldeal.pro/**`

(The app's own sessions are HMAC-signed cookies, not Supabase Auth, so this only
matters if you later enable Supabase-hosted auth flows - but set it now so the
project is consistent.)

Nothing else in Supabase is domain-bound. **No migration is needed for anything
in this change.**

### 2.5 Evolution API / WhatsApp

Nothing to do. The webhook URL is derived from `APP_DOMAIN` and re-registered
automatically - see `canonicalWebhookOrigin` in `src/lib/evolution.ts`. If you
want to confirm it took: **Admin -> Health -> WhatsApp doctor**.

### 2.6 Render

Set `APP_DOMAIN=https://wheeldeal.pro` in the Render service's environment for
the gateway/worker services, then let it redeploy.

---

## 3. PayPal - exactly what to enable

Your webhook endpoint is:

```
https://wheeldeal.pro/api/webhooks/paypal
```

### 3.1 Create the webhook

1. **PayPal Developer Dashboard** -> https://developer.paypal.com/dashboard/
2. Toggle to **Live** (top right). A sandbox webhook will not fire for real
   money.
3. **Apps & Credentials** -> click your REST app.
4. Scroll to **Webhooks** -> **Add Webhook**.
5. *Webhook URL*: `https://wheeldeal.pro/api/webhooks/paypal`

### 3.2 The event checkboxes - tick exactly these six

These are the only events the route acts on. Everything else is noise your
endpoint will simply acknowledge.

| Event | Why the code needs it |
|---|---|
| `BILLING.SUBSCRIPTION.ACTIVATED` | Grants the tier. The primary confirmation path is the in-app one, but this is the durable backstop if the browser closed mid-approval. |
| `BILLING.SUBSCRIPTION.RE-ACTIVATED` | Restores a tier after a suspension is lifted. |
| `PAYMENT.SALE.COMPLETED` | The monthly renewal. Keeps a paying traveller entitled. |
| `BILLING.SUBSCRIPTION.CANCELLED` | Drops them to free. |
| `BILLING.SUBSCRIPTION.EXPIRED` | Drops them to free. |
| `BILLING.SUBSCRIPTION.SUSPENDED` | Drops them to free (failed payment). |

If you would rather not hunt for six checkboxes, ticking **"All events"** is
safe - unhandled types are recorded in `billing_events` and ignored.

### 3.3 The one step people forget

After saving, PayPal shows a **Webhook ID** (looks like `5ML12345ABCDE6789`).

**Copy it into Admin -> Keys -> "PayPal Webhook ID" (`PAYPAL_WEBHOOK_ID`).**

Until that is set, the route fails closed: every webhook is treated as
unverified and **no plan is ever granted from one**. That is deliberate - an
unsigned request must never be able to hand out Ultra - but it does mean
cancellations will not take effect until you paste it.

### 3.4 App capabilities to confirm

In **Apps & Credentials -> your app -> Features**, make sure these are enabled:

- **Subscriptions** (a.k.a. Vault) - required; without it
  `intent=subscription` + `vault=true` will not load the buttons.
- **Log in with PayPal** - not required.
- **Transaction Search** - not required.

Your two live plan ids should already be in **Admin -> Keys**:

- `PAYPAL_PLAN_PRO` = `P-4DM55206VD221810RNJTCFVA`
- `PAYPAL_PLAN_ULTRA` = `P-13V7509211655291CNJTCHDA`
- `PAYPAL_ENV` = `live`

### 3.5 Rotate the secret

The `PAYPAL_SECRET_KEY` you pasted into chat must be treated as compromised.
**Apps & Credentials -> your app -> Secret -> Generate New Secret**, then paste
the new one into **Admin -> Keys -> "PayPal Client Secret"**. Delete the old
secret from PayPal once the new one is saved and a test subscription works.

### 3.6 Verify it end to end

1. Subscribe to Pro with a real PayPal account (you can refund yourself).
2. **Admin -> Users** - your account should show `pro`.
3. **paypal.com -> Settings -> Payments -> Manage automatic payments** -> cancel
   it.
4. Within a minute, **Admin -> Users** should show `free` again. If it does not,
   `PAYPAL_WEBHOOK_ID` is not set - see 3.3.

---

## 4. AdSense - getting wheeldeal.pro approved

The code side is done. What is left is Google's review, and the honest thing to
say is that the review is about **content**, not about tags. The tags only get
you to the front of the queue.

### 4.1 Search Console first (do this before AdSense)

1. https://search.google.com/search-console -> **Add property** -> **Domain** ->
   `wheeldeal.pro`.
2. Google gives you a TXT record. Paste it into your registrar's DNS. Verify.
3. **Sitemaps** (left menu) -> submit `sitemap.xml`.
4. **URL Inspection** -> paste `https://wheeldeal.pro/welcome` -> **Request
   indexing**. Repeat for `/pricing`, `/terms`, `/privacy`.

Do not skip this. An unindexed site is the single most common reason an AdSense
application sits in "getting ready" for weeks.

### 4.2 AdSense

1. https://adsense.google.com -> your site `wheeldeal.pro` is already listed
   (that is the screen in your screenshot).
2. Under **"You need to verify site ownership"**, the **AdSense code snippet**
   option is already satisfied - the tag is in `<head>` on every page. The
   **ads.txt** option is satisfied too. Either one is enough; both are live.
3. Tick **"I've placed the code"** and click **בצע אימות / Verify**.
4. Then click **בקשה לבדיקה / Request review**.

Verification usually passes within minutes. The **review** takes anywhere from a
few days to a few weeks.

### 4.3 What the review actually checks - and where this site is thin

Be aware of this before you request the review, because a rejection costs weeks:

- **Signed-out visitors see `/welcome` and almost nothing else.** Google's
  reviewer never signs in. If the only public pages are a landing page, a
  pricing page and two legal pages, that reads as "low value content" and is the
  most likely rejection reason for this specific site.
- **What fixes it:** public, genuinely useful pages that do not require an
  account. For a rental-negotiation app the natural ones are destination guides
  ("scooter rental in Krabi: what shops actually charge"), a public FAQ, a
  how-it-works page with real screenshots, an about page naming the operator.
  Ten to fifteen substantial pages is the usual bar.
- **Required pages you already have:** Privacy Policy (`/privacy`) and Terms
  (`/terms`). Make sure both are linked from the footer of `/welcome` - a
  reviewer looks for them there.
- **Ads must not outnumber content.** Free-tier slots only, one per screen, and
  they are labelled "Sponsored". That is already how `AdBanner` behaves.
- **Traffic.** There is no published minimum, but a site with no organic traffic
  at all is frequently held. Search Console indexing (4.1) is what starts that.

My recommendation: **do 4.1 and 4.2 now** (verification is free and instant, and
being verified early does no harm), but expect to add public content before the
review passes. If it is rejected, the rejection email names the policy, you fix
that, and you can reapply - there is no penalty for reapplying.

### 4.4 After approval

- **AdSense -> Ads -> By site** -> turn **Auto ads** on or off. With the site
  tag already present, Auto ads work with no further code.
- The in-app `<AdBanner>` slots fill automatically once Google starts serving;
  until then they render as a labelled placeholder.
- Paid plans stay 100% ad-free - that is enforced in the component, not by
  configuration.

---

## 5. Quick reference - every domain-bearing surface

| Surface | Who owns it | Action |
|---|---|---|
| Canonical / OpenGraph / Twitter URLs | `src/lib/site.ts` | done in code |
| `robots.txt`, `sitemap.xml` | `src/app/robots.ts`, `src/app/sitemap.ts` | done in code |
| Web Push sender identity | `src/lib/push.ts` | done in code |
| Nominatim User-Agent | `src/lib/google.ts` | done in code |
| `ads.txt`, AdSense site tag, account meta | `public/ads.txt`, `src/app/layout.tsx` | done in code |
| WhatsApp webhook registration | `src/lib/evolution.ts` (derives from `APP_DOMAIN`) | automatic |
| PayPal return/cancel URLs | derived from the live request origin | automatic |
| Gateway CORS origin | `apps/gateway/src/routes/stream.ts` reads `APP_DOMAIN` | **set `APP_DOMAIN` in Render + Cloud Run** |
| Cloud Run custom domain | GCP Console | **you** |
| Maps API key referrer restriction | GCP Console | **you** |
| Google OAuth origins + redirect URIs | GCP Console | **you** |
| Supabase Auth Site URL / Redirect URLs | Supabase dashboard | **you** |
| PayPal webhook URL + events + Webhook ID | PayPal dashboard | **you** |
| Search Console property + sitemap | Search Console | **you** |
| AdSense verify + review request | AdSense | **you** |
