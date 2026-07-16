# CLAUDE.md

Guidance for Claude (and humans) working in this repo.

## What this is

**WheelDeal** - a mobile-first web app that finds and negotiates the cheapest
car / motorbike / scooter rentals near a traveller's hotel. AI agents structure
the request, discover partner vendors within a radius, and run a live, gamified
negotiation funnel. Next.js 14 (App Router) + TypeScript + Tailwind, deployed on
Vercel free tier. Runs fully in **demo mode** with zero external services.

## Golden rules

- **Never commit secrets.** All keys come from `process.env` or the Supabase-
  backed Key Vault. `.env*` is gitignored. `.env.example` holds placeholders only.
- **Everything degrades gracefully.** Every integration (LLM, Supabase, WhatsApp,
  Resend, Stripe) has a no-key fallback so the app always builds and runs.
- **Use only short hyphens `-`** in code and copy. No `-` or `-`.
- **Mobile first.** Test at 320-430px. No horizontal overflow. Respect safe-area
  insets (`pt-safe`, `pb-safe`). Keep form controls >= 16px to avoid iOS zoom.
- Validate before pushing: `npm run typecheck && npm run build`.

## Architecture

```
src/
  app/
    page.tsx                 Main app: search -> funnel -> offers -> booking
    login/ admin/            Passwordless login + management workspace
    icon.svg apple-icon.tsx  Brand mark (half motorbike / half car)
    opengraph-image.tsx      Social card (next/og, generated offline)
    manifest.ts              PWA manifest (standalone => App Store feel)
    api/
      profile   negotiate   safety   vendors      (core funnel)
      outreach                                     (WhatsApp send, safety-screened)
      feedback  feedback/assist                    (triaged feedback + AI writer)
      billing/checkout                             (Stripe, admin only)
      webhooks/whatsapp  webhooks/stripe           (inbound events)
      admin/config  admin/users  admin/analytics   (admin, session-gated)
      auth/login|logout|me
  lib/
    agents.ts        Profiler, Bargaining, Market-Rate, Sentiment, Safety, Feedback agents
    ai.ts            LLM provider abstraction (Groq/Gemini/OpenRouter/Cerebras) + mock
    runtime-config.ts Key resolution: Supabase override -> process.env (+ AES encryption)
    config.ts        Admin Key Vault (masked, never leaks secrets to client)
    session.ts       HMAC-signed cookie sessions; admin via ADMIN_EMAILS allowlist
    whatsapp.ts email.ts stripe.ts   integrations (all optional)
    memory.ts access.ts vendors.ts geo.ts brand.ts types.ts
  components/        UI (VendorCard, MapView, Tracker, Filters, BookingSheet,
                    FeedbackModal, TabBar, BrandMark, icons, ...)
supabase/schema.sql  Run once; RLS on, service-role only
```

## Key mechanics

- **Runtime config**: integration secrets resolve as Supabase override ->
  `process.env`, cached 30s per instance. Admin-pasted keys are AES-256-GCM
  encrypted (key derived from `SESSION_SECRET`) and stored in `app_config`, so
  they persist on serverless and apply without a redeploy. Bootstrap secrets
  (Supabase connection, `SESSION_SECRET`) are env-only / read-only in the UI.
- **Admin gate**: `getSession().isAdmin` is derived from `ADMIN_EMAILS`, never
  from client input. All `/api/admin/*`, billing, and the admin page check it.
- **Negotiation** is simulated server-side (round-based price cuts bounded by the
  Market-Rate Analyst). Swap in real WhatsApp threads later via the webhook +
  `whatsapp_messages` table.

## Operations

`PRODUCTION-READINESS.md` is the living scale/ops review: queue mechanics,
anti-ban budgets, the honest TEST_MODE truth table, tester/host capacity and
the P1/P2 launch roadmap. Read it before changing wa-guard, usage limits or
the outbox/wakeup draining.

## Deploy

Bootstrap env vars in Vercel: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SESSION_SECRET`, `ADMIN_EMAILS`. Run
`supabase/schema.sql`. All other keys can be pasted in Admin -> Keys. See
`GUIDE.md` for the step-by-step.

## Working branch

Develop on `claude/rental-negotiation-app-pc33ux`. Commit + push there.

## MCP servers (tooling for AI-assisted development)

`.mcp.json` wires the official remote MCP servers for the external services
this app uses, so Claude Code (and other MCP clients) can inspect them
directly. All are HTTP + OAuth - authorize interactively via `/mcp` in a
Claude Code session; NO keys are stored in the repo.

| Service | MCP | Notes |
|---|---|---|
| Supabase | `https://mcp.supabase.com/mcp?project_ref=...` | DB, app_config vault, tables |
| Stripe | `https://mcp.stripe.com` | fallback billing (official remote MCP) |
| Vercel | `https://mcp.vercel.com` | deploys, env, domains (official remote MCP) |
| GitHub | built into Claude Code remote sessions | PRs, issues, CI |

Services with NO official MCP server as of 2026-07 (use their REST APIs via
the code in `src/lib/`): Evolution API (WhatsApp), Lemon Squeezy, Groq,
Gemini, OpenRouter, Cerebras, Mistral, DeepSeek, Together, SambaNova,
Hugging Face, Brevo, Resend, Gmail SMTP, Google Maps Platform, OSM Nominatim,
Google AdSense, Web Push/VAPID.

## Owner switches (Admin -> Keys / Users)

- `TEST_MODE` - "on": beta testers flagged `test` ride Ultra free, checkout
  applies plans instantly with no charge, a global banner shows. Toggle also
  lives in Admin -> Users. "off" (or unset): fully live.
- `SCALE_MODE` - "on": 3x per-user rate limits + relaxed client polling for
  high-concurrency periods (flip AFTER upgrading the backend plans).
- `APP_DOMAIN` - the public domain; drives SEO/share metadata, geocoder
  identity and push sender identity with no redeploy.
- `HUMAN_TAKEOVER` - "off" disables user-typed-message takeover detection.
