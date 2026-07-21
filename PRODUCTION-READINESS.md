# WheelDeal - Production Readiness & Scale Review

Date: 2026-07-16 · Branch: `claude/rental-agents-legal-setup-o7rgcv`
Scope: queue architecture, concurrency, rate limiting, test mode,
observability, cost control and the concrete path to hundreds of concurrent
users. Complements `ENTERPRISE-READINESS.md` (the earlier QA pass).

## Executive summary

The platform is architecturally sound for the private beta: every queue claim
is atomic at the database level (no double-sends across serverless
instances), inbound WhatsApp events are deduplicated exactly-once, per-user
isolation is enforced consistently by `user_email`/`sender_key` filters, and
the anti-ban engine's budgets are conservative. The real scaling constraints
are operational: queue draining depends on user traffic plus ONE external
cron, several read-then-write limit checks can over-admit under concurrency,
and the hottest table (`whatsapp_messages`) needed two more indexes (added in
this pass).

Verdict: **safe for the 25-tester beta today; complete the P1 list before
paid public signups; the P2 list before hundreds of concurrent users.**

## How work actually gets done (queues & workers)

- **Outbound queue** (`wa_outbox`): rows are claimed with an atomic
  `DELETE ... RETURNING` - the DB row is the lock, so N concurrent instances
  can never double-send. Failed sends re-queue with backoff (10min ×
  attempts, max 5, then a durable `wa-send-dropped` event). Batch size: 5 per
  drain call.
- **Strategic waits** (`graph_wakeups`): identical atomic-claim pattern. Rows
  are stamped with `user_email` so owner-scoped purges are exact matches (the
  old `thread_key LIKE email:%` pattern treated `_` in emails as a wildcard).
- **Who drains**: every activity poll from any open app, every webhook tail,
  the replies/status polls, and `/api/wa/ping` hit by an EXTERNAL cron
  (cron-job.org). `/api/queue` (the queued-messages VIEWER) deliberately does
  NOT drain - opening the list to review or remove messages must never be the
  event that sends them. Vercel Hobby crons run at most once per day, so the
  external pinger is the correct choice on this tier - but it is a single
  point of failure: if it lapses, queued messages only move while someone has
  the app open. **Action: keep two independent pinger services pointed at
  `/api/wa/ping` (5-10 min).**
- **Self-chaining drain** (`/api/wa/tick`, token-gated): kicked by every
  mass-bargain run and every ping-cron hit. One invocation drains, rides out
  a stagger step in-process (<=45s), then fire-and-forgets ONE call to
  itself while near-term work remains (hop-bounded ~40, single-runner via a
  30s chain claim). Result: a staggered batch keeps progressing for ~30 min
  after any trigger even with every app closed. Backstops unchanged:
  activity polls (app open) + the external pinger. Stalls are VISIBLE now:
  rows overdue >5 min surface an in-app "sending fell behind - catching up"
  banner instead of silently creeping ETAs.
