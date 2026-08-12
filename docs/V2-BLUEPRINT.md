# WheelDeal V2 - Master Rebuild Blueprint

Provenance: produced from a 29-agent forensic audit (19 isolated investigators + 10
adversarial root-cause verifiers, ~3.4M tokens, 993 code reads) run on 2026-07-23
against commit `07ceaae`. Every bug below carries a VERIFIED verdict - each root
cause survived an independent attempt to refute it against the live code. Nothing
in this document is speculative unless explicitly marked.

Owner constraints locked for V2 (from the direction update):

- C1 **Zero-cost LLM mandate**: production runs 100% on free LLM tiers
  (Gemini Flash family, Groq, Cerebras, OpenRouter free pool). No paid API call
  is ever on a message path. Claude sub-agents are DEV TOOLING ONLY (used to
  produce this audit); the shipped app never calls Anthropic.
- C2 **No multi-call council/debate per message**: rejected for latency, quota
  burn and cross-thread blindness. See 4.1 for the formal evaluation.
- C3 **Target architecture**: Shared Session Blackboard + single-pass per-thread
  agent - critically evaluated, refined, and adopted below as
  **Blackboard + Single-Pass Turn Engine (SPTE)**.

---

## 0. Executive summary

1. **One infra fire underlies two "bugs"**: the Evolution WhatsApp bridge
   (`wd-evolution` on Render) is crash-looping ("Exited with status 1"). It is
   upstream of the pairing failures (Bug 1) and the "brief hiccup" sends
   (Bug 3). Fixing the crash is a Render ops action, not app code - and the
   repo's own `render.yaml` header says its committed crash-fix env vars require
   a Manual Sync that may never have been applied.
