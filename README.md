# WheelDeal 🛵💨

**Hyper-local vehicle rental savings & negotiation engine.** Describe the ride
you want in plain English; WheelDeal's AI agent ecosystem finds partner rental
vendors near your hotel, sends structured RFQs, negotiates the price down in
real time, and locks in the cheapest deal — all from your phone.

> Built mobile-first, on 100% zero-cost tiers (Next.js on Vercel · OpenStreetMap
> · Supabase-ready · free-tier LLM gateways). Runs fully in **demo mode** with
> no keys or external services required.

---

## ✨ Features

- **Plain-text → structured RFQ.** The **Profiler Agent** turns _"125cc scooter
  with a phone mount, under 20,000 km, 3 days"_ into a clean, vendor-ready
  inquiry.
- **Agent ecosystem:** Profiler · Adaptive Bargaining · **Market-Rate Analyst**
  · **Vendor Sentiment** · Safety Guardrail — each degrades gracefully to a
  deterministic heuristic when no LLM key is set.
- **Continuous Learning Engine.** Every negotiation updates a shared tactic
  playbook (win-rates + average discount), so the agents "step up" stronger
  plays over time.
- **Dual view:** sortable **List** (closest / top-rated / biggest savings /
  active) + interactive **Leaflet map** with live, colour-coded vendor pins.
- **Gamified live tracker** per vendor: `Locating → RFQ Sent → Awaiting →
  Negotiating → Offer` with micro-animations and a real-time **savings ticker**.
- **Smart Bargain** one-tap counter-offers, plus a **safety-screened** custom
  chat (blocks harmful / unprofessional messages before they send).
- **Full fulfilment loop:** agent spec-verification → hotel delivery or in-store
  pickup → interactive date/time scheduling → confirmation.
- **Admin workspace** (allowlisted emails): agent analytics vault, masked key
  management, and a user-access control panel.

## 🔐 Compliance & security

- Outreach uses the **official Meta WhatsApp Cloud API** to **opted-in partner
  vendors** — no scraping, no unsolicited bulk blasting. With no WhatsApp keys,
  it produces compliant **click-to-chat (`wa.me`)** links instead.
- Agents **identify themselves as automated procurement assistants** to vendors.
- **Secrets never reach the browser.** All keys are read from `process.env`
  server-side; the admin key panel shows only a masked fingerprint. `.env*` is
  gitignored — no credentials are committed to this repo.

## 🚀 Quick start (local)

```bash
npm install
cp .env.example .env.local   # optional — app runs in demo mode without it
npm run dev                  # http://localhost:3000
```

Sign in from `/login` with any email. To unlock the admin workspace, sign in
with an email listed in `ADMIN_EMAILS` (default: `doron@pristivo.com`).

## ☁️ Deploy to Vercel (free tier, ~3 clicks)

1. Push this repo to GitHub (already done if you're reading this there).
2. Go to **vercel.com → New Project → Import** this repository.
3. (Optional) Add environment variables from `.env.example` in **Settings →
   Environment Variables**. None are required for a working demo.
4. **Deploy.** Vercel auto-detects Next.js and gives you a public URL.

> The app is 100% functional with zero env vars. Add LLM / Supabase / WhatsApp
> keys to switch on live AI, persistence, and real messaging.

## ⚙️ Environment variables

See [`.env.example`](./.env.example). Everything is optional; the app falls back
to in-memory data + deterministic mock AI when a key is absent.

| Group | Vars | Effect when set |
| --- | --- | --- |
| LLM | `GROQ_TOKEN`, `GEMINI_TOKEN`, `OPENROUTER_TOKEN`, `CEREBRAS_TOKEN`, `AI_PROVIDER` | Real Profiler / Safety agents |
| Data | `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, … | Persistent vendors + agent memory |
| Messaging | `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | Live WhatsApp Cloud API |
| Auth | `ADMIN_EMAILS`, `SESSION_SECRET` | Admin allowlist + signed sessions |

> **Rotate any key that has ever been shared in plaintext** (chat, email,
> screenshots) before using it in production.

## 🧱 Tech

Next.js 14 (App Router) · TypeScript · Tailwind CSS · React-Leaflet /
OpenStreetMap · Edge-ready API routes. No paid services.

## 📁 Structure

```
src/
  app/            routes + API handlers (profile, negotiate, safety, outreach, admin, auth)
  components/     UI (VendorCard, MapView, Tracker, Filters, BookingSheet, …)
  lib/            agents, ai providers, memory, geo, vendors, session, whatsapp, config
```

---

Made for travellers who'd rather negotiate from the pool than the front desk.
