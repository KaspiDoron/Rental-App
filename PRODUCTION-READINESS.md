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
(15/hour). Anti-ban per number: base 4/hour growing to 14/hour with trust,
40/day cap (±20% jitter), 50-120s gaps, business hours 08-21, 15 new
contacts/day, auto-pause on risk ≥70 for 4h, 7-day warm-up at half budget.
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
| Plan | Ultra, free, instant | paid via Lemon Squeezy |
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

## Before a paid public launch (P1)

1. **Second + monitored pinger** for `/api/wa/ping` (uptime alert on it) -
   today the whole background pipeline leans on one unmonitored external cron.
2. **Error tracking** (Sentry or similar) + alerts on `agent_events` kinds
   `wa-send-dropped`, `wa-ban-risk`, `media-fetch-failed` - failures are
   currently silent rows an admin must go look for.
3. **Run the updated `supabase/schema.sql`** - this pass added the three
   missing hot-path indexes (`raw->>'sender'`, `from_number`,
   `wa_outbox.sender_key`).
4. **Raise Evolution capacity intentionally**: one host ≈ 40 users; add hosts
   to the pool before invites outgrow it.
5. **Lemon Squeezy live-mode checklist**: store, variants, webhook secret set
   in the Vault; test a real purchase + webhook round-trip once.

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