- **New-contact budget is a PLAN-TIERED ROLLING WINDOW** (`src/lib/wa/
  capacity.ts`): free 10 new shops/6h, pro 15/4h, ultra 40/3h. Capacity
  refreshes CONTINUOUSLY as the oldest introduction ages out of the window -
  there is no hard "everything waits until tomorrow (UTC midnight)" wall any
  more. When the budget is spent, holds anchor to when the next slot frees
  (`newContactBudget().nextFreeAt` = oldest intro + windowHours, clamped into
  the shop's business hours) - at most windowHours away, never tomorrow. The
  window is counted migration-free from timestamped outbound RFQ rows
  (`whatsapp_messages.raw->>kind=rfq`), so no schema change is needed. Plans
  are now REAL: `dynamicHourCap` and the new-contact cap both scale with the
  plan (Ultra gets 18/h headroom vs free's 6/h), so `vip-concurrency` finally
  does something. Warm-up is humane: the ramp floor is 45% (not the old ~14%
  day-0 that let a fresh number reach only ~2 shops/day). Mass bargain
  computes the remaining budget AT CLICK TIME: in-budget shops start
  immediately (first now, 45-75s stagger), over-budget shops park on the
  rolling anchor and the user sees a "next slot in ~Xh" countdown. Duplicate
  pending rows per shop are refused at enqueue.
- **Hourly-cap holds no longer creep**: an over-cap send now anchors to when
  the rolling hour actually frees (oldest in-window send + 1h + <=3min
  jitter), a fixed future instant - not a fresh `now+15-35min` re-stamped on
  every drain (the residual "came back later, everything moved another 30 min"
  path, which the daily fix in the prior round had left on the hourly cap).
  Burst tolerance scales with the plan's hourly headroom (the 50-120s min-gap
  already spaces a paced batch, so it is not a robotic flurry).
- **Cancellation tombstones** (`wa_cancellations`, unique on sender+number):
  written when a user removes queued messages, clears a search, or closes a
  deal. `guardOutbound` REFUSES automated sends to a tombstoned recipient
  (rule -2, plus a last-instant re-check right before the network send in
  both drain paths), so outbox re-queues, wakeup re-compositions and retries
  are all covered - removal is permanent until the user explicitly sends to
  that shop again (outreach / mass / consent / close-deal clear the
  tombstone). Human takeover is enforced at the same choke point AND the
  takeover event purges that thread's outbox rows + tick wakeups. Read
  semantics are strict: a missing table is vacuously "not cancelled", but a
  transient read failure is UNKNOWN and automated sends fail CLOSED (queued
  `sync-retry`, +5-10 min). Kill switch: `CANCEL_GUARD=off` (Admin - Keys)
  disables enforcement while writes continue.

## Rate limiting & anti-ban budgets (as shipped)

Per user daily: 15 searches, 300 geocodes, 120 AI calls, 60 WA sends
(15/hour). Anti-ban per number: base 4/hour growing to 14/hour with trust and
plan headroom (free 6/h, pro 10/h, ultra 18/h), 40/day cap (±20% jitter),
50-120s gaps, business hours 08-21, plan-tiered rolling new-contact window
(free 10/6h, pro 15/4h, ultra 40/3h), auto-pause on risk ≥70 for 4h, 7-day
warm-up ramping from a 45% floor to full.
`SCALE_MODE=on` triples the per-user budgets and relaxes client polling
(12s→25s activity, 15s→30s replies) - it does NOT change anti-ban pacing
(deliberate: number safety never scales down).

**Concurrency + herd hardening (wa_send_claims + jittered holds):**
- Every send claims two atomic slots in `wa_send_claims` (PK conflict = the
  lock): a per-sender min-gap bucket (serializes the 5+ concurrent drain
  callers - two invocations can no longer both pass the same stale gap
  check) and a per-message idempotency hash claimed BEFORE the network send
  (concurrent duplicates can no longer both deliver). Straddle-proof at
  bucket boundaries via a previous-bucket age check. Failed sends release
  their message claim so retries are not self-deduped. GC after 24h.
- Cap holds are JITTERED (hourly +15-35m, daily new-contact +60-90m, pause
  +60-75m): a held batch regains individual release times - never ten
  messages sharing one "~15:27" ETA again. Parked rows count toward the
  hourly cap only when due within the next hour (no cascade wedging).
- Mass bargain is a durable TRICKLE: shop 1 sends immediately, shops 2..N
  are parked with cumulative 45-75s jittered `not_before` stamps
  (`batch-spacing` + batchId/batchIndex/batchSize meta for the progress UI).
  The drain re-runs the full guard per row at its own time.
- Drain is capped at 2 sends per sender per invocation; excess DUE rows are
  re-spaced forward with jitter (a stale backlog trickles out, never bursts).
- FAIL-CLOSED reads: the guard's reputation + 24h-history reads are strict -
  a transient Supabase failure holds automated sends (`sync-retry`, 5-10
  min) instead of reading as "fresh number, nothing sent today" (the old
  behavior disabled the entire anti-ban engine exactly during outages).
  Manual sends stay permissive. Missing tables (pre-migration) degrade to
  today's behavior.
- Observability: `claim-lost` / `sync-retry` / `cancelled-send-blocked` /
  `takeover-send-blocked` agent_events; drain failures log tagged errors.
- Dev harness: `node scripts/hammer-queue.mjs` fires parallel drain storms +
  a racing delete at a local server to observe serialization.

## Connection lifecycle (Evolution)

- **Closing a deal keeps the WhatsApp link.** The old flow logged out AND
  deleted the instance after every closed deal (full QR re-link each time -
  the "my WhatsApp disconnected by itself" report). The session-closed
  marker + cancellation tombstones already silence the agents; teardown adds
  nothing. Rollback switch: `KEEP_WA_ON_CLOSE=off` restores the old
  behavior for one release. Explicit disconnect stays in Profile.
- **Connect re-entry is non-destructive for 90s.** A second Connect tap
  while a pairing is mid-handshake ("connecting", started <90s ago)
  re-polls the SAME instance for its current QR/pairing code instead of
  logout+delete (which destroyed the exact pairing the phone was completing).
  Stale or wedged pairings still get the clean recreate.
- Keep-alive remains the external pinger on `/api/wa/ping` (see above).

## Test mode - the honest truth table

| Area | TEST_MODE on (flagged tester) | Production |
|---|---|---|
| Plan | Ultra, free, instant | paid via PayPal |
| Checkout | sandbox - `setPlan()` applied instantly, no charge | real checkout |
| Banner | global strip visible | none |
| WhatsApp | **REAL** - messages go to real shops from the tester's number, real ban-risk budget | same |
| Google Places/geocode spend | **REAL** | same |
| AI token spend | **REAL** | same |
| Data | same tables (no reset mechanism - "may be reset" is a policy, not a feature) | same |

Implications: testers must treat WhatsApp hunts as real outreach to real
businesses. The banner copy now says exactly that. Kill switch + per-user
daily limits are the cost guard in both modes.

**Tester capacity**: the beta allowlist caps at 25 invited testers + owner
(enforced on save; the env-var fallback list is uncapped). WhatsApp capacity
is bounded separately by `EVOLUTION_MAX_PER_HOST` (default 40 linked numbers
per Evolution host) - so 25 testers fit on one host; hundreds of users need
`EVOLUTION_HOSTS` pool entries (~1 host per 40 users).

## Execution resilience (the "batch stopped after one send" fix)

The Evolution host is the single hard dependency for sending. When it blips
(the observed Render free-tier "wd-evolution HTTP health check failed" - free
instances sleep and can be replaced), sends fail transiently. The code now
survives that gracefully instead of stalling/losing the batch:

- **`drainOutbox` classifies failures** (`src/lib/wa/send-classify.ts`): a
  transient/infra failure (reconnecting, 5xx, timeout, unknown) retries in
  ~45-120s with NO attempt-cap burn, so a batch resumes within a minute of the
  host recovering. Only RECIPIENT failures (not-on-WhatsApp / invalid / blocked)
  count toward the 5-attempt give-up, whose event now names the shop. The prior
  behaviour deferred every failure 10/20/30/40/50 min then dropped it silently -
  that is what made "only one message sent, then it stalled".
- **Connection state is honest** (`hasSessionRow` fail-safe, no open->connecting
  clobber): a host outage reports *reconnecting*, never *not linked*, so the app
  never tells a connected user to re-link.

**Adversarial-sweep hardening (this pass) - drain can no longer lose a queued
message, and no external call can hang a handler:**

- **A claimed row is never silently dropped** (`src/lib/wa/outbox-policy.ts`
  `needsRepark`, pinned by `outbox-policy.test.ts`). `drainOutbox` claims a due
  row by DELETING it, then re-runs the guard. Previously the daily-cap and the
  reply/delivery-rate circuit breakers returned a bare `{allow:false}` WITHOUT
  re-queuing, so the already-deleted row vanished ("sent a few, the rest
  disappeared"). Now: those branches `queue()` with a real rolling-window hold;
  every deliberate drop (cancelled / duplicate / rfq-dedup / takeover) is marked
  `terminal:true`; and the drain re-parks any reject that is neither queued nor
  terminal. A `send()` that throws is caught and re-queued too, so one bad send
  never abandons the rest of the batch.
- **The daily cap counts ACTUAL sends, not the sender's own parked backlog.**
  Counting parked rows toward the 24h volume cap made a legitimately-staggered
  40-shop batch trip its own ceiling (1 sent + 38 parked >= cap) and defer
  almost everything. Concurrency is already serialized by the send-claim rows;
  the hourly cap still counts due-soon pending for near-term pacing.
- **Every external fetch is time-bounded.** `evoFetch` (Evolution) now aborts at
  12s and Supabase's REST helpers (`runtime-config.ts` `timedFetch`) at 8s - a
  cold/asleep host or a stalled DB connection returns a transient failure the
  drain retries, instead of hanging a request until Vercel kills the function
  (which, mid-drain, previously LOST an already-claimed row). Pinned by
  `hardening-invariants.test.ts`.
- **Pairing state is honest** (`isLinkedForUi` / `isLinkedFromStatus`, pinned by
  `linked-status.test.ts`): a not-yet-opened `connecting` session no longer
  reports `connected:true`. Previously `/api/wa/status`'s first 3s poll during a
  first-time link saw the `connecting` row via `hasSessionRow`, reported linked,
  and cleared the pairing code before the user could enter it. `/api/wa/status`
  and `/api/wa/health` now require a durable `open` (still fail-safe on a DB
  blip); the send path keeps `hasSessionRow`'s permissive semantics.
- **Cross-user isolation on wakeup purges/reads.** `graph_wakeups` filters moved
  off `thread_key=like.<email>:*` to the exact stamped `user_email=eq.` column,
  and `wa_sessions` reads off `email=ilike.` to `email=eq.` - an underscore in
  one user's email is a single-char SQL wildcard that could match (delete/read)
  a different registered user's rows. Pinned by `hardening-invariants.test.ts`.

**Owner infra action (the ~$10/mo ask):** the durable fix for the host itself is
to move the Evolution instance off Render's **free** tier to **Render Starter
(~$7/mo, no sleep, faster restart)** - this removes the recurring cold-start /
health-check-timeout that triggers the transient path in the first place. Pair
it with the two independent `/api/wa/ping` crons (below) at a 1-2 min cadence so
the outbox drains without depending on an open app. That combination (paid
always-on host + external cron + the health-aware retry above) reliably
progresses hundreds of concurrent users' queues; a dedicated worker/queue
(Upstash QStash free tier, or a Render background worker) is the P2 upgrade if
volume outgrows it, not a launch blocker.

## Before a paid public launch (P1)

1. **Move Evolution off Render free tier** (Starter, ~$7/mo) + **second +
   monitored pinger** for `/api/wa/ping` (uptime alert on it) - today the whole
   background pipeline leans on one free host and one unmonitored external cron.
2. **Error tracking** (Sentry or similar) + alerts on `agent_events` kinds
   `wa-send-dropped`, `wa-ban-risk`, `media-fetch-failed` - failures are
   currently silent rows an admin must go look for.
3. **Run the updated `supabase/schema.sql`** - this pass added the three
   missing hot-path indexes (`raw->>'sender'`, `from_number`,
   `wa_outbox.sender_key`), plus the **feedback threads** additions
   (`feedback_replies` table, `feedback.user_seen_at`, `feedback_reporter_idx`).
   All additive/`if not exists` - safe to re-run. Until it runs, feedback
   threads degrade gracefully (reads return empty, no crash); replies persist
   only after the migration. The **messaging capacity redesign needs NO
   migration** - the rolling window is counted from existing `whatsapp_messages`
   RFQ rows.
4. **Raise Evolution capacity intentionally**: one host ≈ 40 users; add hosts
   to the pool before invites outgrow it.
5. **PayPal live-mode checklist**: client id/secret, both billing plan ids,
   webhook id set in the Vault (PAYPAL_ENV=live); test a real purchase + webhook
   round-trip once.

## For hundreds of concurrent users (P2)

1. **Dedicated worker for draining** (QStash/Upstash schedule or a Pro-tier
   Vercel cron every minute) + adaptive batch size (5 → 25) so the queue
   drains independently of user traffic.
2. **Atomic counters for limits**: `checkDailyLimit` and the WA volume caps
   are read-then-write - under concurrency a user can exceed a limit by the
   parallelism factor. Move to a per-user-per-day counter row with
   `insert ... on conflict do update ... returning` (single round-trip, no
   TOCTOU), which also kills the 1000-row scan per gated request.
3. **Queue inbound webhook work**: today each shop reply runs the full AI
   pipeline synchronously inside the webhook invocation. Bursty replies =
   unbounded concurrent AI spend. Enqueue → 200 immediately → worker
   processes.
4. **Retention jobs**: `whatsapp_messages`, `agent_traces`, `api_usage`,
   `negotiation_threads` grow unbounded; add TTL cleanup (90d) + monthly
   rollups for the cost tracker.
5. **Debit background AI**: engine wakeups/judge calls bypass
   `LIMIT_AI_PER_DAY` (only interactive routes debit it) - record them so
   cost scales with the budget, not with thread count.
6. **Config cache-bust**: safety-critical keys (KILL_SWITCH) are cached 30s
   per instance; add a cheap version-key check so a kill applies in seconds
   everywhere.

## What is already right (do not re-solve)

- Atomic queue claims (`sbDeleteReturning`) - genuinely exactly-once.
- `wa_processed` PK-claim dedupe on inbound - burst-safe.
- Per-user scoping is consistent (`user_email`, `sender_key`,
  `raw->>'sender'`, `threadKey = email:digits`); the cross-user reads that do
  exist (global message-uniqueness check) are deliberate and content-only.
- Cost guards: global kill switch, per-user daily limits, LLM per-event
  budget with an 8s deadline reserve, request caching on paid lookups.
- Graceful degradation everywhere: no key → mock, no Supabase → in-memory,
  webhook never 500s.
