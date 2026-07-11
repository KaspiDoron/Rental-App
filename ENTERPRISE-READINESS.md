# WheelDeal - Enterprise Readiness Report

Date: 2026-07-11 · Branch: `claude/rental-negotiation-app-pc33ux`
Scope: full professional QA pass over the codebase + an honest readiness
assessment for scaling beyond the private beta.

## Executive summary

WheelDeal is in strong shape for a private beta and structurally ready to
grow: strict TypeScript compiles clean, the production build passes, every
integration degrades gracefully with no keys, all secrets flow through
env/Key Vault (none in the repo), and the risky surfaces (WhatsApp automation,
payments, admin) are gated and rate-limited. The gaps that remain are
operational rather than architectural: no automated test suite, no error
monitoring, ESLint unconfigured, and the Next.js version carries known
advisories whose real fix is a major upgrade.

Verdict: **ready for beta at current scale; close the P1 items below before
opening public signups.**

## QA performed (this pass)

| Check | Result |
| --- | --- |
| `tsc --noEmit` (strict) | PASS - zero errors |
| `next build` (production) | PASS - 68 API routes, 4 pages compile |
| Hardcoded secrets scan (key-shaped strings in `src/`) | PASS - none found |
| Tracked env files | PASS - only `.env.example` (placeholders only) |
| Short-hyphen copy rule | PASS - 3 stray em-dashes found and fixed |
| Admin/API auth gates | PASS - all `/api/admin/*` check `requireManagement`/owner role |
| Page gating | PASS - middleware redirects signed-out visitors to /login; APIs re-verify the HMAC cookie server-side |
| Webhook auth | PASS - Evolution: URL token + vendor-thread privacy rule; Lemon Squeezy: HMAC verified; Stripe: HMAC verification ADDED this pass (was a logging scaffold) |
| WhatsApp privacy hard rule | PASS - inbound messages are dropped unless WE first messaged that number (personal chats never stored) |
| Anti-ban engine | PASS - business hours, pacing, dedup (exact text + 24h per-shop RFQ), engagement halt, reputation |
| Session lifecycle | PASS - closing/starting a search purges the outbox and stamps a session-closed marker; agents go silent on dead threads |
| `npm audit` (prod deps) | 2 findings - see risk register |

## Architecture strengths (verified in code)

- **Graceful degradation everywhere**: LLM, Supabase, WhatsApp, email and
  billing each have a no-key fallback; the app always builds and runs.
- **Secrets discipline**: runtime config resolves Supabase override ->
  `process.env`; admin-pasted keys are AES-256-GCM encrypted; bootstrap
  secrets are env-only and read-only in the UI; masked in every response.
- **Honest data**: prices only ever come from real shop replies (extraction
  is sanity-checked against market floors, totals divided into per-day);
  shop tags require 2+ confirming replies before they display.
- **Agent guardrails**: ask once per shop, never above the quoted price,
  never imply acceptance (only the traveller confirms bookings), never
  switch language mid-thread.
- **Cost control**: per-user daily AI limits, provider failover, usage
  tracking and a kill switch.

## Risk register

| # | Severity | Finding | Recommendation |
| --- | --- | --- | --- |
| 1 | P1 | Next.js 14.2.35 carries published advisories (DoS, cache poisoning; most severe apply to self-hosted deployments - Vercel mitigates several at the platform layer). `npm audit fix` requires Next 16, a breaking upgrade. | Schedule a dedicated Next 15/16 migration pass before public launch; do not `--force` it casually. |
| 2 | P1 | No automated tests (unit/e2e). All verification is typecheck + build + manual flows. | Add a small Playwright smoke suite (login, search, offer render) and unit tests for `agent-loop` decision ladder and extraction math - these encode the business rules that keep breaking. |
| 3 | P1 | No error monitoring/alerting (Sentry or similar); failures surface only in Vercel logs. | Wire Sentry (free tier) into `app/error.tsx` + API catch paths. |
| 4 | P2 | ESLint is not configured (`next lint` prompts for setup). | Adopt `eslint-config-next` strict; fix on a quiet day - typecheck currently carries the load. |
| 5 | P2 | ~40 fast DB-only routes omit `maxDuration`; on Vercel Hobby they get ~10s. All AI/WhatsApp routes already set 60s. | Fine as-is; add `maxDuration` if any of them ever grows a slow upstream. |
| 6 | P2 | Single-instance in-memory caches (runtime config 30s, agent memory) mean brief cross-instance inconsistency on serverless. | Acceptable at this scale; revisit if traffic multiplies. |
| 7 | P3 | FX rates in `currency.ts` and country seed floors in `market.ts` are static approximations (labelled "≈" in the UI; AI refresh replaces floors weekly per area). | Optionally swap in a free FX API later. |
| 8 | P3 | WhatsApp automation via Evolution API rides on the user's personal number; a ban risk always remains despite the anti-ban engine (disclosed in Terms). | Keep limits conservative; long-term, offer the official Cloud API path for power users. |

## Go-live checklist (public launch)

1. Run `supabase/schema.sql` (idempotent) - includes the new
   `vendor_tag_signals` table.
2. Set bootstrap env vars in Vercel: `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `SESSION_SECRET`, `ADMIN_EMAILS` (everything else via Admin -> Keys).
3. Rotate any key that was ever shared in chat/screenshots.
4. Close P1 risks: Next upgrade pass, smoke tests, error monitoring.
5. Set `STRIPE_WEBHOOK_SECRET` only if Stripe is actually enabled
   (signature verification now enforces it).
6. Manual device pass at 320-430px (iPhone SE/Pro Max) on: search -> funnel
   -> offer -> booking, profile currency picker, admin on tablet.
7. Disable the private-beta lock (Admin -> beta list) when ready.

## Fixed during this QA pass

- 3 em-dashes replaced with short hyphens (WaTermsModal, BargainDraftModal,
  admin page) - repo copy rule.
- Stripe webhook: constant-time HMAC signature verification with a 5-minute
  replay window when `STRIPE_WEBHOOK_SECRET` is set (was log-only scaffold).