2. **Production still runs the legacy web path.** The GCP gateway/worker/Redis
   stack (modules M1-M7) is fully built but not provisioned (task #127). Every
   REDIS_URL-gated feature - session rival cache, copy-signature uniqueness,
   budget gates, SSE - is silently inert in production today. Several V1 bugs
   exist precisely in the gap the cutover was designed to close.
3. **All 10 reported bugs have verified, file:line root causes** (section 3).
   Three are one-line-class fixes (B7 clamp, B9 tautology, B6 states); three are
   structural (B3/B4 send-integrity, B5 scroll-lock, B8 realtime); the rest are
   contained rewrites.
4. **The current agent brain burns 2-4 LLM calls per inbound turn**
   (extract -> director -> compose -> optional judge). Under the zero-cost
   mandate this is the binding constraint. SPTE (section 4) collapses it to
   **at most 1 LLM call per compositional turn, 0 for reflex turns**, with all
   safety logic moved to 0-token deterministic rails.
5. **The blackboard is already half-built.** `src/lib/rival-cache.ts` (session
   offer ZSET + aggregates + pub/sub) is the embryo of the Session Blackboard;
   V2 promotes it to the canonical cross-thread intelligence store with a
   Postgres RPC twin so it works on the legacy web path TODAY, not only post-GCP.

---

## 1. Production topology - ground truth

Verified (F1 audit + owner screenshots):

| Piece | Where it runs today | State |
|---|---|---|
| Next.js app + all APIs | web host (migrating to Cloud Run) | LIVE |
| Postgres + storage | Supabase | LIVE |
| WhatsApp bridge (Evolution) | Render `wd-evolution` (docker, starter plan) | LIVE, **crash-looping** |
| Unattended queue drain | Render cron `wd-queue-drain` -> `/api/wa/ping` every 1 min | LIVE |
| Outbound queue | `wa_outbox` Postgres rows, drained by `drainOutbox()` from **7 independent trigger points** (`activity`, `replies`, `wa/status`, `wa/tick` self-chain, `wa/ping` cron, `admin/wa-queue`, webhook ingest) | LIVE - this trigger fan-out is a root cause of B4 |
| Gateway + BullMQ workers + Redis | GCE VM (infra/gcp) | BUILT, NOT PROVISIONED |
| SSE realtime | apps/gateway stream route | BUILT, no frontend consumer, no Redis |

Implications V2 must respect:

- Anything shipped before the GCP cutover must work **without Redis** (the
  established pattern: canonical logic in `src/lib`, REDIS_URL-gated
  acceleration, Postgres fallback that is correct on its own).
- The Evolution bridge is the single most fragile production component. V2-0
  (section 7) starts with stabilizing it.

---

## 2. Zero-cost LLM capacity model

Free-tier reality as of July 2026 (limits drift; the official consoles are
authoritative - treat this as the planning baseline):

| Provider / model | RPM | RPD | Notes |
|---|---|---|---|
| Gemini 2.5 Flash | ~10 | ~250 | multimodal (image inline), search grounding |
| Gemini 2.5 Flash-Lite | ~15 | ~1,000 | text workhorse |
| Groq llama-3.3-70b-versatile | 30 | ~1,000 | fastest quality tier (~sub-second gen) |
| Groq llama-3.1-8b-instant class | 30 | high (multi-k) | reflex/classification tier |
| Groq whisper-large-v3-turbo | - | ~2,000 | voice-note transcription |
| Cerebras (gpt-oss-120b / GLM) | ~5-30 | ~1M tokens/day (~400 turns at 2.4k tok) | 8k ctx cap - fits SPTE's lean prompt by design |
| OpenRouter `:free` pool | 20 | 50 (1,000 after one-time $10 credit) | overflow only; models rotate |

The stack already has the right chassis: `src/lib/ai.ts` is a 9-provider
failover with scoring. V2 formalizes it into a **model router** with three
tiers:

- **Tier R (reflex, 0 tokens)**: no LLM at all. Terminal states, holds,
  business-hours parks, session-closed silence, duplicate/decline re-entries,
  coalesce waits. Audit shows a large share of turns never needed composition.
- **Tier F (fast single pass)**: Groq 70B primary, Gemini Flash-Lite secondary,
  Cerebras tertiary - the standard SPTE turn (~1.6-2.5k in / 350-500 out).
- **Tier M (multimodal / hard turns)**: Gemini 2.5 Flash - photo turns (image
  attached inline to the SAME single pass) and high-stakes moves (first bargain,
  close). Budgeted at 250/day; overflow degrades to Tier F with the
  deterministic vision-text fallback that already exists.

Honest capacity statement (single shared key per provider, the Key Vault
model): pooled quality-turn capacity is roughly **2,500-3,500 LLM turns/day**
plus effectively unbounded reflex turns. One fully-played search session
(10 threads x 8-12 compositional turns) costs ~80-120 LLM turns, so a single
key set supports **~25-40 heavy sessions/day** (hundreds of *registered* users,
tens of *simultaneously negotiating* ones). The scale valves, in order:

1. Maximize Tier R (free) - SPTE is designed so most protocol turns never call
   an LLM.
2. Provider rotation (already built) + per-provider daily budget counters in
   Redis/Postgres so one pool exhausting degrades gracefully to the next.
3. **BYOK for Ultra** (the existing admin Key Vault pattern extended per-user):
   an Ultra subscriber can paste their own free Gemini/Groq key - their traffic
   leaves the shared pool entirely. This is the honest path to "hundreds of
   concurrent users" at $0.
4. Optional one-time $10 OpenRouter unlock (not recurring; default OFF).
5. Deterministic composer fallbacks (already exist: `composeBargain`
   `fallback:true` templates) - the app NEVER hard-fails on quota exhaustion,
   it gets more templated.

Cost of the benchmark scraper (step 3): `chatGrounded` (Gemini + Google Search
grounding) is already the stack's only live-web call and results are cached
21 days per (region, vehicle) - a handful of grounded calls/day, comfortably
inside the free grounding allowance.

---

## 3. Bug tracker - 10 isolated fix plans

Every bug: Symptom -> Verified root cause (anchors) -> Fix directive ->
Verification gate. Fixes are deliberately independent; no fix depends on
another module shipping first unless stated.

### Bug 1 - WhatsApp pairing "Invalid code, try again" (VERDICT: REVISED-CONFIRMED)

Root causes (all code-verified):

1. **No pairing-code expiry concept anywhere.** The client shows one code
   indefinitely (`WaConnect.tsx:78` sets it once; the 3s poll at `:86` checks
   connection state only, never re-mints) while the copy at `:339` claims
   "usually about 3 minutes". Real pairing codes die in ~60s. No
   `pairing_code_issued_at` exists (`wa_sessions`, schema.sql:209).
2. **The 90s soft-repoll trap.** `connectInstance()` (evolution.ts:744-789)
   re-polls the SAME instance for its current (possibly dead) code for 90s
   before allowing a hard reset - so "Try again" taps in the 60-90s window
   hand back a stale code.
3. **`resetInstance()` is dead code** (evolution.ts:948) - the function whose
   own comment says it backs the "New code" button has zero call sites.
4. **Single-host blindness**: `resolveHost()` (evolution.ts:324-327) skips ALL
   health probing when one host is configured - the production shape - so
   pairing calls fire blind at a crash-looping server and fail as generic
   timeouts.
5. **Crashes are invisible**: `wa/ingest.ts:183-213` only reacts to
   `connection.update` open, or close with logged-out/banned-class reasons. A
   process crash emits nothing (the emitter died), so the dead code sits on
   screen with zero signal. Bonus: the one error message that exists blames
   "Render waking up" (evolution.ts:940) - stale copy; the paid starter plan
   never sleeps, it crashes.

Fix directive (isolated):

- Infra first: pull `wd-evolution` crash logs on Render; verify the committed
  OnWhatsappCache/Prisma fix env vars (`render.yaml` header) were actually
  applied via Manual Sync; fix or re-pin the Evolution image version.
- Schema: add `pairing_code_issued_at timestamptz` to `wa_sessions`.
- `evolution.ts`: stamp issuance when a code is minted; replace the 90s grace
  with a real TTL (~55s): inside TTL -> soft re-poll (protects an in-flight
  pairing, the reason the grace exists); past TTL -> guaranteed hard reset
  (wire `resetInstance()` at last). Probe `hostHealthy()` even for a single
  host and return a distinct `hostDown` state.
- `WaConnect.tsx`: visible ~55s countdown on the code; auto-refresh on lapse;
  honest copy ("enter it within a minute"); render `hostDown` as "our WhatsApp
  server is restarting - retry in ~1 min" instead of a generic failure.

Verification: unit-test the TTL branch matrix (fresh/soft/hard); manual pairing
drill; grep-gate that no UI copy claims minutes-long validity.

### Bug 2 - Repetitive, unnatural openers (VERDICT: REVISED-CONFIRMED)

The production string reproduces byte-for-byte from code:

1. **Deterministic template defect**: `promptCompiler.ts:62` - the
   "intro-first" branch (1 of only 3 sentence orders, so ~33% of ALL openers)
   relocates the greeting AFTER the ask and glues a hard-coded literal
   `" btw!"` onto it: `${intro} ${s.ask} ${greeting} btw!`. That IS
   "...best price? Hi there btw! Thanks! 🙏".
2. **Unseeded second randomization layer**: `guardOutbound` re-runs
   `personaHumanize`/`humanizeVariant` with bare `Math.random`
   (wa-guard.ts:876-878; persona.ts:67 drops apostrophes 35% of the time ->
   "Im visiting"), stacked on the seeded compiler and contradicting its
   determinism contract. (This same defect is the B4 wire-double-send enabler.)
3. **The uniqueness backstop is inert in production**: the Redis signature
   window no-ops without REDIS_URL (uniqueness.ts:149) AND the single-ask route
   calls `ensureGloballyUnique(compiled, [])` with a hard-coded empty history
   (outreach/route.ts:175). The hour-bucketed nonce (`:172`) makes same-hour
   recompiles byte-identical.
4. **Regional register is toothless**: REGION_SLANG appends at most one word at
   ~33% odds; all base pools are region-agnostic (matrix.ts:104-152).
5. Also: `GREET_SWAPS[0]` regex only matches `Hi ` so "Hi there!" swaps into
   "Hey there! there!" (wa-guard.ts:774-799); zero CI coverage pins sentence
   order.

Fix directive (isolated):

- Rewrite the intro-first branch: greeting opens or folds into the intro;
  delete the `btw!` literal; sentence orders become grammatically-safe
  assemblies only.
- Seed `personaHumanize`/`humanizeVariant` from the same
  `threadId|vendorId|nonce` seed as the compiler AND **run humanization exactly
  once, at enqueue** - never again at drain (see B4).
- Feed real recent-outbound history into `ensureGloballyUnique` on the single
  ask route; widen the nonce below hour granularity.
- Region-keyed pools: add simple-register GREETINGS/ASK/SIGN_OFF variants for
  PH/TH/ID/VN keyed the same way REGION_SLANG already is (light, respectful,
  per the matrix's own design note).
- Fix the GREET_SWAPS regex; add CI tests pinning per-order sentence sanity
  ("greeting never after ask", "no literal btw! tail", 40-opener pairwise
  trigram distinctness).
- Under SPTE (section 4) the opener path keeps this compiler (it is 0-token);
  ongoing turns get style directives in the single pass - same pools, one
  humanization point.

### Bug 3 - "Ask for a price": serial lane, 1-min lock, drops (VERDICT: REVISED-CONFIRMED)

Root causes:

1. **All cold RFQs share ONE per-sender pacing lane by design**:
   `claimForSend(...)` is called without `perRecipient` (outreach/route.ts:307)
   and the drain explicitly forces `perRecipient: isReplyRow` - rfq rows are
   deliberately kept on the single lane (wa-guard.ts:1498-1509; slot key
   collapses to `gap:12s:<bucket>`, pacing.ts:160). A burst of taps across
   DIFFERENT shops fights for one slot; losers are parked 1-3 min out
   (route.ts:316-341) - that is the "~1 minute lock".
2. **No synchronous re-entry guard on the button**: `sendRfq()` has no ref
   lock; `disabled` derives from React state that lands after commit
   (VendorCard.tsx:125, :632) - a double-tap dispatches two POSTs.
3. **The exact "brief hiccup" toast is mostly a mislabeled DUPLICATE response**:
   the claim-loss duplicate branch returns `{duplicate:true, reason:...}` with
   NO `error` field (route.ts:308-315), and `sendRfq()` never reads
   `d.duplicate`, so it falls into the catch-all fallback toast
   (VendorCard.tsx:184). The user is told "a hiccup" when the truth is "this
   exact message is already on its way".
4. **Ambiguous 12s timeouts against the crash-looping bridge**: evoFetch status
   0 = "MAY have delivered", the claim is released (route.ts:387-391), no
   whatsapp_messages row is written, so a manual retry legitimately
   double-delivers.

Fix directive (isolated):

- Hybrid pacing lane for cold RFQs: keep the per-sender velocity budget (the
  ban vector - do NOT copy the reply lane wholesale) but allow a small burst
  window of distinct-recipient claims (e.g. 3 within the gap) so multi-shop
  intent is not fully serialized; re-derive the anti-ban budget in
  `wa/pacing.ts` with tests.
- `useRef` in-flight lock at the top of `sendRfq()`.
- Handle `d.duplicate`/`d.reason` explicitly in the client ("Already on its
  way to this shop"); add an `error` field server-side anyway.
- Optimistic UI: on tap, the card immediately shows "queued - leaving in ~Ns"
  from the server's honest response; never a modal lock.
- The ambiguous-timeout double-delivery closes via B4's stable idempotency key.

### Bug 4 - Duplicate shop entries that BOTH wire-send (VERDICT: REVISED-CONFIRMED)

The full verified causal chain:

1. `wa_outbox` has **no unique constraint** on (sender_key, to_number[, kind])
   - only an identity PK (schema.sql:362-374).
2. The initial-RFQ path does a **raw insert with zero pending-row check**
   (guardOutbound's `queue()`, wa-guard.ts:889-900); `parkOutboxOnce` (the one
   dedup primitive) deliberately excludes `kind=rfq` and is never called from
   the outreach route (park.ts:24; only agent-loop.ts:1158, engine.ts:1460).
3. The mass route's dedupe is a **TOCTOU** (one SELECT before the loop,
   in-memory Set, inserts at :317/:345 with no recheck) - its own comment says
   it was written to fix this exact bug.
4. **Why both rows then actually SEND** (the sharpened mechanism): two of the 7
   concurrent drain triggers each atomically claim one duplicate row before
   either writes `whatsapp_messages`; the last-resort `wa_send_claims` PK
   SHOULD catch this, but its slot key hashes the message text - and
   `guardOutbound` re-humanizes `row.body` AT DRAIN with unseeded Math.random
   (wa-guard.ts:876-878, :1459), so the two rows hash to DIFFERENT slot keys
   and both claims succeed. The idempotency primitive is atomic but keyed on an
   unstable identity.

Fix directive (isolated - this is the send-integrity module, shared with B3):

- **DB**: partial unique index
  `wa_outbox (sender_key, to_number) WHERE meta->>'kind' NOT IN ('custom','human-manual')`
  (mirrors park.ts's own exception list), preceded by a one-time duplicate
  cleanup. Enqueue paths switch to upsert-with-body-replace semantics
  (parkOutboxOnce's "newer composition replaces older"), not silent ignore.
- **Humanize exactly once, at enqueue** (same change as B2-2); drain sends
  `row.body` verbatim.
- **Stable idempotency key**: `wa_send_claims` slot key becomes
  `msg:<digits>:<outboxRowId>` (or the sha256 of the CANONICAL pre-humanize
  text carried in meta) - never recomputed from mutated text.
- Extend the drain's per-recipient one-send-per-invocation guard to cold rows
  (wa-guard.ts:1419-1432).
- Client mitigation: dedup queue panel items by vendorId (keep newest).

Verification: concurrency test that races two enqueues + two drains for one
vendor and asserts exactly one wire send; migration tested against seeded
duplicates.

### Bug 5 - TabBar detaches mid-screen (VERDICT: REVISED - primary mechanism corrected)

The adversarial pass REFUTED the obvious theory (containing-block hijack: no
transform/filter/backdrop-filter ever touches html/body/main in ANY state -
verified exhaustively) and confirmed the real trigger:

- **Five uncoordinated naive scroll-locks** each set
  `document.body.style.overflow='hidden'` and restore blindly (Modal.tsx:58,
  Onboarding.tsx:118, WaitGame.tsx:264, PhotoGallery.tsx:25, MapView.tsx:244),
  on top of `html,body{overflow-x:hidden}` (globals.css:76) which forces body
  into an implicit overflow-y:auto scroll box. Toggling overflow on a scrolled
  page while overlays open/close is the documented iOS WebKit trigger for
  `position:fixed` elements rendering at a stale scroll offset - i.e. pinned
  mid-document, exactly the screenshot.

Fix directive (isolated):

- New `src/lib/scroll-lock.ts`: ONE ref-counted lock used by all five callers,
  iOS-safe technique (`body{position:fixed;top:-scrollY;width:100%}` on lock,
  restore + `scrollTo` on unlock). Nested overlays cannot desync restores.
- Hardening (not the fix): portal TabBar (and WillCompanion) to `document.body`
  like Modal already does, with the same `mounted` SSR gate; re-verify the
  z-index ladder (NavVeil 1400 / Onboarding 1300 / Modal 1200 / TabBar 50).
- Optional: explicit `overflow-y` on html/body to kill the implicit scroll box.

### Bug 6 - Notification toggle gives zero feedback (VERDICT: CONFIRMED)

Root cause: `pushState` (page.tsx:152) has no 'pending' value; every failure
mode collapses to 'off' which renders byte-identical to untouched 'idle'
(page.tsx:1794); the subscribe POST response is never read (:228 - a 401 or
`ok:false` still shows "Alerts on"); state is never seeded on mount so a
subscribed user sees the plain button after every reload; iOS-Safari-not-
installed silently no-ops with no "Add to Home Screen" guidance; and no toast
primitive exists anywhere to reuse.

Fix directive (isolated): widen state to
`idle|pending|on|denied|unsupported|ios-install|error`; set pending before the
first await + `LoadingDots` in the button; parse `res.ok && body.ok`; seed from
`Notification.permission` + a server subscription check on mount; iOS
standalone detection -> install guidance; add a minimal app-wide toast mounted
in layout.tsx (z above OfflineBanner 2000, clear of TabBar); surface the
confirmation inline next to the toggle too since the parent panel is
collapsible (page.tsx:1695).

### Bug 7 - Agent never replied to the bicycle-shop redirect (VERDICT: independently re-traced)

The verifier re-traced the whole inbound path itself (the finder's output was
unusable) and found a precise engine defect:

- `extractOffer`'s prompt tags a redirect-to-competitor reply
  ("...try MASCO") as `shopDeclined=true` (agents.ts:1193); the fact persists
  in thread state, so every later turn re-enters the declined branch
  (engine.ts:229, state.ts:165).
- The default graph intends "one warm goodbye, then silence":
  `d-declined-close` (priority 15, legal only while closeCount==0) then
  `d-declined-silent` (16) (default-graph.ts:207-225).
- **The director's 'silent' verdict is UNCLAMPED**: `runDirector` returns
  `{action:'silent'}` straight from LLM JSON with no check against the legal
  edge list (director.ts:196-203), unlike 'act'/'wait-hold' which clamp
  (:240). The LLM can - and did - pick silence over the mandatory
  higher-priority goodbye; `runGraphTurn` then short-circuits with zero
  compose/park/send (engine.ts:678-683). One wrong verdict freezes the thread
  forever.

Fix directive (isolated, ships before the SPTE rewrite):

- Clamp 'silent': if any close-class edge with closeCount==0 is legal, a bare
  'silent' verdict is coerced to that edge (deterministic ladder wins);
  'silent' is only honored when a silent edge is itself the top legal move.
- Add a golden replay case: first-turn decline/redirect MUST produce exactly
  one goodbye message.
- Product upgrade folded into SPTE: a wrong-vehicle/not-offering reply becomes
  a distinct move (`redirect-close`) that thanks them, asks for a referral
  confirmation if one was named, and closes - never silence on first contact.

### Bug 8 - Push says "1125 PHP/day", card says "waiting" (VERDICT: CONFIRMED)

Root cause: the UI is 100% poll-driven and the push channel is one-way to the
OS tray. Server ordering is CORRECT (rows committed before the push fires,
agent-loop.ts:438-550). But: the activity poll (6-15s) skips ticks entirely
while hidden (page.tsx:882) and only seeds a price if the card has none
(:740); the replies poll (6-20s) only runs while `waiting` is true (:931);
`sw.js` never postMessages open clients and `notificationclick` does a full
`client.navigate()` (sw.js:5,31); the built SSE stack is dark end-to-end (no
REDIS_URL, gateway undeployed, zero EventSource consumer anywhere in src/).

Fix directive (isolated, two stages):

- Stage 1 (ships now, legacy web path): `sw.js` push handler postMessages all
  window clients; page listens on `navigator.serviceWorker` message ->
  bumps `syncNonce` (the existing refocus mechanism, page.tsx:865) for an
  instant refetch; `notificationclick` prefers `focus()` when the URL already
  matches; relax the `!base.offer` guard so re-quotes update on the fast
  cadence; poll on `visibilitychange` resume immediately (already exists -
  keep).
- Stage 2 (at GCP cutover): mint `streamToken()` from a new Next API route,
  add a `useSessionStream(searchId)` hook opening EventSource against the
  gateway, merge `offer|state` events into `vendors`; polls demote to
  fallback. The publish side (rival-cache) lights up automatically with
  REDIS_URL.

### Bug 9 - Filters do not filter (VERDICT: CONFIRMED, sharpened)

Four independent verified defects in `page.tsx`:

1. **The budget filter is provably dead code**: `soft(pred)` ORs every
   predicate with `isActiveVendor(v)`; for `maxPricePerDay` the two branches
   are mutually exclusive and jointly exhaustive - the OR is a tautology; the
   filter can never remove any vendor for any input (page.tsx:2370, 2389,
   2401 - contradicting the comment at :2398).
2. **"Dropped price" is a reply counter**: filters `offer.round > 0`, and
   round increments on EVERY applied reply (:1005, :2412) - a shop that
   restates its price twice shows as "dropped".
3. **Map shows all matches, list shows 20**: `MapView vendors={filtered}`
   (:2049) vs `filtered.slice(0, visibleCount)` (:2060).
4. **`scrollToVendor` indexes the wrong array**: computes the reveal window
   against raw `vendors` but the list renders sorted/filtered (:190-203) -
   jump-to-shop silently no-ops under any non-default sort.
   Plus: unknown distance sorts as 0 km = nearest (:2432); latent currency
   mixing in Will's budget parser (will-commands.ts:139) currently masked by
   defect 1.

Fix directive (isolated): budget becomes a hard filter
(`!v.offer || price <= max`) with an explicit product decision on pinning
active-negotiation cards (if pinned, badge them "over budget"); dropped =
`pricePerDay < listPricePerDay`; unify map/list windows (or explicitly label
the map as full-set); rewrite scrollToVendor against `filtered`; distance
fallback Infinity; normalize budget currency at parse time. Add predicate unit
tests for every filter dimension.

### Bug 10 - First-run overwhelm (VERDICT: REVISED-CONFIRMED)

Verified: exactly one render state exists for a signed-in idle user -
`formCollapsed` is false on every first paint (page.tsx:184/:144/:122), so
the full card (textarea + chips + origin + price hint + radius + disclaimer +
CTA + upgrade link) mounts at once, followed by an unconditional AdSense
placeholder (:1939), a dead decorative Will bubble coexisting with the real
draggable WillCompanion (:2124 vs :2275), and up to three upgrade surfaces in
the pre-search session (in-card link :1588, TabBar pill :2317 - suppressed
only during the tour - and Will's typed `open_pricing` path). The 12-step
Onboarding narrates the crowded page; it stages nothing.

Fix directive: this is the anchor for journey Step 2 + feature 4 (section
5.2 / 6.4). Concretely: a staged first-run layout (request panel first,
everything else revealed after intent); one upgrade CTA owner; delete the
decorative Will bubble; suppress AdBanner pre-search; the tour becomes
Will-guided progressive disclosure using the existing data-tour anchor
contract (anchors are load-bearing for Onboarding.tsx - preserve or update in
lockstep).

---

## 4. Architecture: Session Blackboard + Single-Pass Turn Engine (SPTE)

Replaces: the director/edge if-else selection (`graph/director.ts`,
`graph/conditions.ts`, `graph/default-graph.ts` edge inventory), per-node LLM
composition (`graph/nodes.ts`), and the Ops branch-verdict layer.

Preserves untouched (the audit's verified PRESERVE list, F9): the privacy
ingestion gate (`wa/ingest.ts` + `thread-gate.ts`), wa_processed dedupe +
coalescing (`agent-loop.ts`), deterministic guardrails
(`checkOutboundNumbers`, `correctDuration`, hard-constraint decline),
uniqueness + anti-ban pacing/budgets (`uniqueness.ts`, `wa-guard.ts`),
thread-state persistence with optimistic concurrency (`graph/state.ts`),
deterministic price extraction (`wa/price-extract.ts`), persona/voice, the
provider failover (`ai.ts`), and the versioned-config + golden-replay
governance pattern (`policy.ts`, `ops/golden.ts` - re-targeted, see 4.8).

### 4.1 Critical evaluation of the proposed pattern (mandate: do not accept blindly)

**Accepted, with evidence:**

| Proposal | Verdict | Grounding |
|---|---|---|
| Global Session Blackboard | ACCEPT - and it is half-built | `rival-cache.ts` session ZSET/agg/pub-sub (M2) is exactly this; today it is Redis-gated dark on the legacy web path and only consulted at compose time. Promote to canonical, with a Postgres RPC twin so it is LIVE pre-GCP. |
| Single-pass per thread | ACCEPT - the decisive cost/latency win | Today's turn = up to 4 LLM calls (extractOffer -> runDirector -> composeForNode -> judge). One structured pass cuts token spend ~60-75% and removes 2-3 network round-trips. |
| Cross-thread leverage at read time | ACCEPT | `cheapestRivalFor` exists but is Postgres-slow and late; the blackboard makes "Shop B offered 200" a hot read injected into every prompt. |
| Human phrasing + jitter without critic agents | ACCEPT (phrasing in-pass; jitter is already deterministic) | Style directives/persona live in the single pass; typing delays already exist as humanized `not_before` parking - 0 tokens. |

**Refined - where the proposal as written would break production:**

1. **"ReAct" is the wrong loop shape - use a Snapshot-Grounded Single Pass.**
   ReAct's Thought->Action->Observation tool loop reintroduces multi-call
   latency and quota burn (each Observation is another inference round-trip).
   Nothing the agent needs is behind a tool: rivals, floor, benchmark, budget,
   thread digest are all cheap deterministic reads. So the worker PRE-FETCHES
   one context snapshot (1 Postgres RPC + O(1) Redis reads), injects it, and
   the LLM runs exactly once with no tools. Reasoning stays "ReAct-like"
   INSIDE the single pass (a structured scratchpad field), but there is no
   loop.
2. **Numbers never originate in the LLM.** The zero-hallucination mandate is
   enforced by rails, not prompts: deterministic `price-extract` pre-parses
   the inbound and seeds verified numbers INTO the prompt; the benchmark/floor
   arrive as cited facts; and the post-pass guards (`checkOutboundNumbers`
   fabricated-rival/below-floor/inverted-ask, `correctDuration`) reject any
   draft whose numbers do not check out. The engine already has the exact
   precedent: the director's free-text `leverageNote` is discarded and only
   the verified numeric `rivalPrice` reaches composition (engine.ts:709-717).
   SPTE generalizes that rule to every number in every draft. 0 tokens.
3. **Closed move vocabulary, open strategy.** "Zero hardcoded if/else" is
   adopted for STRATEGY, not for SAFETY. The 12 move kinds survive as the
   action space (`bargain`, `answer`, `clarify`, `present`, `close`,
   `deposit-probe`, `fulfillment-probe`, `pickup-location`, `redirect-close`
   (new, B7), `momentum`, `closing-message`, `silent`) because every
   deterministic guard keys on kind (the D-F1 invariant). Cheap policy code
   computes which moves are LEGAL this turn (session closed -> only silent;
   consent missing -> no location share; one goodbye max; bargain-before-
   probes). The LLM chooses freely among legal moves and writes the message.
   Decision trees stop dictating WHAT to say; code only ever says what is
   FORBIDDEN. That boundary is what keeps golden replay, guards and the ban
   budget intact.
4. **The swarm needs write-side propagation, not just read-side.** Reading the
   blackboard fixes cross-thread blindness for the NEXT inbound message; it
   does nothing for Shop A sitting idle when Shop B just dropped to 200. V2
   adds bounded delta propagation: a material lowest-offer improvement
   (>=5% or first offer) enqueues re-bargain wakeups for OTHER threads in
   negotiating state - capped per delta (max 3 threads), min-interval per
   thread (>=20 min), always through the normal pacing/ban budgets. This is
   the "swarm" and it is a scheduler feature (0 tokens), not an agent feature.
5. **Critic agents are replaced by a 0-token judge, with one narrow LLM
   escalation.** Deterministic checks (guards, uniqueness, style validator,
   banned-phrase scrub) always run. An LLM re-check runs ONLY when a draft was
   guard-flagged and auto-corrected in a way that changed a number, or on the
   two highest-stakes kinds (first `bargain`, `close`) - budgeted, and
   skippable under quota pressure.
6. **Multimodal joins the same pass when possible.** Photo turns attach the
   image inline to a Gemini Flash single pass (one call total). Voice notes
   are pre-transcribed by Groq Whisper (free, 2k RPD) - a modality service,
   not a reasoning call - then the turn is a normal text pass. The
   never-silent media fallback (M3) is preserved: media failure -> warm
   text-clarify, not silence.
7. **"Sub-second" is reframed honestly.** Compute is 0.6-3s on the free stack
   (Groq ~sub-second generation; Gemini 1-2s). The wire send then waits a
   DELIBERATE humanized delay (jitter, typing rhythm) which already exists and
   dominates. The SLA that matters: inbound -> reply on the wire in ~30-90s,
   human-plausible and ban-safe; blackboard freshness <1s.

### 4.2 Turn lifecycle

```
Evolution webhook (<200ms ack, token gate, SETNX dedup)        [exists]
  -> ingest privacy gate: isVendorThread / classifyIngest      [exists, PRESERVE]
  -> persist inbound + coalesce unread burst                   [exists, PRESERVE]
  -> PRE-RAILS (0 tokens, deterministic):
       - wa_processed claim (exactly-once)                     [exists]
       - transcribe voice (Groq Whisper) / note media          [exists seam]
       - price-extract: verified numbers from the raw text     [exists]
       - CONTEXT SNAPSHOT: 1 Postgres RPC + Redis blackboard   [new]
       - LEGAL MOVES: policy rails compute allowed move kinds  [new, replaces edges]
       - REFLEX CHECK: if a reflex rule fully determines the
         turn (session closed, duplicate, hold, pure-ack),
         act now with 0 LLM calls                              [new]
  -> SINGLE PASS (<=1 LLM call, model router F/M tier):
       structured JSON out: interpretation + blackboard patch
       + chosen move (from legal set) + message draft +
       digest patch + optional wait plan                        [new]
  -> POST-RAILS (0 tokens, deterministic):
       - schema validation (1 retry, then deterministic fallback composer)
       - checkOutboundNumbers / correctDuration / hard constraints [exists]
       - uniqueness (trigram + Redis sigs) / style scrub / localize [exists]
       - humanize ONCE, seeded (B2/B4 fix)                     [changed]
       - guardOutbound pacing/budget/business-hours            [exists]
  -> blackboard write-back (atomic) + SSE publish              [exists seam]
  -> swarm propagation check (bounded re-bargain wakeups)      [new]
  -> park with humanized delay -> drain -> wire send           [exists]
```

### 4.3 DB schema and single-query context fetch

The audit's confirmed gap (F8): there is NO session table - "session" is
inferred from marker rows keyed by email. SPTE introduces it:

```sql
-- One user search = one session. The blackboard's durable twin.
create table if not exists search_sessions (
  id           uuid primary key default gen_random_uuid(),
  user_email   text not null,
  rfq          jsonb not null,             -- StructuredRFQ
  region_key   text,
  currency     text,
  status       text not null default 'active',  -- active|closed|completed
  benchmark    jsonb,                      -- {pricePerDay,currency,sourceUrl,grounded,fetchedAt}
  lowest       jsonb,                      -- {vendorId,pricePerDay,currency,at} denormalized
  created_at   timestamptz default now(),
  closed_at    timestamptz
);
create index on search_sessions (user_email, status, created_at desc);

-- negotiation_threads (exists) gains:
alter table negotiation_threads
  add column if not exists session_id uuid references search_sessions(id),
  add column if not exists digest jsonb,            -- rolling ThreadDigest
  add column if not exists last_inbound_text text,  -- denormalized for batch status UI (B-status fix)
  add column if not exists last_inbound_at timestamptz,
  add column if not exists last_outbound_text text,
  add column if not exists last_outbound_at timestamptz;

-- Single-query context fetch: ONE round-trip per turn (pg pool max 5 friendly).
create or replace function get_turn_context(p_thread uuid)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'session', (select to_jsonb(s) from search_sessions s
                join negotiation_threads t on t.session_id = s.id
                where t.id = p_thread),
    'thread',  (select to_jsonb(t) from negotiation_threads t where t.id = p_thread),
    'tail',    (select coalesce(jsonb_agg(m order by m.received_at), '[]'::jsonb)
                from (select direction, content_text, media_kind, received_at
                      from whatsapp_messages
                      where thread_id = p_thread
                      order by received_at desc limit 6) m),
    'rivals',  (select coalesce(jsonb_agg(r order by (r->>'pricePerDay')::numeric), '[]'::jsonb)
                from (select jsonb_build_object(
                        'vendorId', t2.vendor_id, 'shop', t2.vendor_name,
                        'pricePerDay', t2.state->'facts'->>'pricePerDay',
                        'currency', t2.state->'facts'->>'currency') r
                      from negotiation_threads t2
                      where t2.session_id = (select session_id from negotiation_threads where id = p_thread)
                        and t2.id <> p_thread
                        and (t2.state->'facts'->>'pricePerDay') is not null
                      limit 3) x)
  );
$$;
```

Blackboard runtime layout (Redis on the VM; the RPC above IS the fallback -
identical shape, one query - so the legacy web path is first-class, not degraded):

```
bb:<sessionId>:offers      ZSET  member=vendorId score=pricePerDay   (exists: rival-cache)
bb:<sessionId>:meta        HASH  rfq-digest, benchmark, lowest, offersIn, bargainedTotal
bb:<sessionId>:thread:<v>  HASH  digest, state, lastMove, lastAt
bb:<sessionId>:events      PUBSUB -> gateway SSE                      (exists)
llm:budget:<provider>:<day> INCR  daily free-tier spend counters      (new, router input)
```

Multimodal storage: `whatsapp_messages` gains `content_text` (transcript/OCR
result) + `media_kind`; binaries live in Supabase Storage refs. The context
snapshot ships ONLY derived text - the model re-sees an actual image only on
the turn that received it (Tier M single pass).

### 4.4 Context window and multimodal strategy

Per-turn prompt budget ~1.6-2.5k tokens in, 350-500 out (fits Cerebras's 8k
cap with 3x headroom, keeps Groq TPM comfortable):

| Block | Size | Source |
|---|---|---|
| System + protocol + persona + style seed | ~450 tok | static, cacheable |
| Session goals: RFQ digest + hard asks + benchmark line (with source) | ~120 | snapshot |
| Rival table (top 3, one line each) + current lowest | ~60 | blackboard |
| Thread digest (rolling, model-maintained) | <=200 | thread.digest |
| Verbatim tail: last 4-6 messages | ~300-600 | snapshot.tail |
| This inbound (+ verified extraction: prices/decline flags) | ~100-250 | pre-rails |
| Legal moves + guard reminders | ~120 | policy rails |
| Media (Tier M only): 1 inline image | provider-side | this turn only |

Pruning rules: history NEVER accumulates - the digest absorbs it. The single
pass returns `digestPatch` (<=60 tokens of new durable facts: quoted price,
vehicle year, deposit terms, tone); rails merge it into `thread.digest`,
capped ~200 tokens with oldest-fact eviction. Voice notes: transcript replaces
audio permanently. Images: extraction result (structured price lines) replaces
pixels after the receiving turn. 10 parallel threads never share a context
window - each turn sees its own thread + the 3-line rival table; the
blackboard IS the compression of the other 9 threads.

### 4.5 Production TypeScript interfaces

```ts
// packages/core/spte/types.ts  (canonical: src/lib/spte/types.ts, re-exported)

export type MoveKind =
  | "bargain" | "answer" | "clarify" | "present" | "close"
  | "deposit-probe" | "fulfillment-probe" | "pickup-location"
  | "redirect-close" | "momentum" | "closing-message" | "silent";

export interface SessionSnapshot {
  sessionId: string;
  rfq: StructuredRFQ;                       // existing type
  currency: string;
  benchmark: { pricePerDay: number; currency: string; sourceUrl: string;
               grounded: true; fetchedAt: string } | null;   // grounded=false never enters a prompt
  lowest: { vendorId: string; shop: string; pricePerDay: number } | null;
  rivals: Array<{ vendorId: string; shop: string; pricePerDay: number; currency: string }>;
}

export interface ThreadDigest {
  facts: string[];                          // <=10 durable one-liners
  quotedPricePerDay?: number;
  round: number;
  tone?: "friendly" | "curt" | "eager" | "reluctant";
}

export interface TurnContext {
  session: SessionSnapshot;
  thread: { threadId: string; vendorId: string; shop: string;
            digest: ThreadDigest; state: NegotiationThreadState };
  tail: Array<{ dir: "in" | "out"; text: string; at: string;
                media?: "image" | "voice" | "location" }>;
  inbound: { text: string; verified: VerifiedExtraction };   // from price-extract
  legalMoves: MoveKind[];                    // policy rails output - the ONLY moves the pass may pick
  guards: { floorPerDay?: number; maxRounds: number; neverScheduleTimes: true };
}

export interface TurnArtifact {              // the single pass's entire JSON output
  read: { intent: string; priceMentioned?: number; declined?: boolean;
          wrongVehicle?: boolean; askedLocation?: boolean };   // interpretation
  think: string;                             // <=80 tok scratchpad - logged, never sent
  move: MoveKind;                            // MUST be in legalMoves (validated)
  message?: string;                          // the draft (absent for silent/wait)
  counterPricePerDay?: number;               // guards verify against floor/quote/rival
  leverageUsed: Array<"rival" | "benchmark" | "duration-volume" | "condition">;
  digestPatch: string[];                     // <=3 new durable facts
  waitMinutes?: number;                      // strategic wait -> scheduler
}

export interface RailResult {
  ok: boolean;
  finalText?: string;                        // post guards + uniqueness + humanize-once
  rejected?: { rule: string; detail: string };
  escalate?: boolean;                        // triggers the narrow LLM re-check
}

export interface ModelRoute {
  tier: "F" | "M";
  provider: "groq" | "gemini" | "cerebras" | "openrouter";
  model: string;
  reason: "default" | "multimodal" | "high-stakes" | "quota-overflow";
}
```

### 4.6 BullMQ worker boilerplate

```ts
// services/workers/src/turn.worker.ts
import { Worker, UnrecoverableError } from "bullmq";
import { getTurnContext } from "@wheeldeal/db";          // the 1-RPC snapshot
import { blackboard } from "@wheeldeal/redis";           // atomic ops + RPC fallback
import { legalMovesFor, reflexTurn } from "@wheeldeal/core/spte/policy";
import { runSinglePass } from "@wheeldeal/core/spte/pass";     // router + schema-validated call
import { runPostRails } from "@wheeldeal/core/spte/rails";     // guards+uniqueness+humanize-once
import { parkOutbound, scheduleWakeup, propagateDelta } from "@wheeldeal/core";

export const turnWorker = new Worker("incoming_message_queue", async (job) => {
  const { threadId, inbound } = job.data;

  // PRE-RAILS - all deterministic, all free
  const ctx = await getTurnContext(threadId, inbound);       // RPC + price-extract inside
  ctx.legalMoves = legalMovesFor(ctx);                       // policy rails, not strategy

  const reflex = reflexTurn(ctx);                            // Tier R: 0-token resolution?
  if (reflex) return await applyReflex(ctx, reflex);         // park/silence/hold + state save

  // SINGLE PASS - the turn's only LLM call. Schema-validated; one retry on
  // malformed JSON; then the deterministic fallback composer (never throws).
  const artifact = await runSinglePass(ctx, {
    route: pickRoute(ctx),                                   // F: groq->gemini-lite->cerebras; M: gemini-flash
    onQuotaExhausted: "fallback-composer",
  });
  if (!ctx.legalMoves.includes(artifact.move))
    artifact.move = coerceToLadder(ctx);                     // B7 lesson: NEVER trust an unclamped verdict

  // POST-RAILS - deterministic guards; a rejected draft falls back, never sends broken
  const rail = await runPostRails(ctx, artifact);
  if (!rail.ok) return await applyFallback(ctx, artifact, rail);

  // COMMIT - optimistic-concurrency state save (existing state.ts), blackboard, schedule
  await saveThreadTurn(ctx, artifact, rail);                 // state + digest + denorm last-in/out
  const delta = await blackboard.recordOffer(ctx, artifact); // atomic ZADD+HSET+publish
  if (artifact.waitMinutes) await scheduleWakeup(threadId, artifact.waitMinutes);
  if (delta.materialDrop) await propagateDelta(ctx.session, delta);  // bounded swarm re-bargain

  if (rail.finalText)
    await parkOutbound(ctx, rail.finalText, humanDelayMs(ctx)); // jitter lives here, 0 tokens
}, { connection, concurrency: 10 });

turnWorker.on("failed", async (job, err) => {
  if (job && job.attemptsMade >= (job.opts.attempts ?? 5))
    await sendToDlq("incoming_dlq", job, err);               // existing DLQ pattern
});
```

Failure ladder (every rung free): malformed JSON -> 1 schema retry -> provider
rotate -> deterministic fallback composer (`composeBargain fallback:true`
class) -> if even parking fails, BullMQ exponential backoff -> DLQ + alert. A
turn can degrade in eloquence; it cannot go silent (M3 invariant) and it
cannot send an unguarded number.

### 4.7 Cross-thread swarm propagation

`propagateDelta` fires when the session's lowest offer improves >=5% (or first
offer lands): select up to 3 sibling threads in `negotiating` state with
`lastMove` older than 20 min, enqueue `re-bargain` wakeups (jittered 2-10 min)
that re-enter the normal turn pipeline with a synthetic
`event: rival-improved` - the single pass then composes "another shop just
offered X" leverage with the VERIFIED number from the blackboard. All sends
still cross the pacing/ban budgets; propagation is bounded per delta and per
thread per hour. Kill switch: `SWARM_PROPAGATION` config key, default on.

### 4.8 Determinism, golden replay, Ops Center replacement

- Every turn logs its full `TurnArtifact` + `ModelRoute` + rail outcomes to
  `agent_events` (existing table) - the negotiation is fully replayable.
- **Golden replay re-targeted**: `replayConversation` keeps its contract
  (llmAllowed:false, frozen clock, pinned overlay); with LLM off, the pass is
  replaced by pinned artifacts (recorded fixtures) and the reflex/fallback
  ladder. GoldenExpect keys migrate from edgeId -> `{move, leverageUsed,
  priceBounds}`. The B7 goodbye case and the D-batch guard cases are the first
  new goldens. The empty-suite-passes-trivially hole (F9 risk) closes: minimum
  golden-case count enforced before any SPTE config activates.
- **Ops Center**: branch verdicts die with the branches. Owner review now
  rates TurnArtifacts (read/think/move/message quality); `ops_learning`
  re-keys its priors and exemplars on `MoveKind + tactic` instead of edge ids
  (the audit flagged the stale-edge-id silent-invalidation risk); the policy
  overlay (clamped thresholds) and `saveVersionedSpec` versioning stay the
  single write chokepoint for anything that changes behavior.

### 4.9 Migration plan (no big bang)

1. Ship `search_sessions` + `get_turn_context` + blackboard RPC twin; back-fill
   session ids for active threads. The graph engine keeps running.
2. Ship SPTE behind `ENGINE_V3=off` config; wire the golden fixtures; run the
   replay suite on both engines against the same recorded conversations
   (parity report in admin).
3. Flip `ENGINE_V3=on` for TEST_MODE testers; watch artifacts in Ops; then
   default-on with the graph engine as the documented rollback
   (`saveVersionedSpec` one-click).
4. Delete director/nodes/conditions/default-graph edge inventory once V3 has
   run N clean days; simulate.ts playground re-targets the single pass.

---

## 5. Core user journey rebuild

### Step 1 - Pairing and privacy protocol

- Pairing reliability = Bug 1 fix (above) + Evolution stabilization.
- Privacy isolation is ALREADY enforced at the correct layer and survives V2
  untouched (audit-verified): a non-vendor chat is dropped by
  `classifyIngest`/`isVendorThread` BEFORE any persist (ingest.ts:229-245,
  thread-gate.ts:20-60) - only agent-anchored threads (RFQ outbound within 14
  days) or a 3h drill window are ingestible. V2 additions: a plain-language
  privacy card in the pairing UI stating exactly this filter; a golden
  ingest-gate test pinning "personal chat never persists"; keep the drill
  window from widening (F9 risk).

### Step 2 - Tap-to-build request panel (zero typing)

Current truth (F2): composer is 100% free-text -> LLM profiler; a
deterministic parser (`heuristicRFQ`) exists but is private and LLM-failure-
only; 11 of 17 RFQ fields are never shown to the user; `vehicleLabel`
hardcodes transmission by vehicle class (labels.ts:6 - a real correctness
bug); `durationDays` is accepted by the API but never sent by the client.

Build plan:

1. `src/components/RequestBuilder.tsx` - a stepped chip carousel under the
   free-text field (both always available; panel state serializes into a
   `Partial<StructuredRFQ>`):
   vehicle (Car | Scooter/Motorbike) -> transmission (if two-wheel) ->
   engine cc tier (110/125/150/155/160/200/300+) or car class ->
   duration stepper -> LOCK bar appears -> optional extras (helmets stepper,
   mileage cap, delivery vs pickup, custom ask free-chip).
   Every step optional beyond vehicle+duration; lock is always one tap away.
2. `/api/profile` gains `structured: true` mode: builds the RFQ
   deterministically (export `normalizeRFQ`/`heuristicRFQ` or a new
   `deterministicRFQ()`), reusing clampDuration + cheapest-by-default rules so
   the two paths never diverge - and **skips the 9s LLM call entirely** (a
   Tier R win: a fully-tapped request costs 0 tokens).
3. Fix `vehicleLabel()`/`vehicleTerm()` to read real `rfq.transmission`.
4. The post-search chip strip becomes editable and surfaces the hidden fields
   (transmission, helmets, mileage, dates, notes) - what the user sees is
   exactly what shops are asked.
5. Wire `durationDays` from the stepper through the POST body.

### Step 3 - Shop cards, Maps-language icons, branded target price

- **Icons** (F3): the app has a bifurcated system - ~35 real SVG icons plus
  ~20+ scattered emoji literals, and Leaflet markers are raw HTML strings.
  Plan: extend `icons.tsx` into the single registry (Material-Symbols-style
  outlined glyph language - the Google Maps *visual language*; the literal
  proprietary Google assets cannot be shipped); replace emoji literals in
  VendorCard/Tracker/ThreadPeek/labels; rewrite `priceIcon()/stayIcon()` with
  `renderToStaticMarkup` of registry glyphs (teardrop pin, price pill); factor
  the duplicated VendorCard/MapView ShopCard badge row into one shared
  component so map and list can never diverge again.
- **Branded target price** (F5): the grounding call exists (`chatGrounded`,
  the stack's only live-web retrieval) but its source URLs are discarded and
  an ungrounded LLM guess gets the same `source:'ai'` tag - failing the
  no-hallucination rule today. Plan: extend `market_floor_prices` with
  `source_url, fetched_at, grounded`; capture `grounded.sources` and REJECT
  ungrounded numbers from ever being displayed or cited; keyed by (region,
  vehicle_key, duration-band); per-shop **Target price band** on VendorCard
  ("Market target: ₱180/day - grounded from <domain>") with a "researching
  local rates..." state on cold areas (the refresh is fire-and-forget by
  design); the single pass receives the benchmark ONLY when `grounded:true`
  and cites it as leverage together with the 4+ day volume pitch
  (`duration-volume` leverage, already a directive seam in composeBargain).

### Step 4 - Dispatch, status panel, map sync, activity

- Dispatch mechanics = B3/B4 send-integrity module.
- **Status screen** (F4): the client currently N+1-polls `/api/thread` per
  card while the only batch endpoint carries no text. Plan: extend
  `/api/activity`'s existing vendorStates rollup (it already fetches the rows)
  with `lastInboundText/At`, `lastOutboundText/At` per vendor - one response
  powers the whole panel: shop | last shop message | last agent message |
  state chip. ThreadPeek demotes to on-expand transcript fetch. The
  denormalized thread columns (4.3) make this query trivial post-SPTE.
- **Map sync**: map and list already consume one `filtered` array - the
  divergence is the render window + filter defects; fixed in B9. The shared
  badge component (step 3) completes card<->pin parity.
- **Activity redesign**: grouped per-shop highlight cards (best offer, last
  event, next planned move from wakeups) on top, collapsible chronological
  log below - the data is all in the existing `/api/activity` payload;
  this is presentation, not new plumbing.

### Step 5 - Agentic negotiation behavior

All strategy behavior lands in SPTE (section 4). Protocol rules encoded as
POLICY RAILS (deterministic, 0 tokens):

- **Never finalize pickup/delivery time**: a new outbound guard
  (`timeCommitmentGuard`) rejects drafts matching concrete time-agreement
  patterns; the `close`/`closing-message` templates already carry "our user
  will confirm the exact time directly" - now enforced, not just prompted.
- **Live-location protocol**: preserved M5 gate (`resolveShareableLocation` -
  coords only with explicit consent). When a shop asks mid-session, the move
  is `pickup-location` -> if no consented stay exists, the app pushes a
  real-time consent prompt (existing awaitingUserLocation flow + B8's push->
  page channel) and the agent sends a holding line - never coordinates.
- **Edge cases as first-class moves**: out-of-stock -> `clarify`
  (alternatives?) or `close`; wrong-vehicle/bicycle-shop -> `redirect-close`
  (B7); no-price-given -> `clarify` with one repeat max; vehicle-condition
  check (`condition` leverage: year/condition question before locking).
- Rival leverage, benchmark leverage, duration-volume pitch: injected as
  verified numbers only (4.1-2).

### Step 6 - Deal closure and hand-off

Current truth (F8): the server-side hard-stop is real and thorough
(close-deal route purges outbox, clears wakeups, tombstones every recent shop,
stamps session-closed; the engine goes silent per-turn via the highest-
priority rule) - but the CLIENT is never reset, BookingSheet mislabels
failures as "queued" (no res.ok check, BookingSheet.tsx:142), the hard-stop
logic is duplicated in two routes, and `/api/contact` (the wa.me resolver) is
dead code.

Build plan:

1. Factor one `stopSession(email, sessionId, reason)` helper used by both
   close-deal and session-close (drift kill).
2. BookingSheet: check `res.ok`/`d.reason`; distinct blocked/failed states.
3. On confirmed deal: client resets to a **"Trip locked" view** (mirrors
   `clearSearch()`'s state reset): chosen shop card + final price + the
   deep-link CTA - "All set! All that's left is to contact the shop directly
   to schedule your exact pickup/delivery time." -> `wa.me/<shop>` (revive
   `/api/contact`).
4. The final acceptance WhatsApp message is the existing `closing-message`
   move (kept), which already embeds the user-will-confirm-time language.
5. `search_sessions.status='completed'` becomes the single truth the UI,
   ingest reflex (silent), and analytics all read - replacing marker-row
   inference.

---

## 6. Platform features

### 6.1 Blur-locked search screen

Gate `Find deals` behind WhatsApp pairing: when `waStatus !== 'connected'`,
the search card renders under a `backdrop-blur` veil (CSS blur + dim, content
non-interactive via `inert`) with a single centered CTA - "Pair WhatsApp to
start finding deals" -> WaConnect sheet. Implementation: one `LockVeil`
component wrapping the card in page.tsx; state already available
(`waConnected`). Ties into B10's staged first-run: pre-pairing, the ONLY
actionable element is pairing. (Note: the blur is a UX gate; the API already
refuses unpaired sends server-side - keep both.)

### 6.2 Apple Pay / Google Pay

Verified (F7): billing is server-side PayPal REST subscriptions + full-page
redirect; no JS SDK anywhere; no `.well-known` directory; the webhook grant
path is funding-source-agnostic (zero changes needed there).

Two-track plan:

- Track A (zero code, do first): enable wallet funding sources for the Live
  app in the PayPal Business dashboard - wallets then appear on PayPal's own
  hosted approval page where eligible. OWNER VERIFICATION REQUIRED (cannot be
  determined from code): Israeli-merchant wallet eligibility, and whether
  PayPal Subscriptions (vs one-time Orders) support Apple Pay/Google Pay at
  all in this account.
- Track B (embedded buttons on UpgradeSheet, only if A is insufficient):
  PayPal JS SDK (`components=buttons,applepay,googlepay`) with a new
  deliberately-public `NEXT_PUBLIC_PAYPAL_CLIENT_ID` (client ids are
  non-secret by design - explicit exception to the vault convention, called
  out in review); Apple domain-association file at
  `public/.well-known/apple-developer-merchantid-domain-association`
  (middleware matcher verified clear of it); checkout route gains a
  client-token response mode alongside the redirect fallback (graceful-degrade
  rule). Add a `funding_source` column to `billing_events` so adoption is
  measurable.

### 6.3 Remove My Deals, split Profile, new section

Verified removal checklist (F6 - all 8 touchpoints, missing any leaves a dead
link, broken Will command, or failing test): `deals/page.tsx` +
`api/deals/route.ts` (preserve its session-aggregation logic for the new
Trips view) - TabBar Tab union + items - page.tsx onSelect branch -
`useWill.ts` open_deals case - `will-commands.ts` union + regex + WillSheet
QUICK chip - `middleware.ts` matcher - profile's two /deals links -
`hardening-invariants.test.ts` scanned-file list (+ check
`/api/will/route.ts`'s LLM tool schema for open_deals references).

Profile splits along the audit's natural seam:

- **Profile tab** (traveller): identity/phone, stay + LocationConfig,
  currency, travel prefs, appearance.
- **Account sheet** (from a gear icon): WhatsApp connection, password, legal,
  sign-out, owner tools (brand kit + co-manager, owner-gated).
- **New 4th tab: "Trips"** (replaces My Deals): booking history (re-homed
  from Profile), the Step-6 "Trip locked" hand-off cards, and the natural
  future home for trip-mode/handover-checklist features. It reuses
  `api/deals`' aggregation - repurposed, not deleted. Profile gets a TabBar
  at last (today it has none - audit-verified gap).

### 6.4 Will as the integrated funnel companion

Verified inputs (F6/B10): WillCompanion is draggable chrome that on non-home
routes hard-redirects to `/?will=1`; a second decorative non-interactive Will
bubble coexists pre-search; Onboarding's data-tour anchor system already
covers the funnel and is load-bearing.

Plan: retire the floating widget as primary. Will becomes a **docked stage
bar** directly under the active funnel section (one line + avatar, expandable
to the WillSheet): stage-aware guidance driven by the existing app state
(pre-pairing -> "let's link WhatsApp"; composing -> field nudges from the
RequestBuilder state; dispatched -> "3 shops asked, first replies usually
~10 min"; offer in -> "this is 12% over the market target - want me to push?"
wired to real blackboard data; deal -> hand-off explainer). The decorative
bubble dies; the 12-step tour collapses into these contextual moments
(progressive disclosure, B10). WillSheet/useWill command layer stays; new
`explain_state` command surfaces "why did my agent do that" from the
TurnArtifact log - Will becomes the user-facing window into the SPTE brain.

---

## 7. Execution plan

Ordered for production pain, each module independently shippable and gated.

| Module | Contents | Gate |
|---|---|---|
| **V2-0 STABILIZE** (P0) | Evolution crash-loop ops fix; B1 pairing; B3+B4 send-integrity (unique index, humanize-once, stable claim key, hybrid lane, ref lock, honest duplicate toast); B7 silent-clamp + golden; B5 scroll-lock | typecheck x3, vitest, live pairing drill, race test: 2 taps + 2 drains = 1 send |
| **V2-1 TRUTH & SYNC** | B8 stage 1 (sw postMessage, focus, re-quote guard); B9 filter rewrite + tests; B6 notification states + toast primitive; B2 composer rewrite + seeded humanize + region pools; batch status endpoint (step 4) | vitest incl. new pins; manual desync drill |
| **V2-2 REQUEST & FIRST-RUN** | RequestBuilder + deterministic RFQ path; vehicleLabel fix; blur-lock veil; B10 staged layout; Will docked bar v1 | build, mobile 320-430px sweep, tour anchors intact |
| **V2-3 BENCHMARK & VISUAL** | Grounded benchmark (schema + capture + reject-ungrounded + card band + leverage line); icon registry migration; shared card/pin badge component; Activity regroup | vitest; grounded-only display test |
| **V2-4 SPTE** | search_sessions + RPC + blackboard twin; policy rails + reflex tier; single pass + model router + budget counters; post-rails; swarm propagation; golden re-target; Ops artifact review; ENGINE_V3 staged rollout | parity replay report; golden suite non-empty; quota budget sim |
| **V2-5 CLOSE & NAV** | Step-6 closure UX + stopSession helper; My Deals removal (8-point checklist); Profile split + Trips tab; Will explain_state | vitest incl. hardening-invariants update |
| **V2-6 WALLETS** | Track A owner verification; Track B if needed | sandbox checkout drill |

Standing verification for every module: `npm run typecheck` x3 (root, gateway,
workers) + full vitest + `next build`; golden replay for anything touching the
engine; push work branch then fast-forward production. GCP cutover (task #127)
stays a parallel owner-run track; nothing above depends on it except B8
stage 2 and the Redis-native blackboard acceleration - both designed to light
up automatically at cutover.

---

## Appendix - audit source

Full structured findings (10 bugs incl. adversarial verdicts + 9 area maps)
are preserved in the session workspace (`bugs.json`, `features.json`,
workflow `wf_72bd78c4-93c`). Anchors cited in this document were re-verified
character-for-character by the verifier agents against commit `07ceaae`.
