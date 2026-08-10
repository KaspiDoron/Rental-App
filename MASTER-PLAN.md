> # STATUS: TIERS 0 AND 1 SHIPPED - PART 12 IS THE NEW WORK
>
> Published to the repo root as `MASTER-PLAN.md`, branch
> `claude/rental-agents-legal-setup-o7rgcv`, and re-published with this header
> (Part 10).
>
> **Shipped, on branch, gate green on every commit** (typecheck x3, build, 3,550
> tests): all of **Tier 0** (0.0-0.75) and all of **Tier 1** (1.0-1.6) from Part
> 9.10 - the device fingerprint, the origin resolver, the restriction and
> dead-session detectors, the answerable opener and `openNow` ordering, the
> fail-dark contract, the false-safety-string deletion, the intro/reply lane
> split, the reconciled capacity numbers, the tail-canonicalised recipient ledger
> and the two-meter unanswered budget.
>
> **Also shipped since the pivot:** C.0.1 (the discount is gone, one price
> source - which uncovered that `plans.ts` had been under-reporting the real
> charge by ~3x), **Part 12.3** the warm-up gate end to end, **Part 9.4** the
> cohort primitive with the warm-up holdout, **Part 12.4.1** the monetization
> and lifecycle dashboard (Admin -> money), and **Part 12.10 W0** the WABA flag,
> adapter boundary and dry-run mode - shipping OFF, with the "nothing changes
> while the flag is off" invariant pinned by test.
>
> **Part 12 W1-W3 shipped too:** the lead ledger and state machine
> (`waba/leads.ts`), the admission decision and fallback ladder
> (`waba/dispatch.ts`), the **inbound expectation gate** (`waba/expectation.ts`)
> that resolves conflict 12.9(1) without loosening the privacy gate, the
> authenticated provider webhook, and the one-tap handoff link with its tap
> ledger. All behind the flag, all dry-run by default.
>
> **Part 12 W4-W6 and Tier 4 shipped:** the four-budget governor with the
> emergency stop, the Business Platform console (Admin -> wa business), the
> fourth consent for sharing the traveller's number, the blocking `wa_link`
> consent write that now refuses to issue a pairing code it cannot record, and
> the severable liability cap replacing the "zero (nil)" exclusion.
>
> **Part 11 F1 shipped and WIRED** (`wa/waves.ts`): the wave scheduler, with the
> finding that a full 24-shop batch runs 55-105 minutes rather than "about an
> hour" - and both halves of the schedule are now expressed. `waveEndsAt` is
> stamped onto every outbox row the mass route writes, and the drain clamps
> every re-stamp to it through one closure, so a burst can no longer bleed
> across its own silence. Deliberately NOT applied to `guardOutbound`'s own
> re-park: the clamp only ever moves a time earlier, and that path carries
> safety holds that must never be released sooner.
>
> **Part 11 F4 shipped** (`lib/progress.ts` + `BatchProgressBar`): the
> two-segment bar, derived ONCE on the server from the same authoritative rung
> every card reads, with three honest stop states and a bar that can never read
> 100% while a negotiation is live. Segment 2 resolves against shops *reached*,
> not shops selected.
>
> **Tier 3 observability shipped:** `wa_risk_events` (22 kinds, two axes kept
> apart from the first write, `noteRisk` that cannot throw), the eight hooks that
> fill it, `fleetTruth()` (six answers out of one response per host, including
> dual-socket and deaf-session detection), the hourly rollup with dark buckets,
> the **Ban Risk panel** (Admin -> risk) with meter integrity rendering first,
> and `wa_policy_versions` so every anti-ban knob change carries an author and
> its previous value.
>
> **Tier 2 ($0 items) shipped:** the proxy layer rebuilt around one residential
> gateway template with a per-user sticky token on `wa_sessions.proxy_session_id`
> (minted once, survives `/instance/delete`), the mod-hash pool retired,
> `/proxy/set` verification recorded to `proxy_verified_at`. The paid items
> (2.5/2.6) stay cut. `EVOLUTION_PROXY_REQUIRED` deliberately not built.
>
> **Tier 3 transport tiles shipped:** the Ban Risk panel now has a Transport
> section reading `transportSummary()` - "not configured" is a neutral
> first-class state, an unreadable session table reads UNKNOWN.
>
> **Wave C started:** I-6c (RTL applied before first paint + mirrorable wizard
> arrows), I-6b (every translation validated before it reaches the shared cache -
> null/placeholder/brand/length, "Will" now on the do-not-translate list), and
> I-6a (the exact-key `getConfigExact` reader that finally makes the I18N cache
> readable - it was write-only, re-translating the whole catalogue every cold
> load).
>
> **Not started:** the rest of Wave C (M3 all-vehicle classes, M8/9/24 date
> gating + summary header, M10 dual-axis scroll, M11/M14, M23 wire-format
> upgrade), Part 11 **F2** (agency scanner - blocked on a data-collection window
> at n>=8 per shop), and Part 12 **W7** (live validation - blocked on real
> provider credentials).
>
> **Part 12 supersedes** Wave C.0.2 (the 50% discount is cancelled outright),
> Part 11 F3's days-based unlock rule, and Part 8's Tier 2.5/2.6. Each of those
> carries an in-place correction marker pointing to it, as do Part 0.37's
> "official platform is closed" verdict and Part 7.9's roster mechanism.

---

# WheelDeal.pro - Ultimate System Scale: master execution plan

> Supersedes the previous 28-module plan (its Waves 1-4 are shipped and live on
> master at `685b638`; see the appendix). Prior file preserved at
> `before-everything-launch-your-wondrous-steele.prev.md`.

---

# CONTEXT - why this plan exists

The app is not working and there are no users yet. That second fact is what makes
this plan possible: nothing here has to be backward compatible with a live user
base, no migration is needed, and there is no one to disclose anything to. The
job is to make the product actually do what it claims, once, correctly.

Eight incidents were observed on the live deployment. One of them - the WhatsApp
restriction - is not a bug at all; it is a product setting doing exactly what it
was written to do, and it has to be reversed. The other seven are defects. Around
them sit 25 modules of product work from the master directive.

Three owner decisions are already made and are treated as fixed constraints
throughout:

1. **100% in-app automation is non-negotiable.** No `wa.me` deep links, no
   tap-to-send, no handing the user to the native WhatsApp app. The entire
   workflow is zero-touch server-side dispatch. Any design that requires the
   traveller to press send is out of scope and is not discussed again below.
2. **Shops have raw WhatsApp numbers and nothing else.** No contact forms, no
   Google Business Messages, no websites, in Southeast Asia, India and South
   America. Any "submit the enquiry through the shop's own intake channel"
   design is detached from reality and is out of scope.
3. **Leave the cold-outbound path exactly as-is from the user's point of view.**
   No opt-in gate, no risk-disclosure screen, no consent checkbox. There are no
   users; the correct move is to fix the mechanism, not to warn about it.

**SLA target: 30-60 minutes end to end** - outreach sent, replies processed,
negotiations handled, quotes ready.

---

# PART 0 - THE BAN, AND THE FOUR HARDENING VECTORS

## 0.1 Root cause of the restriction (verified first-hand, `src/lib/wa/capacity.ts`)

| plan | new chats per window | window | per hour |
|---|---|---|---|
| free | 10 | 6h | 10 |
| pro | 30 | 4h | 30 |
| ultra | **40** | 3h | 40 |

Four more shipped facts from the same file and its neighbours:

- `BATCH_WINDOW_MINUTES = 15` (`capacity.ts:77`) - the whole introduction batch
  is *promised* on the wire inside 15 minutes.
- `effectiveNewContactCap(plan, _ageDays, _warmupDays)` **ignores account age
  entirely** - both parameters are prefixed `_` because they are unused
  (`capacity.ts:115-121`). Its own doc comment: *"A brand-new ultra user gets all
  40 conversations at once."*
- `warmupFactor` floors at **0.85 on day 0** (`capacity.ts:105`), with the reason
  in the comment: *"that is the owner's explicit requirement: full budget usable
  day 0"*.
- `fast_dispatch: true` **by default** (`wa-guard.ts:157`), which its own comment
  says *"lifts BOTH the clock gate AND the Google 'closed now' park for COLD
  intros, so a search fires immediately regardless of shop hours"*.

Together: **a day-0 WhatsApp number can open 40 cold chats with unsaved business
numbers inside 15 minutes, at 3am.** Meta's restriction notice names the trigger
exactly - you may still *reply* and keep messaging existing chats, you may not
*start new chats*. That is the one action the capacity table is tuned to
maximise.

The anti-ban implementation did not fail. It was configured, deliberately and on
the record in its own comments, to do the thing that triggers this restriction.
Message paraphrasing and typing simulation cannot fix it, because neither is what
is being measured.

## 0.2 The four hardening vectors

Server-side automated dispatch stays. It gets rebuilt around volume, pacing and
variation - the things that actually move the measured signal.

### Vector 1 - Dynamic wave / staggered pacing
New `src/lib/wa/waves.ts` sits **above** the existing `batchStagger()`
(`src/lib/wa/pacing.ts:126`) rather than replacing it - `batchStagger` already
schedules to a deadline and enforces `HARD_MIN_GAP_SEC = 8`, and a second
scheduler is how one call site keeps the old behaviour.

```
planWaves({ total, ageDays, velocity24h, trust, rand }) -> Wave[]
Wave = { index, size, startOffsetMs, spanMs }
```

- `size` drawn 5-8, `gap` drawn 8-12 min, both shaped by `gaussianUnit()`
  (already in `pacing.ts`) so the gaps form a bell rather than a flat band.
- Vector 4 supplies the parameters: a fresh or hot number gets 5 shops every
  12 min; an aged, well-answered number gets 8 every 8 min.
- Inside a wave, `batchStagger({count: size, hourCap, gapSec, windowMs: spanMs})`
  is called unchanged, with `spanMs` about 60% of the wave gap - so each wave is
  a short burst followed by real silence, which is what a person looks like.
- The schedule is **persisted onto the outbox rows at enqueue time**
  (`not_before`), never held in memory. Cloud Run throttles CPU to zero the
  instant the response flushes, so an in-request timer spanning 60 minutes
  cannot exist.

**Correction from the verify pass, and it matters.** The first read of this said
the wave layer belongs at `mass/route.ts:205` where `batchStagger` runs. The
refuter showed that is only half true: `offsets[]` sets a row's *initial*
`not_before` floor, but the **authoritative pacer for cold intros is the drain**
(`wa-guard.ts`), which selects on `not_before <= now` and then applies its own
per-sender ceiling - one send per `min_gap_seconds` (default 12 s), enforced
twice, plus a 2-cold-rows-per-invocation limit that re-stamps the rest
`+2-4 min`. A wave schedule written only at enqueue would be reshaped by the
drain on first contact. So the wave must be expressed in **both** places: the
enqueue-time floor, and a wave-aware admission rule in the drain. Building it in
one place is the failure mode to avoid.

`BATCH_WINDOW_MINUTES` changes meaning from "the whole batch" to "the first
wave", and gains a companion `estimateBatchCompletion(waves)` for an honest ETA.
Every reader of it - including UI ETA copy - changes together.

### Vector 2 - High-entropy paraphrasing (zero identical or near-identical sends)
This is the vector the verify pass changed most, and mostly by **shrinking** it.
The first read called it a P0 with three compounding failures. Two of the three
did not survive:

- *Refuted:* "eight paths bypass the gate, including SPTE." Every `auto` send
  already passes through a universal per-recipient variance layer -
  `stripWaFormatting(humanizeVariant(personaHumanize(...)))` at
  `wa-guard.ts:1041-1044`. Messages are not going out identical.
- *Refuted:* "the gate hashes text that is never sent, so move it after
  humanization." The ordering is deliberate and is the only one under which the
  gate can function - humanization is seeded per recipient, so hashing its output
  would make every message trivially unique and the check meaningless.
- *Refuted:* "build a Supabase signature window." That storage **already ships**:
  `recentOutboundGlobal` (`graph/engine.ts:1748-1757`) reads cross-user outbound
  bodies from `whatsapp_messages` in Supabase.

What survived is real but narrower - **a caller-wiring gap, not a storage or
architecture gap**:

1. The Redis ZSET layer genuinely is dead in production (`hotStateClient()`
   returns null with `REDIS_URL` unset, memoised, `rival-cache.ts:49-55`). It is
   not the only layer, so this is degradation rather than absence.
2. `src/app/api/outreach/route.ts:289` calls `ensureGloballyUnique(compiled, [])`
   with an **empty** recent list, while the graph engine feeds the same function
   a real corpus. The cold-outreach routes are simply not passing the history
   that already exists.
3. The deterministic matrix's ceiling is roughly **10,800 distinct skeletons**,
   and `SENTENCE_ORDERS` (`matrix.ts:213`) has only 5 entries.

So the work is:

- **Wire, do not build.** Pass `recentOutboundGlobal`-style history into
  `ensureGloballyUnique` on both cold routes instead of `[]`. No new table, no
  new schema.
- **Grow the pools** so the structural ceiling rises without an LLM.
- **LLM paraphrase for the cold opener**, with the deterministic matrix as the
  always-available fallback (new `src/lib/copy/paraphrase.ts`). Paraphrase output
  is untrusted, so it runs **before** the rails - `deAmbiguateFree` /
  `personaHumanize` (`persona.ts`), `checkCommitment` / `stripCommitment`
  (`spte/rails.ts`), the numeric provenance guard - and the existing uniqueness
  gate keeps its current position rather than moving.

### Vector 3 - Human behaviour simulation
Partly built, and materially worse than it looks. Three findings, all verified:

- **The typing indicator runs at ~667 WPM.** `typingDelayForLength`
  (`evolution.ts:77`) uses 18 ms/char = 55 chars/sec, against a human mobile rate
  of 25-40 WPM - about 20x too fast - and its 4500 ms clamp binds at ~183
  characters, so *every* RFQ opener and negotiation paragraph shows the identical
  4.5 s of typing regardless of length. A constant is a stronger fingerprint than
  no indicator at all. Fix: drive typing with repeated `sendPresence` composing
  pulses rather than the send request's `delay` (so a 600-char message can show
  30-60 s of typing without holding an HTTP request open), recalibrated to
  180-320 ms/char with persistent per-sender variation.
- **The presence sequence is a two-valued constant across the whole fleet.** The
  slow path always emits exactly `composing -> paused -> composing`; the fast path
  always emits one `composing` with the hard-coded literal `1500` - the only
  number in the block never jittered. Fix: sample the *number* of alternations
  from message length, draw each burst and pause from `gaussianUnit`, and
  occasionally emit a compose-then-abandon.
- **No read-before-type, and the duty cycle barely runs.** Nothing marks a
  message read or emits chat-level `available` before typing starts.
  `setInstancePresence` (`evolution.ts:774`) has two callers, neither on the send
  path, and the only online/offline cycle - `pauseIdleSessions` - is called from
  exactly one place: `ingest.ts:927`, fire-and-forget, five lines before the
  webhook returns. A number that fired 40 intros and got zero replies generates no
  inbound webhook and is therefore **never quieted** - precisely the account most
  at risk. Fix: move the duty cycle onto the scheduled tick, awaited inside
  `finishBeforeResponse`, and make it a real per-sender wake window in the
  traveller's timezone.
- **There is no sender-side clock gate at all.** `clampToBusinessHours`
  (`business-hours.ts:141`) clamps against the **recipient's** local hour and has
  no notion of the sender - so nothing has ever stopped a batch firing at the
  sender's 3am, with or without `fast_dispatch`. Add `clampToSenderWake`, applied
  after the recipient clamp at all six call sites, and **not** bypassable by
  `fast_dispatch`: the recipient clamp is a courtesy, the sender clamp is a ban
  control.
- **Presence failures are unobservable.** The `try/catch` at `evolution.ts:1975`
  is dead for HTTP errors because `evo()` returns a status rather than throwing.
  If this Evolution build rejects `/chat/sendPresence`, every send has been going
  out with no typing indicator and no signal anywhere. Check the return value and
  surface a streak in the WA doctor.

### Vector 4 - Rate-limit adaptive throttling (this is the actual fix)

> **Superseded in part by research - read Part 0.37 first.** WhatsApp exposes
> `fetchNewChatMessageCap()`, which returns this number's real remaining
> cold-outreach quota and its warning level. The curve below stops being the
> source of truth and becomes the *local governor beneath* an authoritative
> reading: `cap = min(fetchNewChatMessageCap().remaining, localCurve)`. The
> documented mechanism is a rolling monthly **count of new chats that never got a
> reply**, cleared by a reply - so the curve's job is to spend that count well,
> not to guess its size. Two behavioural rules follow, and they matter more than
> any constant: **one message only to a silent shop**, and **require one inbound
> reply on the number before releasing the next batch.**

**This is not a bug fix. It is an owner decision being reversed, and the code
should say so.** The verify pass established that `effectiveNewContactCap`
ignoring account age is the *deliberate, documented, test-pinned specification* -
`capacity.ts:109-114` states the requirement, `capacity.test.ts:34-47` pins it,
and commit `d0f0ec4` introduced it precisely to remove an earlier age-scaled cap
that cut a day-0 ultra user from 40 to 18. That earlier behaviour was treated as
the bug. It is now the fix.

That history has two consequences for execution: the pinning test must be
**rewritten deliberately** (not deleted quietly), and the new curve's comment
must record that this reverses `d0f0ec4` and why, so the next person does not
"fix" it back.

Account age is already tracked - `ageDaysOf(rep)` at `wa-guard.ts:306` - and
simply discarded. `effectiveNewContactCap` becomes:

```
cap = planBudget * ageRamp(ageDays) * velocityDamp(new24h, new7d) * healthDamp(replyRate, blocks, risk)
```

- `ageRamp` - **10 introductions on day 0**, reaching the full plan budget by
  about day 10. Free tier is unchanged (its budget is already 10).
- `velocityDamp` - a number that ran hot yesterday gets less headroom today,
  tapering after consecutive hot days. The inputs already exist:
  `introductionsInWindow` (`wa-guard.ts:604`) and the cold-engagement window.
- `healthDamp` - reply rate under ~25% across the last 20 cold intros halves the
  cap. A number nobody answers is a number being reported.
- `stealthFactor` (`src/lib/wa/stealth.ts`) divides into the same curve, so a
  rising risk score tightens the cap instead of only widening the gaps.
- **`warmupFactor` is deleted, not tuned.** The audit found it is arithmetically
  inert for pro and ultra at every trust level: `effectiveHourCap` floors its
  result at `cap.newContacts`, and `PLAN_CAPACITY` sets `hourCap ===
  newContacts`, so day-0 ultra computes `max(6,40)*0.85 = 34` then `max(40,34) =
  40` - identical to day 365. One warm-up concept replaces two.
- `max_new_contacts_per_day` is currently a dead knob the owner can still edit in
  the admin policy editor. It becomes a real hard override
  (`cap = min(curve, max_new_contacts_per_day)`) or it is removed.
- `fast_dispatch` defaults **OFF for cold intros** (unchanged for replies, which
  is where the SLA actually needs it).

**Product consequence, stated plainly:** a day-0 Ultra user contacts 10 shops,
not 40, and reaches 40 around day 10. That is a real reduction in day-one
coverage. The alternative is the outcome already observed twice.

## 0.3 The SLA arithmetic

| case | shops | waves | on the wire | first quotes | full set |
|---|---|---|---|---|---|
| free, any age | 10 | 2 | ~12 min | ~4 min | ~25 min |
| ultra, day 0 | 10 | 2 | ~12 min | ~4 min | ~25 min |
| pro, mature | 30 | 4-5 | ~35 min | ~4 min | ~50 min |
| ultra, mature | 40 | 5 at 8 per 8 min | ~42 min | ~4 min | ~55 min |

Two things make this work:

- **Waves do not delay the first quotes.** Wave 1 shops are replying while wave 2
  is still dispatching, and negotiation runs concurrently per thread. Time to
  *first* usable quote is unchanged at roughly 4 minutes in every row.
- **Vector 4 feeds Vector 1.** A mature, well-answered number runs 8 shops per
  8 minutes; a fresh one runs 5 per 12. The largest batch is therefore only
  reachable by the accounts that can move fastest, which is why the bottom row
  fits the window and a day-0 account does not need to.

## 0.35 The two architectural proposals - resolved

Researched and adversarially checked. **Both are dead, and one of my own earlier
assumptions was wrong.**

### A. Device contacts - KILL, but not for the reason I gave

I previously said the blocker was that a PWA cannot write contacts, so it needed
a native shell, and that the open question was whether a phone-saved contact even
reaches the companion session. **Both halves of that were wrong.**

- A Baileys linked companion **does** sync contacts - they ride app-state sync as
  `contactAction` in collection `critical_unblock_low`.
- Baileys can even **write** a contact from the companion with zero user effort:
  `addOrEditContact(jid, contact)` via `chatModify`. No phone, no native shell,
  no App Store review. The mechanism I said required weeks of work is one call.
  *(Evolution v2 exposes no route for it, so it would still need a fork - but the
  platform is not the obstacle I claimed.)*

What actually kills it is **efficacy**, and this is decisive:

- **No primary source makes "sender has recipient saved" a scoring input.** Every
  official-sounding sentence points the *opposite* direction - it is about people
  who do not have *your* number saved in *their* address book, which the
  traveller cannot influence.
- **Meta states it cannot read WhatsApp-stored contacts.** IPLS (Identity Proof
  Linked Storage, Oct 2024) encrypts contact names with a client-generated key
  held in HSMs with audited key transparency, explicitly so Meta cannot read the
  list.

So: do not build address-book writing, do not build a native shell for it, do not
add a "save shop to contacts" onboarding step.

**But the research found a real contact-graph problem we are causing.** The app
calls `/api/wa/avatar` for **every rendered shop card**, and each one is a USync
query carrying the phone number in **plaintext E.164**. That is a bulk
contact-discovery pattern - the app is emitting the one contact-graph signal it
*can* control, at volume, for shops it has not even messaged. Fix: fetch a
profile picture only for shops actually messaged or replied, and pace it.

### B. Local device routing / IPv6 - REJECT as specified

- **Baileys has no `localAddress`.** Its `SocketConfig` has no such field, and
  `WebSocketClient.connect()` builds the socket with a closed option set that
  does not spread `config.options` - so arbitrary net/tls options cannot reach
  the connect call. The only source-address hook is `SocketConfig.agent`.
- **Evolution never lets you supply an agent.** It constructs one itself from
  proxy host/port/user/pass. There is no path without forking.
- **IPv6 is genuinely available end to end** - `web.whatsapp.com`,
  `g.whatsapp.net` and `mmg.whatsapp.net` all publish AAAA records.
- **Cloud Run was a red herring in my earlier brief** - Evolution runs on an
  external host, not Cloud Run, so that objection never applied.
- **Efficacy is the real problem.** Every reputation system that documents its
  IPv6 behaviour aggregates at **/64 or coarser**. Per-/128 uniqueness inside one
  /64 on one cloud ASN buys close to nothing.

**The elegant workaround, if per-session source IP is still wanted:** run N local
SOCKS5 listeners on the Evolution host - one per source address - and point each
instance's existing proxy config at a different local port. That achieves
per-session egress control **without touching Evolution or Baileys at all**. It
is the right shape if we ever want it.

Keep country-matched residential/mobile proxy pinning as the primary network
control; it is already built (`evolution.ts:231-270`) and only needs a provider.

### C. TLS fingerprinting (C5) - DROP FROM THE ROADMAP

The mechanics in the owner doc are right and the conclusion is wrong.

- **No primary evidence** that Meta uses TLS fingerprinting for WhatsApp client
  enforcement. The named tool **"ViperFin" does not appear to exist.**
- **Strong counter-evidence:** Baileys connects from Node's stock OpenSSL stack
  and works at scale across Evolution, WAHA and others. It even defeats
  WhatsApp's actual anti-bot check on `web.whatsapp.com/sw.js` purely by setting
  HTTP headers.
- **The marginal signal is ~zero anyway**, because Baileys already identifies
  itself perfectly *inside* the Noise tunnel with hardcoded constants
  (`osVersion "0.1"`, `osBuildNumber "0.1"`, `device "Desktop"`, mcc/mnc `"000"`).
  Meta can match that with one equality test - no packet inspection required.
- The mitigation is unreachable through Evolution regardless.

Also correct the repo's own overstatement: `evolution.ts:32-45` and
`hardening-invariants.test.ts:154-166` claim more for the per-instance
fingerprint than is true.

### D. On-device UI automation (C6) - no distributable path on either platform

- **iOS: impossible.** No API lets app A type into WhatsApp and tap send. Every
  candidate fails for a documented reason - UIAccessibility, App Intents,
  Shortcuts, XCUITest, AppleScript. Strike the "iOS Automation Engine" from the
  owner document; it is not a real thing.
- **Android: technically possible, commercially closed.** `AccessibilityService`
  can read WhatsApp's tree and click send. But Google Play's **30 Oct 2025**
  policy update prohibits *"any use of the Accessibility API that enables an app
  to autonomously initiate, plan, and execute actions"*, enforced from **28 Jan
  2026**. Android 13+ **Restricted Settings** blocks sideloaded apps from being
  granted accessibility at all, closing the escape hatch. Android 17 reportedly
  restricts it further.

If a device-side experiment is ever wanted, scope it to one owner-operated
handset for measurement - never as a distributed product.

### E. Ordering, revised by the research

1. **A.0 correctness items** (Part 0.37) - hours, and three of them stop the
   system lying about its own health.
2. **Read the real quota** via `fetchNewChatMessageCap()` - replaces every
   invented capacity number with an authoritative one.
3. **Cut day-0 volume + one-message-to-silent-shops + reciprocity gate**
   (Vector 4, as revised) - targets the documented enforced action.
4. **Wave pacing** (Vector 1).
5. **Human timing + sender clock gate** (Vector 3).
6. **Message entropy** (Vector 2) - a wiring gap, hours.
7. **Country-matched residential proxy** - already built, needs a provider.

Dropped entirely: TLS masking, IPv6 /64 binding, contacts writing, native shell,
on-device automation, phone-as-exit-node.

## 0.36 The two owner research documents - assessment

Both read in full. A 50-agent review (`wf_faf43825-3f8`) is testing every claim in
them; this is my own first pass, and the research verdicts supersede it where
they differ.

### Adopting - genuinely valuable and not currently in the codebase

| Claim | Why it matters here |
|---|---|
| **Deaf Session Detector** | A Baileys WebSocket that stays open, keeps ping/ACK alive, but stops firing `messages.upsert` under an internal mutex. **This would present exactly as our I-1 symptom** and we have no detector for it. Probe the session on an interval; on silence, `sock.end()` and reconnect clean. High priority regardless of whether the cited issue number is right. |
| ~~**IPv6 /64 per-session `localAddress`**~~ | **Research verdict: not implementable on stock Evolution.** Its `socketConfig` has no `localAddress` and no socket-option passthrough; only `agent` (proxy) is injectable. Requires forking Evolution. Demoted - see Part 0.37. The already-built `EVOLUTION_PROXY_POOL` is the realistic lever. |
| **Delivery-receipt ratio as a health signal** | We already require a delivery receipt per send. Feeding the *ratio* into a health score, with a graduated halt and re-ramp, is a real addition. |
| **Error-code → recovery table** | 401/440 logged out, 428/429 rate limited, Bad MAC ratchet desync. The Bad MAC case especially - crypto desync is a silent-failure class we do not handle. |
| **Reply-ratio as a governor** | Corroborates `healthDamp` in Vector 4, independently arrived at. |

### Rejecting, with reasons

- **"100% anti-ban."** Asserted throughout both documents, including a comparison
  table scoring one architecture at exactly 100%. It is not achievable, and the
  practical harm is specific: a number that confident ends up in UI copy, and
  then the first restricted user is a broken promise rather than a known risk.
  Build every measure; claim none of them absolutely.
- **Zero-width character injection (C9).** Declined on *technical* grounds before
  policy ones: our own `normalizeForSig` (`copy/hash.ts`) strips non-alphanumerics
  before hashing, and any serious duplicate detector normalises the same way. It
  buys nothing and puts invisible junk in messages real people read.
- **"iOS Automation Engine" (C6).** **No such API exists.** iOS provides no way
  for one app to inject text into WhatsApp and tap its send button - not
  Accessibility, not App Intents, not Shortcuts. Document 2 presents iOS support
  as solved in its own comparison table; that row is wrong, and it invalidates
  the document's central architecture for half our users. On Android the
  mechanism is real but depends on the Accessibility API for non-accessibility
  automation, which Google Play prohibits and enforces against.
- **Horizontal edge scaling across N devices (C10).** The arithmetic assumes a
  shared sending pool. Our messages must originate from each traveller's own
  number - user A's outreach cannot route through user B's phone. That section
  was written for bulk marketing and does not describe this product.

### The contradiction worth surfacing

Document 1's centrepiece is the **Inbound Dispatcher**: invert direction so shops
message the traveller first, delivered via lead-capture forms on shop websites or
a vCard/`wa.me` link the shop taps. The *principle* is sound and independently
confirmed - Meta's own restriction notice blocked starting new chats while
permitting replies.

But the *mechanism* requires shops to have websites, forms, or to tap a link -
and your own directive states that over 99% of target-region shops have none of
those. **The document's main recommendation contradicts the ground truth you gave
me.** The research has a dedicated agent enumerating every other route to
inbound-first, including ones neither document considered.

## 0.37 Research findings that reorder this plan

From `wf_faf43825-3f8` (20 domains, adversarial challenge each). These are the
ones that change what ships first. All are code- or source-verified.

### The single worst line in the deployment

```
render.yaml:138   CONFIG_SESSION_PHONE_CLIENT=WheelDeal
```

Evolution passes this straight into `makeWASocket` as `browser[0]`. **Every
traveller who links their WhatsApp appears to Meta as a linked device literally
named "WheelDeal".** Not a class of device - our product name, on every account,
across every user. That is a perfect clustering key: one label ties every account
using this service together, and the moment any of them is flagged the rest are
trivially findable.

It also contradicts the repo's own `ANTI-BAN.md:44-52`, which instructs setting
it to `Mac OS`. The doc and the deployment disagree, and the deployment is what
Meta sees. **Hours to fix, and it may matter more than everything in Vector 1-4
combined.** Two related findings from the same agent:

- `browser[2]` is `os.release()` - the container's **host kernel version**
  (e.g. `6.8.0-oracle`) presented as a WhatsApp Web client version. No real
  client sends that.
- On the **pairing-code** path Evolution skips the browser assignment entirely,
  so `CONFIG_SESSION_PHONE_*` does not apply at all. Fingerprint control exists
  only on the QR path. That is a deliberate choice we have been making by
  accident.
- The app's own `CONNECT_FINGERPRINT` in the create body is **inert** -
  Evolution's `InstanceDto` has no `browser`/`mobile` field, so it is silently
  discarded. `ANTI-BAN.md` describes it as a shipped defence; it is not.

### The deaf-session claim (C4) is TRUE, and we run the worse version

Issue **#2491 exists** and its title matches the owner doc almost verbatim -
*"Sessions go 'deaf' after 30+ minutes - connection alive, messages.upsert stops
firing"*, open since 2026-04-23. The structural precondition was verified in
source: a single per-socket `processingMutex` with **no timeout and no
cancellation** serialises decrypt, ack and upsert, while the keep-alive clock
`lastDateRecv` is stamped on any decoded frame *before* that mutex. So the socket
looks perfectly healthy while inbound is wedged.

Worse: Evolution 2.3.7 pins Baileys **7.0.0-rc.9**, which is *missing* the
ack-on-error safety net that master later added. We are on the version where a
single decrypt failure can wedge the lock permanently.

**Important correction that keeps I-1's diagnosis intact:** a wedged mutex does
**not** block outbound in rc.9 - `sendMessage` relays first. So deaf sessions
explain *missed inbound*, not our composed-replies-never-sent incident. The
`0.0.0.0` origin bug remains the right root cause for I-1. These are two separate
faults and both need fixing.

### Three ways a dead session looks alive

1. **The ban/logout detector is unreachable.** `ingest.ts:239-258` regex-matches
   `statusReason` against words (`logged out`, `banned`). Evolution emits it
   as a **number** (401 loggedOut, 403 forbidden, 411 multideviceMismatch, 440
   connectionReplaced). The branch has never fired.
2. **Nothing ever writes status `"close"`.** So `isLinkedForUi` keeps returning
   linked after Meta severs the link, and `/api/wa/status` reports CONNECTED
   forever.
3. **`classifySafety`'s disconnected verdict is dead code** - it triggers only on
   `connection === "close"`, a value never persisted.

Together: when a traveller's WhatsApp is actually banned, the app tells them
everything is fine and keeps queueing messages.

### Two contradictory rate systems

`sendFromUser` calls `checkRateLimit` first, which enforces
`LIMIT_WA_PER_HOUR = 15` / `LIMIT_WA_PER_DAY = 60` (`usage.ts:84-100`) - while
`PLAN_CAPACITY` promises ultra 40 per window with `hourCap` 40. **The real
ceiling is 15/hour, not 40.** One of these must own velocity; today they fight,
and the plan model loses silently. This is also a partial explanation for batches
that stall. Hours to reconcile.

### C3 (IPv6 /64) is not implementable on stock Evolution

The `socketConfig` Evolution passes to `makeWASocket` has **no `localAddress`**
and no generic socket-option passthrough. The only network injection point is
`agent` - i.e. the proxy path we already have. Per-session IPv6 binding would
require forking Evolution. That demotes it from "cheap high-value win" to "fork
decision", and makes the existing `EVOLUTION_PROXY_POOL` the realistic lever.

### The multi-host failover claim in our own code is false

`evolution.ts:180-184` states hosts "all point at the SAME Supabase Postgres" so
"ANY host can resume a user's session with NO re-linking". At Evolution 2.3.7
only the `creds` blob goes to Postgres; **all Signal key material goes to that
host's Redis or local disk**. Failover therefore either loses keys or produces
two live sockets on one identity, which WhatsApp answers with
`connectionReplaced`. Either repair it (shared Redis) or delete the claim - a
comment that lies about durability is worse than no comment.

### WhatsApp will TELL US the budget. We have been guessing.

The single most valuable discovery in the whole review. WhatsApp exposes
first-party server APIs that Baileys already implements:

- **`fetchNewChatMessageCap()`** - query type `INDIVIDUAL_NEW_CHAT_MSG`, returns
  `total_quota`, `used_quota`, the cycle window, and a warning ladder
  `NONE -> FIRST_WARNING -> SECOND_WARNING -> CAPPED`.
- **`fetchAccountReachoutTimelock()`**.

This is not a stealth technique. It is the platform telling us, authoritatively,
how much cold-outreach budget this specific number has left and how close it is
to being capped. Every number in `PLAN_CAPACITY` is currently an invention;
this replaces the invention with a reading.

**And the documented mechanism is not what either owner doc says.** Since
**October 2025** WhatsApp enforces a **monthly cap on messages sent into NEW
chats where the recipient has not replied**. The counter is **cleared when the
recipient replies**. Existing and reciprocal conversations are unaffected. That
is precisely our workload, and it is documented rather than folklore.

Three consequences that change the design:

1. **The metric is a COUNT, not a RATIO.** C1's "reply-ratio below 10% is
   critical" has the wrong *shape*, not just the wrong number - no Meta source
   states any consumer reply-ratio threshold.
2. **Every follow-up to a silent shop burns scarce quota.** So unanswered threads
   should be capped at **exactly one message**, with all remaining budget spent
   on first contacts. This is a strategy change, not a tuning change.
3. **Reciprocity should gate the burst.** Send one introduction batch, then
   require at least one inbound reply on that number before releasing the next.
   That is both safer and self-correcting.

### C8 is disproven - and it is already load-bearing in our code

`wa-guard.ts:1528` hardcodes `if (delivRate < 0.6)` under the comment
*"(research: double-tick threshold ~60%)"*. The research it cites is the README
of a GitHub anti-ban middleware that itself cites no evidence. We promoted an
unsourced default to "research" in a comment, and then trusted it.

Worse, it is a **category error**: delivery receipts are emitted by the
*recipient's* device when it comes online. The ratio therefore tracks shop phones
being switched off at night - not Meta's opinion of the sender. And the breaker
**fails silent exactly when needed**: it only evaluates once `delivered_total >= 8`,
and that counter is fed solely by `messages.update` webhooks, so if receipts stop
arriving it never fires.

Replace it with a **lane-differential restriction detector**: the documented
restriction is scoped to new chats, so it is directly observable - sends to JIDs
with no prior inbound start failing while replies to established threads keep
succeeding. That signal is real, specific, and ours to measure. On detection,
suspend **only** cold initiation and keep the reply lane fully live, rather than
routing through a blanket account pause.

Strip the false authority from the other invented constants (0.6, 0.15, 0.3)
and label them as unvalidated operator tunables.

### `ANTI-BAN.md` contradicts the evidence

It asserts the restriction "hit at the pairing / socket-connection step, before a
single message was sent", concluding the cause was fingerprint plus datacenter
IP. The **shape of the notice contradicts that**: a fingerprint verdict does not
produce a scoped "you may reply, you may not start new chats" outcome. That
scoping points squarely at the new-chat quota above. The doc needs correcting, or
it will keep steering work toward the wrong lever.

### Infrastructure: the proxy layer exists and is switched off

`evolution.ts:231-270` implements per-user pinned proxying, and **no proxy is
configured in any deploy artifact.** Today every traveller's linked-device
session egresses from **one shared Render Oregon datacenter range**. That is
precisely the IP co-tenancy that Meta's own published ML feature set names
("reputation of other users sharing the same compute resources"), and it is live.

Four more defects in the layer as written: `parseProxy` runs only at link time
(`:1141`); the failover recreate sends **no proxy fields** (`:935-950`); the pin
is a mod-hash that **remaps every user when the pool resizes** (`:265-267`); and
there is **no country input anywhere**, so the documented "country-matched exit"
does not exist.

Frame it honestly: proxying is **blast-radius containment**, not ban prevention -
it caps how many accounts share a fate. It must not be allowed to displace the
volume and pacing work, which is what actually targets the enforced action.

One hard constraint to write into the deploy docs: **the Baileys socket must
never run on Cloud Run.** It egresses from the Evolution container; Cloud Run
stays for the Next.js app and webhooks only.

### Scale: the problem is session residency, not throughput

A peak ultra user is ~40 cold + ~150 reply messages/day - trivial volume. The
real constraint is **N always-on, low-volume Baileys sockets**, which is a
stateful-fleet problem the current "serverless plus one 512 MB host" topology
cannot express. It breaks in this order: Evolution host memory (one Render
starter at `--max-old-space-size=384`), then session-to-host ownership, then the
global self-chaining tick.

Three items, all Wave B except the first:

- **[A.0.6, hours]** `/api/activity`'s opportunistic drain is **not scoped to the
  polling user** - it drains globally. At hundreds of users that is every poller
  fighting over every sender's queue. Pass `{ senderKey }`, as `/api/replies`
  already does.
- Replace the global `__chain__` self-chaining tick with **per-user cold
  dispatch**: one queue key per sender, concurrency 1 per sender, N senders in
  parallel.
- Make session-to-host ownership a **lease with a fencing token**, not a nullable
  column read through a helper that swallows errors.

### The auth story is dishonest in a way that costs messages

Beyond the numeric `statusReason` parse and the missing `"close"` state already
listed: nothing ever downgrades `wa_sessions.status` from `"open"`, so a dead
session reports "linked - reconnecting" **forever** while queued messages retry
for 24 hours and are then **silently dropped**. And `ensureConnected` keeps
POSTing `/instance/create` + `/instance/connect` into a link that is gone. Once
`"close"` is real, `ensureConnected` must refuse to reconnect and the outbox must
park with an honest `link-dead` reason instead of burning a day of retries.

### There are TWO enforcement axes, and we have only been thinking about one

This reframes the whole risk model.

1. **Spam / velocity** - meters unanswered outbound. Penalty: a **scoped**
   restriction, "you may reply, you may not start new chats." **This is what the
   owner got, twice.**
2. **Unofficial-client detection** - fires on the Baileys session itself.
   Penalty: a **full ban**. And critically, **it fires on accounts doing
   reply-only work.**

So C2's "inbound-initiated is immune" is **false in its strong form**. Inverting
direction addresses axis 1 and does nothing for axis 2. Any plan that treats
inbound-first as the silver bullet is protecting against the lesser penalty while
leaving the terminal one untouched.

The two penalties having different shapes is also what confirms our diagnosis:
the owner received the *scoped* restriction, which is axis 1, which is volume.

### The single most actionable finding in the review

**Our outreach budget is denominated in the wrong unit.**
`introductionsInWindow` (`wa-guard.ts:620`) counts introductions **sent**, built
purely from outbound rows keyed by `to_number` with no reference to any reply.
Meta meters introductions **unanswered**.

Re-denominate it: a recipient who has replied should **return its slot**, so only
silence consumes budget. That single change aligns our governor with the actual
enforced quantity, and it is days of work. It is also the *reachable* form of the
Inbound-First idea - not inverting direction, but spending the budget on the
quantity that is actually metered.

### Inbound-first: 12 mechanisms, one survivor, and it is not code

- **Google Business Messages was shut down in July 2024.** Owner doc 1's
  mechanism no longer exists.
- Lead-capture forms need the websites the owner says 99% of shops lack.
- Of 12 enumerated mechanisms, exactly **one** satisfies zero-user-effort,
  no-app-exit and per-traveller inbound: a **shop-side partner portal / merchant
  onboarding**. That is a months-per-city supply-side BD problem, not an
  engineering task. It may still be the right long game - but it cannot be in
  this plan's waves.
- **Measure the premise rather than assuming it.** Persist `websiteUri` from the
  Places Details response onto the vendor record and report coverage per city.
  "99% have no website" is load-bearing for several decisions and is currently
  unmeasured.

### The official WhatsApp Business Platform is closed - and not on price

> **CORRECTED BY PART 12 - read this box before acting on the section below.**
> Owner decision has reopened the official platform, and the three blockers below
> resolve differently than written once the *sender* changes from the traveller's
> number to ours:
>
> - **131049 and the tier limits still bite** and are engineered around by the
>   governor in Part 12.2 - the per-agency cooldown, the service-window flush and
>   the fallback ladder exist specifically for this.
> - **The tier limit is much weaker than assumed here.** It meters *unique
>   recipients contacted outside a service window*, and agencies are a small
>   shared set that a district exhausts in the tens - not one recipient per
>   traveller. The "6 ultra searches per day company-wide" figure below is wrong
>   because it counted travellers, not agencies.
> - **"A number lives on exactly one platform" is no longer an objection** - it
>   is the design. Our number is the WABA sender; the traveller's number is never
>   the sender and stays on Baileys for the negotiation.
> - **The missing template support in `whatsapp.ts` is confirmed and is now a
>   build item**, not a reason to abandon the path (Part 12.10 W3).
>
> What does *not* change: opt-in. Scraped numbers have none, the owner has
> accepted that exposure explicitly, and Part 12.2.4 is how the account survives
> it rather than a claim that it is fine.

Steelmanned with numbers. Cost is fine (~$0.10-$2.50 per traveller search). The
blockers are structural:

- **Error 131049**: a WhatsApp user receives roughly **2 marketing templates per
  24h across ALL businesses combined**. Every WheelDeal cold contact would leave
  **one** WABA number, so in a dense destination the same 30-60 shops are
  targeted by every traveller - the third traveller of the day is silently
  undelivered.
- **Launch messaging tier is 250 unique recipients/24h** = about **6 ultra
  searches per day, company-wide**.
- **Scraped shop numbers have no opt-in**, which is a Business Messaging Policy
  violation on a contractually-bound account.
- **The hybrid does not work.** A number lives on exactly one platform, so a
  traveller's personal number can never be the WABA sender. The shop would reply
  to *WheelDeal's* business number while the personal number's first message is
  still unsolicited cold outbound - the hybrid duplicates the risk and adds an
  impersonation-shaped handoff.

Three concrete repo findings fall out of this:

- The shipped Cloud API sender **has no template support** (`whatsapp.ts:60-65`
  posts `type:"text"`), so a cold contact with no open 24h window always fails
  with error 131047. Either add real template support or delete the send path and
  keep only the inbound webhook.
- **Phantom send:** `outreach/route.ts:585` does not check
  `r.channel === "cloud-api"` the way `mass/route.ts:488` does.
- Graph API calls are on **v20.0** and must move to v23.0+ before 24 Sep 2026.

### Ordering consequence

A new **Wave A.0** precedes everything: the phone-client string, the rate-system
reconciliation, the numeric `statusReason` parse, and a persisted `"close"`
state. All are hours-scale, all are pure correctness, and three of them are
currently making the system lie about its own health.

## 0.38 How much to trust this research

The challenge pass surfaced something that applies to the whole review and should
temper how the external claims are read.

**Code findings are solid.** Agents read the actual files - ours, Baileys',
Evolution's - and the challengers re-read them independently. Everything in Part
0.37 about `render.yaml:138`, the numeric `statusReason`, the two rate systems,
`introductionsInWindow` counting the wrong unit, the missing `"close"` state and
the unconfigured proxy layer is verified source, twice.

**External claims are weaker than their labels suggest.** Several challengers
reported that the sandbox proxy returned **HTTP 403 for most external hosts** -
`whatsapp.com/legal`, `faq.whatsapp.com`, `about.fb.com`, Wikipedia, arXiv - so
they could not independently verify the primary sources behind some findings
originally labelled DOCUMENTED. Specifically downgraded to *partially documented
(existence) + unverified (contents)*:

- Meta's "Stopping Abuse" white paper and its named ML feature list.
- The monthly ban volumes and the India IT-Rules attribution.
- The October 2025 unanswered-new-chat quota, which is **community-reported**,
  not confirmed from a Meta source in this session.

That last one matters most, because the revised Vector 4 leans on it. **The
mitigation is that it is independently corroborated by the owner's own
restriction notice** - a scoped "you may reply, you may not start new chats" is
exactly the shape that quota would produce, and that artifact is first-hand
evidence we hold. Treat the mechanism as strongly indicated and the specific
numbers as unverified.

**Practical rule for execution:** anything driven by a code finding can be built
on directly. Anything driven by an external claim about Meta's behaviour should
ship behind a config value we can tune, never a hardcoded constant with a comment
citing "research" - which is precisely the mistake `wa-guard.ts:1528` already
made with the 60% delivery threshold.

**`fetchNewChatMessageCap()` is the way out of this epistemics problem
entirely.** It replaces every inferred threshold with a number the platform hands
us. That is why it ranks where it does.

## 0.39 The synthesis pass - what it added and what it corrected

The review completed: **63 agents, 6M tokens, 2h46m** - 19 investigations (one
errored), 38 adversarial challenges, 4 thematic syntheses. The final
cross-theme consolidator did not return; the four theme rankings below are the
authoritative output.

### It corrected me twice, and both corrections are better than what I wrote

- **C9 (zero-width injection) - my reasoning was weak.** I argued
  `normalizeForSig` strips it. The real reason is stronger: **message bodies are
  end-to-end encrypted under the Signal double ratchet before they reach Meta**,
  so there is no server-side content hash to defeat. The technique is not merely
  ineffective, it is aimed at a surface that does not exist.
- **C7 (typing emulation) - already built here and deliberately deleted.** The
  typo/self-correction pass existed in this repo's history and was removed. Vector
  3 must not silently re-add it; check the history and the reason before touching
  that behaviour.

### Five findings I had not captured

| # | Finding | Size |
|---|---|---|
| 1 | **The persistent execution tier already exists in the repo and is unprovisioned.** `infra/gcp/README.md` describes a GCE VM with Redis + gateway + BullMQ workers. Provisioning it and making it the **sole owner of the WhatsApp socket** is ranked #1 on the architecture theme - and it is also why `REDIS_URL` is unset everywhere. | days |
| 2 | **Ban recovery has no ramp.** `enterBanRecovery` pauses 24h and sets `trust_score = 10`, but when `paused_until` lapses the number is **immediately allowed its full plan budget again**. A restricted number goes straight back to the behaviour that restricted it. | hours |
| 3 | **`introductionsInWindow` fails OPEN.** It uses permissive `sbSelect`, so a Supabase blip reads as "zero introductions used" and the budget gate opens completely. Must fail closed, like the Wave 1 safety reads. | hours |
| 4 | **`/instance/fetchInstances` as a 15s liveness probe is likely triggering the dual-socket condition.** Use the unauthenticated root endpoint for liveness; call `fetchInstances` every few minutes only, to validate. | hours |
| 5 | **The proxy is never verified to have applied.** Check the `/proxy/set` response and `/proxy/find`, record the assertion on the session row, and refuse cold outreach on a session whose exit is unconfirmed. | hours |

### One contradiction the synthesis resolved that matters

Two investigators disagreed about whether "40 cold intros in 15 minutes" is
really unchecked. **Both are partly right, and the breaker side wins on
mechanism:** `capacity.ts` and `pacing.ts` genuinely schedule 40 introductions at
~12-15s spacing on day 0 - *but* `wa-guard.ts:1502-1521` should freeze a
zero-engagement batch around introduction 8-9 and park it 2-4 hours.

So the real question is **why the breaker did not save the account**, and the
likely answer is already in this plan: it only evaluates once
`delivered_total >= 8`, and that counter is fed solely by `messages.update`
webhooks. If receipts were not arriving, the brake was never armed. That makes
the delivery-receipt pipeline a **safety-critical** dependency, not a metric.

### Also newly ruled out

- **Do not raise `numInstances` or add Evolution hosts** until per-host instance
  ownership is fixed. `render.yaml:191-200` currently advises the opposite, and
  following it today would multiply the dual-socket problem.
- **Do not run the WhatsApp session in the browser.** Nobody proposed it, and the
  synthesis ruled it out pre-emptively so it does not resurface.
- **C4's literal remedy is not buildable by us** - a 30s probe plus `sock.end()`
  assumes we hold the Baileys socket. We do not. The app-layer detector already in
  this plan is the correct substitute.

### The one strategic option worth scoping (not building)

A **two-sided model**: recruit shops **once** onto an opt-in roster, and let all
traveller outreach flow to shops that have already consented. It is the only
architecture identified that removes ban risk from the traveller entirely. It is
a business-model change, months of supply-side work, and it converges with the
partner-portal conclusion from the inbound-first domain. Worth an explicit
decision; not a wave.

**Also produce an execution-locus ADR** next to `ANTI-BAN.md`: the sending code
runs server-side on the persistent worker tier, never on the traveller's device
and never in the browser. That document is what stops this debate recurring every
few months.

## 0.4 What is not in this plan

No burner or relay accounts, no per-user IP rotation, no client-fingerprint
spoofing. Those are detection evasion rather than abuse reduction: they delay
enforcement instead of preventing it, and when it lands it lands on the
traveller's own personal WhatsApp - the exact harm this is meant to stop. Nothing
in the four vectors above is evasion; they are volume, pacing and variation,
which reduce the underlying behaviour rather than disguise it.

Stated once and not repeated: this substantially reduces restriction risk. It
does not reduce it to zero, because business-initiated messaging from a personal
number is the category Meta enforces against, and no client-side measure changes
that category.

---

---

# PART 0.9 - WHAT SHIPS FIRST

The whole plan in one ordering. Everything above is the reasoning; this is the
sequence.

| # | Work | Size | Why here |
|---|---|---|---|
| 1 | **A.0.1** `CONFIG_SESSION_PHONE_CLIENT` off the literal `WheelDeal` | hours | Every user is currently labelled with our product name as a linked device. One clustering key ties every account together. |
| 2 | **M18.0** One origin resolver at the six self-kick sites | hours | Un-freezes the entire dispatch system. Nothing else is verifiable until messages move. |
| 3 | **A.0.3** Numeric `statusReason` + persisted `"close"` | hours | A banned traveller is currently told everything is fine while we queue for 24h and then drop. |
| 4 | **A.0.2** One rate system | hours | 15/hour and 40/window fight; the plan model loses silently. |
| 5 | **A.0.6** Scope `/api/activity`'s drain to the polling user | hours | Cross-user contention that gets worse with every user added. |
| 5b | **A.0.7** `introductionsInWindow` fails closed; ban recovery gets a ramp; liveness probe off `fetchInstances`; verify the proxy applied | hours | Four independent hours-scale fixes, each of which currently removes a brake. |
| 6 | **M18.1/18.2** Drains that finish; the lane completes | days | The other two I-1 mechanisms. |
| 7 | **Re-denominate the outreach budget in UNANSWERED threads** | days | Aligns our governor with the quantity Meta actually meters. The single highest-leverage anti-ban change. |
| 8 | **`fetchNewChatMessageCap()`** - read the real quota | days | Replaces every invented capacity constant with an authoritative number. |
| 9 | **Vector 4** age ramp + one-message-to-silent-shops + reciprocity gate; `fast_dispatch` off for cold | days | Targets the documented enforced action. |
| 10 | **A.0.4** Deaf-session detector | days | Known Baileys failure, and we run the version missing the safety net. |
| 11 | **Vector 1** wave pacing (enqueue floor **and** drain admission) | days | Second-order on the same signal. |
| 12 | **Vector 3** typing recalibration, sampled presence, sender clock gate | days | Removes the 667 WPM and 3am tells. |
| 13 | **Vector 2** entropy wiring; **pace the USync avatar lookups** | hours | A wiring gap, plus a bulk contact-discovery pattern we are emitting today. |
| 14 | **Configure the proxy pool**; persist the exit on `wa_sessions` | days | Blast-radius containment. Already built, switched off. |
| 15 | **M22/M17/M6** doctor, counters, Evolution resiliency | days | Wave A remainder. |
| 15b | **Provision the persistent execution tier** (`infra/gcp/README.md`: GCE VM + Redis + gateway + BullMQ) and make it the sole owner of the WhatsApp socket; unique `DATABASE_CONNECTION_CLIENT_NAME` per host | days | Ranked #1 on the architecture theme. Also fixes the dead Redis layer and the dual-socket condition. Do **not** add hosts before this. |
| 16 | **Wave B** session residency, per-user dispatch, leases with fencing | weeks | Scale to hundreds. |
| 17 | **Wave C** dates, pricing overhaul, transparency, translation + RTL | weeks | Product surface. |
| 18 | **Wave D** Aurora, telemetry, KPIs, PayPal/AdSense, final audit | weeks | Craft and observability. |

**Not being built** (each with reasoning above): TLS/JA3 masking, IPv6 /64
binding, contacts writing, a native shell, on-device UI automation,
phone-as-exit-node, and zero-width injection.

> **Two entries were removed from that list by owner decision - see Part 12.**
> "The official Cloud API for cold contact" and "the hybrid official/Baileys
> split" are now **the plan**, in the specific form where *our* number is the
> sender and the traveller's number is reply-only. The objection that killed both
> - that a number lives on exactly one platform, so the traveller's number could
> never be the WABA sender - was correct, and is answered by not trying to make
> it the sender. Two of the three original blockers (131049, no opt-in) remain
> real and are engineered around rather than argued away.
>
> **Also added, and it ships before any of the messaging work because it needs no
> credentials and no provider:** the warm-up gate and its monetization dashboard
> (Part 12.3, 12.4.1), which replace the cancelled 50% introductory discount.

**Deferred to a decision, not a wave:** shop-side partner onboarding is the only
enumerated mechanism that reaches true inbound-first. It is supply-side business
development, months per city, and it may be the right long game - but it is not
an engineering task and cannot sit in a wave.

---

# PART 1 - THE EIGHT LIVE INCIDENTS

Produced by a 50-agent read-only audit (`wf_3cf3b5c2-a04`): 10 investigators, then
one adversarial refuter per finding, each instructed to default to *refuted*
unless it could reproduce the mechanism from the source itself.

**19 of 34 findings were refuted.** That is the number worth trusting the rest
on. Everything below survived refutation, and the P0s I additionally re-read
myself. The refuted claims are recorded in the appendix rather than deleted -
several were plausible enough that they would otherwise be re-discovered and
re-litigated later.

## I-1 [P0] Agents compose replies that never reach WhatsApp - ROOT-CAUSED
Shops replied 12:42 with real offers; at 12:46 the chat list still showed unread
badges and no agent reply, while Engine Ops showed the reply *had* been composed.
Compose succeeded, dispatch did not. **This is the single most damaging defect in
the product.** There are three independent mechanisms, all confirmed:

**(a) Every dispatcher self-kick is addressed to `0.0.0.0`.** The reply lane is
driven by an HTTP call the app makes to itself. `webhooks/evolution/route.ts:20`
builds `new URL(req.url)` and passes `url.origin` into the ingest (line 36),
which uses it verbatim to build the `reply-tick` and `tick` URLs
(`src/lib/wa/ingest.ts:911-921`). On Cloud Run the Next standalone server builds
`req.url` from the **bind address** - `Dockerfile:53-54` sets `PORT=8080`,
`HOSTNAME=0.0.0.0` - so that origin is the unroutable `0.0.0.0:8080`.
`kickDispatcher` swallows the failure by design (`kick.ts:42-43`), so the reply
lane's dispatcher is never started and nothing is logged.

The repo already contains the fix. `src/lib/request-origin.ts` exists solely for
this, and its header states the failure in these exact terms. It is imported by
four route files and `evolution.ts` - and by **none** of the six self-kick sites
(`webhooks/evolution:36`, `webhooks/whatsapp:307`, `wa/ping:66`, `wa/tick:136`,
`wa/reply-tick:122`, `outreach/mass:530`). A prior task fixed the webhook
*registration* origin and never touched the self-kick origin.

Worse: the hop chain re-derives the same broken origin at `reply-tick:122` and
`tick:136`, so even a correctly-started tick cannot continue past hop 0. This is
the common ancestor of a long line of "queue stuck" incidents in this repo.

**(b) The 8 s drain budget abandons `drainOutbox` mid-row.**
`activity/route.ts:115-117` (and the same pattern in `wa/status` and `replies`)
races the drain against a bare timer. When the timer wins, the drain is not
cancelled - it is left running, and Cloud Run then throttles the CPU to zero at
response flush, freezing it **while it holds the row's lease** (`claimOutboxRow`
stamps `not_before` forward, `outbox-lifecycle.ts:102-114`). The row is invisible
until the lease lapses, and can later be deleted unsent. Fix: pass a deadline
into `drainOutbox` and have it decline to *start* a row it cannot finish.

**(c) The fail-closed parks are lane-blind.** Six parks in `guardOutbound`
(`wa-guard.ts:1162`, `1188-1191`, `1215`, `1298` and neighbours) are
minute-scale: one transient Supabase read failure parks a composed **reply** for
5-10 minutes, and the drain's proportional 20-40 s reply backoff can never apply
to it. Fix: compute the lane at the guard (`opts.meta?.kind === "rfq"` is free
and definitive) and make the hold proportional to it.

**(d) A failed `wa_recipient_state` read reclassifies a reply as a cold intro**
(`wa-guard.ts:1271`), dropping it into the governor a saturated batch has already
exhausted. Fix: `sbSelectStrict`, treat `unavailable` as unknown, and resolve the
lane from the evidence the guard already holds.

**(e) `reply-tick` burns its whole 12-hop chain budget in seconds** when the next
reply is beyond the in-call budget, because it deletes its own claim slot before
handing off (`reply-tick.ts:101-108`).

> Refuted and dropped, so they are not chased again: the missing `try/catch`
> around `guardOutbound` (real, but every helper it awaits is individually
> fail-safe, so no throw is reachable - a hardening gap, not a live defect); the
> claim that a lost lease leaves the lane dark (`claimOutboxRow` PATCHes
> `not_before` to the lease, so the loser *does* see a future row and re-arms);
> and the claim that `reply-tick` never drains `graph_wakeups` (the tick chain
> runner does, on every drain and every hop).

## I-2 [P0] The WhatsApp restriction - root-caused, see Part 0.

## I-3 [P0 -> P1] WA Doctor's total-failure chain was a false alarm - root-caused
The email typed into the doctor was `kaspidoron@gmail.con` - `.con`.
`src/app/api/admin/wa-doctor/route.ts:30` takes it verbatim
(`trim().toLowerCase()`) and **never checks the user exists**. Every red line
follows mechanically from looking up a user who is not there:
`resolveThreadContext` returns `{ok:false, reason:"no-outbound"}` for zero rows
(`src/lib/wa/thread-context.ts:66,97`), no session row, no instance, zero inbound.
"Last accepted webhook 12:50" stayed green because it is a **global** metric - and
that contradiction was the tell.

The real defect is the diagnostic: a one-character typo is indistinguishable from
catastrophic failure, and it cost hours chasing a webhook chain that may be
healthy. **This does not explain I-1** - the shops genuinely got no reply. Two
separate problems that looked like one.

## I-4 [P1] `wd-evolution` crashed ("Exited with status 1"), users saw nothing
The tempting answer - "an unhandled Baileys rejection hits stock Node defaults" -
was **refuted**. The repo already records the real crash: a thrown Prisma error
(`OnWhatsappCache`), documented at `render.yaml:14-19` and already addressed. So
is the "rebuild storm" theory (`ensureConnected` calls create + connect but never
logout or delete - it is not a teardown) and the "single-host skips health
probing" theory (`resolveHost:568` is semantically a no-op; the general branch
would return the same host).

What actually survives is one thing and it is worth fixing: **`ensureConnected`
has no total deadline.** Its `budgetMs` (6000) bounds only the poll loop, not the
create/connect calls before it, so a slow or dying host can hold the send path
far longer than the caller believes. Secondary: it fires create and connect
*before* checking whether the user has a session row at all.

The user-facing half stands on its own regardless of the crash cause: when
Evolution is down, `/api/wa/status` still reports `connected: true` / phase
`CONNECTED`, `hostDown` is unreachable for any paired user, and `page.tsx`
discards every degradation field the API returns. An outage is currently rendered
to the traveller as ordinary anti-ban pacing, for up to 24 hours.

## I-5 [P1] Three counters, three numbers, same second
"AWAITING REPLY (3)" / "3 of 7 sent" / "shops asked: 1 - 6 in line". Audit is
producing a label -> component -> route -> derivation table for every counter. The
fix is one derivation with one owner, read by all three surfaces.

## I-6 [P0/P1] Hebrew renders as gibberish - and the translation cache is write-only
Two findings, the second of which nobody was looking for.

**(a) [P0] The durable translation cache can never be read.** `VAULT_SELECT`
(`runtime-config.ts:644`) filters `key=not.like.I18N_*` to keep the huge
dictionary rows out of the vault read - correct - and the comment above it
asserts *"They are still readable by their own reader, which asks for them by
exact key."* **That reader was never written.** The only config readers are
`getConfig`, `getConfigStrict` and `getConfigMany`, all of which go through
`loadOverrides()` and therefore through that filter, and the translate route
reads its cache with `getConfig("I18N_<lang>")` (`translate/route.ts:74,117`).
So it parses `{}` every time, re-translates the whole catalogue on every cold
load, and writes back a row that nothing can ever read. This is a live LLM cost
leak on every page view in a non-English language, and it is why a bad
translation is unfixable. Fix: write the exact-key reader the comment promises.

**(b) [P1] The translator gets no context and the output is never validated.**
`translateChunk` sends `JSON.stringify(texts)` - a flat array of 14 unrelated
strings - so the model sees `["Next","Back","Light","Dark","Bargain",...]` and
must guess part of speech, register and length budget for each. On top of that:
the do-not-translate list omits **"Will"**, the product's own assistant, which
appears bare in 13 catalogue strings and is a high-frequency English modal verb;
placeholders (`{n}`, `{shop}`) are requested but never verified, and consumers do
a naive first-occurrence `String.replace` on the result; `parsed.t.map(String)`
turns a JSON `null` into the literal truthy string `"null"`, which is then cached
and rendered as a button label; and the endpoint enforces no catalogue membership
at all, so any signed-in caller can write arbitrary strings into the globally
shared dictionary row.

**(c) [P1] RTL is declared and not applied.** `globals.css:928-971` defines
`.rtl-flip`, `.rtl-mirror-x`, `.ltr-island` and `.fade-right`. A repo-wide grep
finds **zero component usages** - only the definitions and the tests that assert
they exist. Meanwhile the step-navigation CTA is `{t("Next")} →` with
`← {t("Back")}` (`RequestBuilder.tsx:452,455`): bare text arrows outside `t()`,
so nothing can mirror them, and in RTL the "Next" button carries a glyph that
means "back". `dir` is also applied only after hydration - `layout.tsx:149` ships
`<html lang="en">` with no `dir` - so every Hebrew cold load paints LTR and then
flips.

> Note: the reported string "Proceed ->" does not exist in the repo. The audit
> traced the incident to `{t("Next")} →`. The mechanism is the same and the fix
> is unchanged, but the screenshot label should be re-confirmed against the
> running app before we call this closed.

## I-7 [P1] Cerebras is starred primary and serves 0 tokens / 14 calls / 14 failovers
**The honest answer is that this cannot be diagnosed from the repository, and
three attractive explanations were refuted.** All eight non-Gemini providers share
one body builder (`callOpenAICompatible`), so there is no request-shape
difference to point at. And contrary to the first read:

- Failures are **not** invisible. They are persisted durably (`ai_usage` with
  `failed = true`, awaited, `ai.ts:281` via `:538`) and surfaced fleet-wide by the
  owner Command Center, which queries `failed=eq.true` over 24h and raises a
  per-provider warning alert with a deep link to the Keys tab
  (`admin/command/route.ts:56-59`, `166-176`).
- `ai_usage.failed` is **not** write-only - that same route reads it.
- The `.trim()` asymmetry between the runtime path and the admin Test API button
  is real in the code but produces a **byte-identical wire request**, so it
  cannot be the cause.
- The default provider order returns **Groq first** (`ai.ts:91-99`), so the
  reported "Cerebras primary, fails over to Groq" pattern requires a non-default
  `AI_PROVIDER` configuration - worth confirming before anything else.

The one real gap: `CEREBRAS_MODEL` is documented as the live escape hatch for a
drifted model id, and **cannot be saved** - the Key Vault's `KEYS` allowlist has
no `*_MODEL` entries and `setKey` rejects anything absent from it.

So M20's first job is not a code fix at all: read the recorded error. The status
and body are already captured; the owner alert already points at them. If they
are not sufficient, add the model id actually served to the panel (a drifted
model id answering 400 is the leading hypothesis) and open the `*_MODEL` keys so
it can be corrected without a redeploy.

## I-8 [P2] Date buried in wizard step 2; summary header says nothing
The date picker shipped in Wave 2 and works; it is in step 2 of 4. Modules
8/9/24.

---

# PART 2 - THE 25 MODULES

## WAVE A - Stop the bleeding (P0, ships first)

### A.0 - hours-scale correctness, lands before anything else

Every item here is small, and three of them are currently making the system lie
about its own health. Nothing below can be verified properly until these land.

| # | Work |
|---|---|
| **A.0.1** Device fingerprint | `CONFIG_SESSION_PHONE_CLIENT` off the literal `WheelDeal` to a standard desktop client string; align `render.yaml`, `ANTI-BAN.md` and `GUIDE.md` so all three agree. Decide QR vs pairing-code deliberately, since the pairing path has no fingerprint control at all. Delete or fix the inert `CONNECT_FINGERPRINT` create-body fields so the docs stop describing a defence that does not exist. |
| **A.0.2** One rate system | `checkRateLimit`'s 15/hour + 60/day vs `PLAN_CAPACITY`'s 40/window currently fight, and the plan model loses silently. Pick one owner of velocity - the guard - and make the other strictly non-binding or delete it. Also drop the in-memory `MIN_GAP_MS` map in favour of the atomic `wa_send_claims` gap claim, which is the only one that works across instances. |
| **A.0.3** A dead session must read dead | Parse `statusReason` as a **number** (401/403/411/440/428/408), persist `"close"`, and make `isLinkedForUi`, `deriveConnectionPhase` and `classifySafety` all honour it. Today a banned traveller is told everything is fine and we keep queueing. |
| **A.0.4** Deaf-session detector | Out-of-band, at the app layer (we do not run Baileys and cannot call `sock.end()`): for a session that is `open` and has sent successfully but received nothing for N minutes during an active batch, force a reconnect. Rebase `/api/wa/health` so `live` requires `open` **and** recent inbound-or-successful-outbound, with a distinct third state for "open but deaf". |
| **A.0.5** Retract or repair failover | Either point every Evolution host at shared Redis so Signal keys travel with `creds`, or delete the false "ANY host can resume a session" claim at `evolution.ts:180-184` and the matching `render.yaml` guidance. |

### A.1 - the dispatch failure

Fixing the self-kick origin is a handful of lines and it un-freezes the entire
dispatch system.

| # | Module | Work |
|---|---|---|
| I-1a | **M18.0** One origin resolver | Replace `new URL(req.url).origin` with `publicRequestOrigin(req) ?? resolveSiteOrigin()` at all six self-kick sites, including the hop-chain continuations in `tick` and `reply-tick`. Add a test that no route builds a self-directed URL from `req.url`. |
| I-1b | **M18.1** Drains that finish | Deadline passed *into* `drainOutbox` so it declines to start a row it cannot finish, replacing the `Promise.race` abandonment in `activity` / `wa/status` / `replies`. `try/catch` per candidate in the drain loop with lease release + error event. |
| I-1c | **M18.2** The lane completes | `reply-tick` drains scoped `graph_wakeups`; `nextReplyDueMs` counts overdue rows; turn-lock claims get a lease; a failed `wa_recipient_state` read stops reclassifying a reply as a cold intro. |
| 0.2 | **M2** Anti-ban rebuild | Four vectors: `waves.ts` on `batchStagger`; uniqueness gate relocated *inside* `guardOutbound` after humanization + Supabase signature window + opener paraphrase; typing recalibration, sampled presence sequences, read-before-type, fleet-wide duty cycle on the scheduled tick, `clampToSenderWake`; age/velocity/health cap replacing `warmupFactor`; `fast_dispatch` off for cold. |
| 0.2 | **M2.1** Campaign wiring | The mass route never stamps `campaign` and never calls `campaignVerdict`, so `concurrentCampaigns` is unenforced there. **Downgraded from P0:** the verify pass showed concurrent runs by one user *are* already serialised - the partial unique index `wa_outbox_pending_auto_uidx` (`schema.sql:436-439`) makes "one pending rfq row per (sender, shop)" a database invariant. So this is correctness and owner control, not a burst hazard. |
| I-6a | **M23.1** Cache reader | The exact-key `I18N_` reader the comment already promises. Stops re-translating the catalogue on every cold load. |
| I-3 | **M22** WA Doctor | Resolve email to a real user; "no such user" is its own answer, never a red failure panel; user picker; per-user vs global checks labelled; add a presence probe and the dispatch check that would have caught I-1. |
| I-5 | **M17** Data integrity | One derivation for sent/queued/awaiting. `massNote` stops carrying numerals; "x of y" stops excluding replied shops; `senderSafety` stops re-deriving its own queue; every shop the traveller selected lands in exactly one visible bucket. |
| I-4 | **M6** Evolution resiliency | `--unhandled-rejections=warn` + memory ceiling on wd-evolution; gate the `/instance/create` storm behind a real absence check; health-aware single-host path; host-level breaker separate from the account stop-loss; `serviceDown` in `/api/wa/status` and a banner that says so. |

## WAVE B - Scale and correctness
| # | Module | Work |
|---|---|---|
| M7 | Concurrency | Webhook, drain-claim and Supabase hardening for hundreds of concurrent users. (The campaign/batch-claim half moves forward to Wave A as M2.1 - waves cannot be correct without it.) Also: the drain's 2-cold-per-invocation budget re-times rows by 2-4 min and would smear wave boundaries, so the wave size and the drain budget must be reconciled rather than left to fight. |
| M2.2 | Honest ETA | `computeQueueEtas` (`src/lib/wa/eta.ts:77`) models a continuous trickle and has no concept of waves; give `EtaRow` a wave index and advance the cursor to the wave start instead of accumulating gaps across boundaries. Both copy sites in `page.tsx` change with it. |
| M15 | Mass Bargain locking | Soft-block during list update; dim/disable already-contacted vendors, server-side and in UI. |
| M12 | Vector memory | pgvector on the existing Supabase - but first verify whether the memory already written is ever read. |
| M4 | Speed | Sync bottlenecks, un-memoized hot components, unbounded queries. |

## WAVE C - Product surface

### C.0 Radical transparency and the pricing overhaul

Owner directive: stop hiding the warm-up. The day-0 limit is not an embarrassment
to bury - it is the feature that protects the traveller's own WhatsApp, and the
product should say so in those words.

**First, a defect this uncovered.** There are two disagreeing price sources.
`plans.ts` computes Pro **₪5.40** / Ultra **₪29.40** (list × 20%), while
`UpgradeSheet.tsx:28` hardcodes Pro **₪16.50** / Ultra **₪88** with a comment
claiming these "match the PayPal billing plans exactly". Confirmed with the
owner: **₪16.50 / ₪88 is what PayPal actually charges**, so `plans.ts` has been
wrong. Unifying to one source is a prerequisite for touching pricing at all.

| # | Work |
|---|---|
| **C.0.1** Kill the launch discount | Delete `LAUNCH_DISCOUNT`, `listAmount` and `discountPct` from `src/lib/plans.ts`; ₪16.50 / ₪88 quarterly become the permanent base price and `plans.ts` becomes the single source. Remove the `line-through` list price (`UpgradeSheet.tsx:114`), the `{plan.discountPct}% off` chip (`:154`), the "Launch pricing: 80% off" line (`:249`), the admin copy (`admin/page.tsx:2339`) and "80% off launch" from the social card (`opengraph-image.tsx:62`). Delete the hardcoded `ILS_PRICES` map so there is one price in the codebase, not two. |
| **C.0.2** ~~Warm-up pricing~~ **CANCELLED - replaced by the warm-up GATE** | The 50% introductory quarter is withdrawn by owner decision. There is no discount of any kind: ₪16.50 / ₪88 quarterly is the price from the first day, and no PayPal introductory billing cycle is created. **What replaces it is not a price change but an access change** - see C.0.6 and Part 12.3. The reasoning is better than the discount's was: a discount pays people to tolerate a warm-up, whereas a gate makes the warm-up the thing they want to finish. Delete every remaining reference to an introductory rate along with the `LAUNCH_DISCOUNT` sweep in C.0.1 - one pass, not two. |
| **C.0.3** Say why, humanely | Applies now to the **gate**, not to a discount. The warm-up is explained, never merely enforced, and the explanation is about the user's own benefit rather than our risk model. Copy states what unlocks it and how close they are, and **never claims 100% protection** - if we promise that and a user is still restricted, the promise is the damage. Exact strings in Part 12.3. |
| **C.0.6** The warm-up gate | Paid plans cannot be **purchased** until the account is warmed up. Owner decision: warm-up is measured in **usage depth, not calendar days** - a committed traveller can unlock inside an hour, a tyre-kicker never does. This is a monetization and qualification device first; the account-safety benefit is real but secondary. Full spec, unlock predicate, copy, enforcement points and admin surface in **Part 12.3**. Supersedes Part 11 F3's days-based rule. |
| **C.0.4** Limits visible everywhere | Day-0 capacity (10 introductions, ramping to the plan budget over ~10 days) shown wherever capacity is shown today: the plan meters, the introductions budget in the queued panel, the Mass Bargain cap modal, the vendor-selection counter, and the `CAPACITY` table in `UpgradeSheet.tsx:38-44` which currently advertises the *uncapped* 10/30/40. |
| **C.0.5** Graceful throttle explanation | When a traveller selects 40 shops and the system will contact 10, say so in context, at the moment of the choice, with the reason and the unlock date - never a silent trim. This depends on M17: the mass route currently emits **no result row** for shops dropped before its loop, so those shops are counted nowhere and cannot be explained. Fix the ledger first, then the copy has something true to render. |

| # | Module | Work |
|---|---|---|
| M8/M9/M24 | Dates and gating | Lift start+end date out of the wizard into an always-visible panel; free tier same-day enforced both sides; Search disabled until vehicle+location+dates present; summary header states the actual query. |
| M3 | All-vehicle classes | Cars/scooters/motorcycles native across forms, prompts, parsers, filters. |
| M10 | Dual-axis vendor scrolling | Horizontal swipe alongside the vertical feed, without breaking virtualization. |
| M11 | Profile restructure | Declutter; every connection check becomes a shimmer, never a wrong answer. |
| M14 | Promoted / recommended shops | Admin panel + ranked placement + badge, on the existing badge system. |
| M23 | Translation + RTL | Wire format becomes `{id, text, role, maxChars, note}` instead of a bare string array; shared DNT list including "Will"; per-string output validation (type, non-empty, length ratio, expected script) replacing `String()` coercion; placeholder verification next to the existing `numbersPreserved`; catalogue membership enforced server-side. RTL: apply the four helper classes that already exist, replace bare `→`/`←` text nodes with a mirrorable component, set `dir` pre-hydration in the existing theme script. Owner-editable translation overrides so a bad string is fixable without a deploy. |

## WAVE D - Craft and observability
| # | Module | Work |
|---|---|---|
| M5/M16 | Aurora Glow loading | One shared primitive - iridescent edge glow, soft bloom, breathing gradient - reusing the existing Skeleton/LoadingDots/NavVeil rather than a parallel set. CSS-only where possible; respects `prefers-reduced-motion`. |
| M1 | UX sanity + defensive states | Offline, missing-data, slow-backend states everywhere; no dead ends. |
| M20 | AI keys telemetry | Per-provider tokens/calls/errors/failovers + charts; fix Cerebras; credit failover tokens correctly. |
| M21 | Engine Ops KPIs | Real metrics only - anything without a writer gets a writer or gets removed. |
| M19 | Purge "v3 engine" branding | Repo-wide sweep of user-facing strings. |
| M13 | PayPal + AdSense | Finish the subscription flow; banners away from primary actions. |
| M25 | Full audit + merge | typecheck x3, tests, build, e2e, master merge. |

---

# PART 3 - VERIFICATION

Per commit:

```
npm run typecheck && npm run typecheck:services && npm run typecheck:tests \
  && npx vitest run && npm run build
```

Specific to this plan:

- **I-1 gets an executed test, not a source pin** - an inbound webhook payload
  driven through ingest -> compose -> outbox -> claimed -> sent, asserting the
  terminal state and a wall-clock budget. Source pins are what let this survive:
  every mechanism in I-1 is in code that has tests, and none of them could see a
  URL that resolves to nowhere or a promise that is abandoned rather than
  cancelled.
- **An origin test** asserting no route constructs a self-directed URL from
  `req.url`, so this cannot regress by copy-paste into a seventh site.
- **A translation cache test** asserting a written `I18N_<lang>` row is readable
  by the reader the translate route actually uses.
- **Wave pacing gets a schedule test** - assert wave sizes land in 5-8, gaps in
  8-12 min, that `HARD_MIN_GAP_SEC` is never breached inside a wave, and that a
  day-0 ultra account cannot exceed its `ageRamp` cap.
- **Entropy gets a collision test** - 40 openers generated for one batch, asserting
  zero exact-hash collisions and zero pairs within `HAMMING_MAX`, and asserting
  the Supabase window is consulted when `REDIS_URL` is unset.
- **Counters get one test** asserting all three surfaces call the same derivation.
- Route-handler execution tests (the Wave 4 pattern in
  `src/app/api/route-execution.test.ts`) for every route this plan touches.
- Field verification per incident, listed against each item.

---

# PART 4 - COVERAGE CROSS-REFERENCE (directive -> plan)

| Directive item | Where |
|---|---|
| Exec: deploy sub-agents in parallel | 50-agent audit `wf_3cf3b5c2-a04` (10 investigate + 40 adversarial verify), 5M tokens; 19 of 34 findings refuted |
| Ext: pricing overhaul + radical transparency | Wave C.0 |
| Ext: Contacts API research | Part 0.35 section A |
| Ext: Local device routing research | Part 0.35 section B - proxy layer found already built |
| Exec: atomic master plan + cross-reference | This document + this table |
| Exec: 100% execution, verified | Part 3 |
| Constraint: 100% in-app, no wa.me / no tap-to-send | Context #1; no such item appears in any wave |
| Constraint: shops have raw numbers only, no forms | Context #2; no intake-form item in any wave |
| Constraint: leave cold outbound as-is for the user | Context #3; no opt-in or disclosure item in any wave |
| SLA 30-60 min end to end | Part 0.3, with per-plan arithmetic |
| Anti-ban 1: dynamic wave / staggered pacing, 5-8 per 8-12 min | Part 0.2 Vector 1 -> Wave A (M2) |
| Anti-ban 2: high-entropy paraphrasing, zero identical hashes | Part 0.2 Vector 2 -> Wave A (M2) |
| Anti-ban 3: human behaviour simulation | Part 0.2 Vector 3 -> Wave A (M2) |
| Anti-ban 4: adaptive throttling on age + chat velocity | Part 0.2 Vector 4 -> Wave A (M2) |
| Concept A: forced inbound | Principle confirmed (Part 0.36); mechanism blocked by the no-shop-forms constraint - dedicated research agent enumerating alternatives |
| Concept B: client-side / IP decoupling | Part 0.35 B + Part 0.36; proxy layer already built, IPv6 /64 under evaluation; burner accounts and fingerprint spoofing declined, Part 0.4 |
| Concept C: human emulation | Part 0.2 Vector 3 - typing recalibration, sampled presence, read-before-type, duty cycle, sender clock gate |
| Owner research doc 1 (Inbound Dispatcher, IPv6, baileys-antiban) | Assessed Part 0.36; adoptions listed, contradiction surfaced |
| Owner research doc 2 (physical-layer / on-device execution) | Assessed Part 0.36; iOS claim disproven, Play-policy blocker recorded |
| 50-agent WhatsApp architecture review | `wf_faf43825-3f8` - 20 domains, adversarial challenge, 4 syntheses, master ranking |
| Incident I.1 Agents frozen / queue stuck | I-1 -> Wave A (M18) |
| Incident I.2 Anti-ban overhaul | I-2 -> Part 0 -> Wave A (M2) |
| Incident I.3 WA Doctor failure chain | I-3 -> Wave A (M22) |
| Incident I.4 wd-evolution crash | I-4 -> Wave A (M6) |
| Incident I.5 Mass Bargain counter inconsistency | I-5 -> Wave A (M17) |
| Incident I.6 Hebrew gibberish / placeholder leaks | I-6 -> Wave C (M23) |
| Incident I.7 AI telemetry + Cerebras failover | I-7 -> Wave D (M20) |
| Incident I.8 Date picker + summary header | I-8 -> Wave C (M8/9/24) |
| M1 UX sanity + defensive errors | Wave D |
| M2 Anti-ban shield | Wave A + Part 0 |
| M3 All-vehicle classes | Wave C |
| M4 Speed | Wave B |
| M5 Shimmer / Aurora loading | Wave D |
| M6 Render resiliency + incident notice | Wave A |
| M7 Concurrency for hundreds | Wave B |
| M8 Global date picker + agent date awareness | Wave C |
| M9 Strict input validation before search | Wave C |
| M10 Dual-axis vendor scrolling | Wave C |
| M11 Profile restructure | Wave C |
| M12 Zero-cost vector DB | Wave B |
| M13 PayPal + AdSense | Wave D |
| M14 Promoted / recommended shops | Wave C |
| M15 Mass Bargain locking | Wave B |
| M16 Aurora glass animations | Wave D (with M5) |
| M17 Unified data integrity | Wave A |
| M18 Unblock dispatch queues | Wave A |
| M19 Purge v3 branding | Wave D |
| M20 AI keys telemetry dashboard | Wave D |
| M21 Engine Ops KPI dashboard | Wave D |
| M22 WA Doctor repair + auto-remediation | Wave A |
| M23 Translation engine + RTL | Wave C |
| M24 Prominent search summary header | Wave C |
| M25 Full audit + master merge | Wave D |
| **Pivot: cancel the 50% discount, regular pricing** | Wave C.0.2 (cancelled in place) + Part 12.3.1 |
| **Pivot: warm-up gate blocks purchase until enough usage** | Part 12.3 - predicate, four enforcement points, copy |
| **Pivot: monetization / lifecycle / segmentation dashboard** | Part 12.4.1, including the holdout cohort and time-to-warm |
| **Pivot: official business number sends the first message** | Part 12.1 - template, dynamic URL button, state machine |
| **Pivot: handle hundreds of concurrent users** | Part 12.2 - four budgets, service-window flush, fallback ladder |
| **Pivot: no conflicts with the current implementation** | Part 12.9 - ten named conflicts, each resolved; 12.8 flag contract |
| **Pivot: 100% clear to the user** | Part 12.9 items 9 and 10 - new consent, privacy section, lane-aware copy |
| **Pivot: humanizing / profile cycling research** | Part 12.5 - what is impossible and why, what is available instead |
| **Pivot: dedicated Business API management dashboard** | Part 12.4.2 - ledger, funnel, per-agency, live config, dry run |
| **Pivot: Infobip / provider prerequisites** | Part 12.6 - keys, webhooks, infrastructure, the rented-WABA caveat |
| **Pivot: drop proxies** | Part 8 Tier 2 (amended: paid items cut, $0 items kept) |
| **Pivot: be highly critical, name the bottlenecks** | Part 12.0 (three claims corrected), 12.2.1 (the real bottleneck), 12.5 |

---

# APPENDIX A - the 19 refuted claims

Recorded, not deleted. Each was plausible enough to be re-discovered by the next
person who reads that file, and re-litigating them costs more than a line each.

**Dispatch (I-1)** - `guardOutbound` lacking a `try/catch` in the drain loop is
real but has no reachable throw (every helper it awaits is individually
fail-safe): hardening, not a defect. A lost `claimOutboxRow` race does *not*
leave the lane dark - the winner PATCHes `not_before` to the lease, so the loser
sees a future row and re-arms. `reply-tick` not draining `graph_wakeups` is
harmless because the tick chain runner drains them on every hop.

**Evolution (I-4)** - the crash is not a floated Baileys rejection on stock Node
defaults; `render.yaml:14-19` records a thrown Prisma `OnWhatsappCache` error,
already addressed. `ensureConnected` is not a teardown/rebuild (no logout, no
delete). `resolveHost:568` is not a missing failover - the branch it skips would
return the same host. The stop-loss breaker "can never open" is moot because the
send path short-circuits earlier.

**AI (I-7)** - provider errors are *not* discarded: `ai_usage.failed` is written
durably and read fleet-wide by the Command Center's 24h alert. The token
`.trim()` asymmetry produces a byte-identical request. Default provider order is
Groq-first, so the reported failover pattern needs non-default config.

**Anti-ban** - the uniqueness gate is not bypassed by eight paths (every `auto`
send passes a universal per-recipient variance layer). Its position before
humanization is correct, not a bug - hashing per-recipient output would make
every message trivially unique. Cross-user signature storage already exists
(`recentOutboundGlobal`), so no new table is needed. Concurrent mass runs are
already serialised by the `wa_outbox_pending_auto_uidx` partial index.
`batchStagger`'s `offsets[]` is only an initial floor, not the wire schedule.
And `effectiveNewContactCap` ignoring age is the deliberate, test-pinned spec
from `d0f0ec4`, not an oversight.

**Translation (I-6)** - "a redeploy does not fix it either" was overreach; the
narrower and true claim (the `I18N_` cache is unreadable, and there is no runtime
lever to correct a string) survives and is in the plan.

---

# APPENDIX B - carried over from the previous plan

Shipped and live on master (`685b638`): fail-closed safety reads, the `t()`
cross-user leak gate, poll scoping, KILL_SWITCH at the send path, `setPlan`
failure reporting, entry-gate budget inversion, the `thread_key` fix that
un-broke substitution + accessories, the date picker, jitter reaching real sends,
the commitment rail on both engines, and the CI gate (build + test type-checking
+ first route-execution tests).

Still open from that plan, folded into the waves above: W3.2 (route user actions
through SPTE), W3.3 (M4.2 leverage on wakeups; M4.3/M26/M27 language stickiness -
one root cause, must be done together), the M9 concurrency harness, and
`readCallIntent` (unwired; needs a cost decision on per-message LLM
classification).

Owner-side, outside the repo: `delete from app_config where key like 'I18N_%';`
in Supabase, to clear the leaked dictionary rows, if not already run.

---

# PART 5 - TRANSPARENCY, MEASUREMENT AND THE 99% TARGET

> **Appended, not merged.** Nothing above this line was altered. This part is the
> third-phase review (`wf_2c26d1d1-cd4`, ~64 agents) covering the UI transparency
> layer, safety-rate measurement, and vectors the first two reviews did not reach.
>
> **VERIFICATION STATUS - read this before acting on Part 5.** 15 of 20
> investigations are integrated below. **The adversarial challenge pass had not
> yet run when these were written.** In the second review that pass refuted
> **19 of 34** findings - not usually reversing them, but correcting mechanisms,
> downgrading confidence, and killing conclusions that did not follow from their
> evidence.
>
> So Part 5 is **less verified than Parts 0-4**. Treat it accordingly:
> - Items grounded in code the agent read and quoted (the false safety promises,
>   the dropped `startDate`, `LIMIT_WA_PER_HOUR = 15`, the absent per-shop limit,
>   the missing rollout machinery, `syncFullHistory: false`) are strong - each
>   cites a file the agent opened.
> - Items that are *models* rather than observations - above all the
>   time-to-quote distribution, which rests on an assumed `q60 ~ 0.20` that the
>   agent itself flagged as unmeasured - are **hypotheses to test, not facts to
>   build on**. The recommendation there is to *measure* `q`, and that stands
>   regardless of whether the model is right.
> - Re-run the challenge pass, or verify by hand, before committing to anything
>   in 5.7 or 5.10 whose cost is more than a day.

## 5.0 The finding all six UI agents reached independently

**The app currently tells users it is safe in ways the code contradicts.** Six
investigations that were not told to look for this each found it, in different
files:

| Claim shipped to users | Reality |
|---|---|
| "Gentle warm-up" (`TrustPanel.tsx:13`) | `effectiveNewContactCap` discards `ageDays`/`warmupDays`. There is no warm-up. |
| "Business-hours-only sending" (`TrustPanel.tsx:15`) | `fast_dispatch` defaults ON and lifts the clamp. 3am sends are the default. |
| "Automatic pause at the first sign of risk" (`TrustPanel.tsx:17`) | The detector is dead (`statusReason` regex) and the delivery breaker was likely never armed. |
| "Goes to sleep when you're not using the app" (`WaConnect.tsx:378-383`) | `pauseIdleSessions` has one caller, fire-and-forget, on the inbound webhook only. |
| **"Your WhatsApp number is never put at risk"** (pricing page) | An absolute guarantee that the app's own Terms flatly deny. |

This is the most serious item in the entire third review, and it is also the
cheapest to fix. **Hours, not days** - and with no users yet, there is no
migration and no one to re-consent.

**A.0.8 [hours, critical]:** delete or rewrite every unconditional safety promise
in `TrustPanel.tsx`, `WaConnect.tsx:378-383`, `LandingFaq.tsx:21`,
`profile/page.tsx:433` and the pricing page. Each replacement claim must be one
the code honours **today**, or be gated on the config that makes it true. Ship
this in the same commit as A.0.1 - they are the same defect in two registers,
one facing Meta and one facing the user.

## 5.1 Nothing in the UI shows NUMBER state

The app has a genuinely good status layer - Live Status Panel, queue card with an
introductions meter, `WaSafetyBadge`, per-shop stage badges, `ThreadDashboard`,
activity feed - and it is scrupulously honest about **funnel** state.

There is **no surface anywhere for number state**: unanswered-introduction ratio,
delivery/read rate, cold-contact velocity, account age, dispatch mode, or "your
number is restricted". That is the exact axis both incidents fired on.

**New `NumberHealthPanel`**, mounted beneath `WaSafetyBadge` at
`page.tsx:~3500`, at eye level, no expansion required. Four rows, each label +
value + `InfoTip` using the existing `{label, what, drift}` contract:

- **New chats opened** - X of N this window (reuse the bar at `page.tsx:3319-3330`).
- **Still unanswered** - M of X. *This is the metered unit on the spam axis.*
- **Reaching shops** - delivered/read rate; below 8 samples show "not enough data
  yet", never a fake green.
- **Sending mode** - "Paced to shop hours" or "Fast - sending at any hour",
  driven by the real `fast_dispatch` flag.

Two more states the badge cannot currently express:

- **`burst`** - amber, "Opening N new chats - going carefully". `WaSafetyBadge`
  must be *incapable* of showing "All good" during a cold burst.
- **`restricted`** - a first-class state in the `SafetyFlag`/`SenderSafety` enum,
  with copy and a concrete recovery path. Until the detector is fixed, the app
  must **stop showing the reassuring pause line** when the truth is unknown.

Also: promote `WaSafetyBadge` out of the `vendors.length > 0` branch
(`page.tsx:3484-3500`) into global chrome, so number state is visible on every
authenticated screen rather than only mid-search.

## 5.2 The interrupt rule

> **A message that will still be true in ten minutes is not allowed to be modal.**

The repo has exactly one overlay primitive (`Modal`), one blocking gate
(`FirstTouchTerms`), one expand-in-place chip (`WaSafetyBadge`), one anchored
coach card (`WillGuideOverlay`), two colliding fixed top banners, and no toast
system. The palette is narrower than it looks, so the first job is repair.

**Interrupt budget: one non-dismissible surface per session, and it is spent on
consent.** Everything else is inline, expandable, or a chip.

| Message class | Vehicle |
|---|---|
| Irreversible-risk consent, before first link | `FirstTouchTerms` pattern - blocking, no backdrop tap, no Escape, server-recorded acceptance |
| Pacing explanation, first run | Inline block above `TrustPanel`, always shown, not dismissible, not modal |
| Live queue / wave state | Inline zone in the status panel |
| Number health | `NumberHealthPanel`, always visible |
| Restriction detected | Badge state + inline recovery card |
| Transient connection wobble | Connection pill, self-healing, no interrupt |

## 5.3 The copy

Voice, in one line: **your agent is being careful on purpose, and careful takes a
few minutes.** Not "we are protecting you from danger" - "this is how a person
sends messages."

Two rules behind every string: say what is happening and when it changes, never
why in mechanism terms; and never promise an outcome we do not control. The word
"guarantee" appears in exactly one place - where it is being withheld.

Five surfaces: first run, in-progress queue, day 0, deliberate hold, and
**restricted** - which the app cannot currently express at all, and today renders
as the soothing "Sending is taking a little longer".

Constraints carried from the existing plan: only short hyphens; every string a
**whole sentence** carrying `{n}`/`{time}` placeholders rather than
number-plus-fragment concatenation, which will not survive Hebrew/RTL; and all of
it through `t()` so the catalogue gate and the new placeholder validator apply.

Also delete the word "spam" - the current copy says "never spammy", which raises
the idea in order to deny it.

## 5.4 Consent, and the spare-number question

The traveller does not currently understand what they are authorising. The
honest sequence:

- **Signup - two ticks, not one.** Terms + Privacy; and separately, verbatim from
  `legal.ts CONSENTS[1]`, the unofficial-method/permanent-ban acknowledgement.
  Expand the "short, honest version" accordion by default.
- **Before the QR - a blocking risk screen.** Two cards from
  `INDEMNITY_CLAUSES` (`whatsapp-bans`, `misdirected-messages`), summary visible,
  full clause expandable, one button, no skip.
- **"Which number is this?"** - a mandatory step immediately before pairing:
  primary or spare, consequence stated for each, **spare pre-selected**. This is
  the single highest-value onboarding change available: it costs one tap and it
  moves the entire risk off the user's primary identity.

> Note: this does **not** reverse the earlier "leave it as-is" decision. That was
> about not gating cold outbound behind an opt-in. This is about not making false
> promises and letting people choose which number they link - which is a
> different thing, and cheaper.

## 5.5 Progress legibility, and M17 is worse than reported

M17 said three counters disagree. It is **four live derivations plus a fifth dead
one**, and `page.tsx:2996` renders `Math.max()` of two of them - the app picks
which of its own numbers to believe at render time.

The fix is structural: **one server-side monotonic rung per shop**, extending the
`STATE_RANK` rollup at `activity/route.ts:264-290` from 3 rungs to 8 plus
terminals, shipped as one field every counter, badge and bar reads. Delete the
client-side partition at `page.tsx:2426-2481` so no second derivation can exist.

Status panel, three zones, all driven by one `shopStates` field:

1. **Dispatch rail** (while outbox rows remain) - "12 of 20 shops reached - next
   ~14:32-14:36 - all reached by ~14:51", determinate bar. When the last row
   leaves, it collapses once into a grey receipt line. **That collapse is the
   phase-change event the middle of the wait currently lacks.**
2. **Reply funnel** (primary after handover) - Reached / Delivered / Opened /
   Replied / Quoted on one track.
3. Per-shop detail, unchanged.

Promote delivery and read receipts from the per-shop sheet to the session level.
And hide the read rung entirely when read receipts are unavailable, rather than
showing it pinned at zero - rule: after `delivered >= 5` with zero reads, the
rung is unsupported, not empty.

## 5.6 The polling tier is the scale bottleneck, and it does write-work

Three independent pollers, ~24 requests/min/user. `/api/activity` costs roughly
**21 Supabase round trips per tick** and performs **two awaited 8-second
WhatsApp drains before it reads anything**.

At 300 concurrent users: ~117 HTTP req/s to Cloud Run but **~1,300-1,400
PostgREST queries/s** to Supabase, and ~26 MB per user-hour of
mostly-unchanged JSON - **$170-670/month in egress alone**, plus the traveller's
own roaming data, which for a backpacker abroad is a real cost we are imposing.

Latency is already fine. The problem is that the tick is expensive and mutates.
Three fixes, in order:

1. **Take the drains out of the read routes.** Move `drainOutbox` /
   `drainGraphWakeups` off `/api/activity` and `/api/replies` onto the scheduler
   heartbeat and the worker tier. A read endpoint must not dispatch WhatsApp.
2. **Change-detection watermark.** Give `/api/activity` a `cursor`; answer with
   1-2 indexed `max()`/`count()` queries and short-circuit when nothing moved.
3. **In-flight guard + phase-aware backoff** - skip a tick if one is in the air;
   stretch 6s to 20-30s once nothing has moved for a few minutes.

**Connection pill** in the funnel header, replacing the binary `feedStale` flag,
with four honest states - never a green "Live" while the channel is degraded:
Live / Reconnecting (only after 3s) / Checking every 30s ("nothing has moved for
a few minutes", tap to refresh) / Offline. The backoff becomes legible instead of
feeling like a freeze.

## 5.7 The 99% target, answered properly

You asked for 99%+. Here is the honest answer, with the arithmetic.

**Today the number would be 0/0.** "Ban" currently denotes four distinct events
that the code treats as two; the denominator is never recorded; and both
principal observables are broken. There is no quantity to be 99% of.

### The denominator changes the answer by an order of magnitude

- **Per cold introduction** - the natural engineering unit - makes 99% a
  *catastrophe*: one restriction per hundred introductions is a dead product.
- **Per account-month** flatters the rate by roughly **4x**, because exposure is
  a *trip*, not a month. A traveller is exposed for the days they are searching.
- **Per account-trip** is the honest unit. Adopt it and say so.

### The two axes separate statistically, and only one is measurable

| | R1 scoped restriction (velocity) | R2 full ban (client detection) |
|---|---|---|
| Cause | unanswered cold volume | unofficial-client fingerprint |
| Measurable? | **Yes** | **No, at our scale** |
| Sample to separate 99% from 95% @80% power | **110 account-trips** - about two weeks at 300 trips/month | **~1,750 account-trips** with modest intra-cluster correlation |

**And the R2 number is optimistic.** R2 is *fleet-correlated common-mode* risk,
not per-account risk. Every account shares one config. In the limit where Meta
ships a single rule keyed on `CONFIG_SESSION_PHONE_CLIENT=WheelDeal`, **the
effective sample size is 1** - the outcome is 100% or 0% for the whole fleet
simultaneously. No per-user rate describes that, and no amount of pacing changes
it.

That is the strongest possible argument for shipping A.0.1 today, and it is
independent of everything else in this plan.

### Two more reasons the naive rate would lie

- **R2 is unobservable by construction.** Three independent defects, each alone
  sufficient. The numerator for the event you care most about is *structurally
  pinned at zero* - so a dashboard built today would read 100% safe forever.
- **Observation is informatively right-censored.** Bans land after the trip ends,
  and a banned user does not come back to tell you. Naive counting will
  systematically under-report exactly the outcome that matters.

### So the target becomes

> **R1: a measurable 99% per account-trip, verified over ~110 trips.**
> **R2: not a rate. A single shared-fate risk, managed by removing the shared
> fingerprint and by config-fingerprint cohorting, and reported as a fleet event
> rather than a percentage.**

State it that way in the plan and in any owner dashboard. A single blended "99%
safe" number would be the most misleading artifact we could build.

## 5.8 We cannot measure anything yet - the system records state, not events

Every safety signal is a **mutable scalar on one `whatsapp_number_reputation` row
per user, overwritten on every send**. After a restriction you can read what the
counters are *now* and nothing about the preceding 72 hours.

Three compounding defects:

- The cold-intro "ledger" is not data - it is re-derived on every read from an
  **unindexed JSON convention** (`raw->>kind='rfq'`) that any of **13**
  outbound-writing call sites can silently break.
- The window query is capped in the wrong direction: **ascending with
  `limit=200`**, so past 200 rows it keeps the *oldest* week-prefix and discards
  the most diagnostic recent ones.
- Every telemetry read returns `[]` on failure, so "no activity" and "could not
  read" are indistinguishable - and the engagement breaker's own blindness
  renders as a healthy zero.

**Four additive tables** (schema is additive-only):

| Table | Purpose |
|---|---|
| `wa_account_timeline` | Append-only per-account event log: `sender_key, at, event, to_key, thread_key, wa_message_id, trace_id, lane, config_fingerprint, policy_version` |
| `wa_cold_intro` | One row per (account, shop) first contact, with **explicit resolution** - this is what makes the unanswered count real rather than derived |
| `wa_restriction_incidents` | The labelled register that supplies the numerator: `detected_at, onset_at, event_class R1-R4, evidence_json` |
| `wa_account_day` | Daily rollup for the exposure denominator |

Plus a versioned **measurement spec** written *before* any detector code, fixing
the four-event taxonomy (R1 scoped / R2 full ban / R3 silent throttle / R4
recipient block) and the account-trip denominator.

## 5.9 There is no rollout machinery, and the governance is exactly inverted

`canary`, `cohort`, `rollout` and `feature_flag` return **zero hits across
`src/`**. Every anti-ban knob change is a 100%-of-fleet change that lands within
~60 seconds and cannot be rolled back to any prior value - `setPolicy` is a blind
upsert with no author, no previous value, and no `agent_events` row.

The inversion, stated plainly:

| | Governance | Worst case |
|---|---|---|
| Negotiation policy | versioned, golden-replay gated, one-click rollback, owner-only | a bad haggle |
| `whatsapp_security_policies` | bare upsert, any management session, no version, no audit, no undo | **a traveller loses their personal WhatsApp** |

**And you cannot run a canary against a sensor that does not work.** The
restriction detector is dead, so a canary account can be restricted and the
system will keep queueing for 24 hours and never tell you.

Order of operations, non-negotiable:

1. **Fix the outcome sensors** (A.0.3 + the R2 detector repair). Nothing else in
   this section is meaningful before this.
2. **Promote the anti-ban policy set to a versioned artifact** - route every
   `whatsapp_security_policies` write through `saveVersionedSpec`, the machinery
   that already exists for negotiation policy. Same rigour, higher stakes.
3. **Add a per-user cohort tag** as the flag primitive - extend `BetaEntry` with
   `cohort` (note: `saveBetaAllowlist` currently *drops unknown fields*, so this
   needs care), and gate every capacity change on it.
4. Only then run capacity changes against a canary cohort.

## 5.10 The 1-hour promise, quantified - and one half of it is impossible

**The binding constraint is not wave pacing.** It is `LIMIT_WA_PER_HOUR = 15`
(`evolution.ts:100-165`) - a **single hourly pool shared between cold
introductions and negotiation replies**, applied on every drain path. Breadth and
depth are in direct competition inside the SLA window.

That makes the SLA arithmetic, not opinion. To land **K** quotes you need roughly

```
B  >=  K/q + K*t
```

where `q` is the per-shop probability of producing a price inside the window and
`t` is agent turns per negotiation. At **K=3, t=2, B=15** the promise only closes
if **q >= 0.33**.

**`q` has never been measured.** There is no reply-rate or reply-latency data
anywhere in this repository, and external "WhatsApp response rate" benchmarks
measure the opposite direction (a business answering an inbound customer) from
low-quality marketing sources. Every number below is a model output, not an
observation - which is itself the finding.

Under a central assumption of `q60 ~ 0.20`, a day-0 batch of 10-12 shops gives:

| Outcome | Probability / time |
|---|---|
| At least one quote within 60 min | **~90%**, median first quote **18-22 min** |
| Three quotes within 60 min | **~40%** |
| A *bargained best* price within 60 min | **arithmetically impossible at any safe budget** |

**So the honest promise is "your first real quotes within the hour", not "the
best local price within the hour".** The bargaining that produces the best price
needs turns, and turns need budget that competes with breadth. Say the true thing
in the pricing and SLA copy - the current promise cannot be kept at any capacity
setting we would be willing to ship.

Two changes follow directly:

- **Split the single hourly pool** into an age-gated cold-introduction budget
  (small) and an engaged-reply budget (large). Today one number meters both, and
  the reply lane - which is *safe* traffic on the documented axis - is being
  starved by the cold lane, which is the risky one. This is backwards.
- **Add a per-introduction latency ledger** - `dispatched_at`, `delivered_at`,
  `read_at`, `first_inbound_at`, `first_price_at`, terminal outcome - and report
  `q30`/`q60`/`q24h` and `t`. Until `q` is measured, every SLA claim is a guess.

Also note, from the same analysis: **no pacing regime moves the 99% target**,
because the full-ban axis is invariant to message volume and fires on reply-only
accounts. Pacing buys R1, not R2.

## 5.11 Cross-user shop saturation - the largest unaddressed risk at scale

**There is no per-shop limit of any kind in this codebase.** Every rate, budget,
cap, dedupe and reputation record is keyed on `sender_key` - the traveller's
email. Per-shop inbound volume scales linearly and unbounded with fleet density.

And the overlap is not statistical, it is **engineered**:

- `rankForMassBargain` is a **pure total order with no user-dependent term**. Two
  travellers in the same place get the identical shop list in the identical
  order, and each take the top 15.
- The Places result cache key **rounds coordinates to ~110 m**, so travellers in
  the same hotel district literally share one cached 20-shop result set.

The arithmetic: N concurrent travellers in one district produce roughly
**15N/20 introductions per shop per round**, and the **#1-ranked shop receives
100% of them**. At a few dozen users in Canggu, one shop owner gets cold-messaged
by dozens of different foreign numbers in a day - all from our system.

**And we would never know.** A block lands on the *traveller's* number, is
recorded per (sender, shop), and is invisible to every other user. Worse: the
`blocked` flag is set only on a send **error**, which WhatsApp never returns for a
real block - so **it has essentially never fired**.

Three changes, all days-scale:

1. **Canonical shop key + `shop_contact_ledger`.** Add `to_key` to
   `whatsapp_messages`, stamped with `outboxKey(digits)` at both insert sites, so
   per-shop volume becomes queryable at all.
2. **`shopIntakeVerdict(shopKey, senderKey)`** in `guardOutbound`, applied
   **only** to cold intros (`meta.kind === 'rfq'` and not a known contact), never
   to replies in an existing thread.
3. **Enforce at selection time, not send time**, and **widen the candidate pool**
   so a refusal becomes a *substitution* rather than a dropped shop. Add a
   user-dependent term to the ranking so two travellers at the same hotel do not
   receive an identical ordering.

This is the one safety quantity here that is cheap, directly instrumentable, and
currently at zero.

## 5.12 The best anti-ban finding in three reviews: our opener is unanswerable

An agent compiled the **real** openers by running `promptCompiler.ts` and then
applying the exact downstream guard transforms - the wire text, not the source
pools. What a shop actually receives is worse than the templates suggest:

- **It never says when the rental starts.** `startDate` is collected in the UI
  and **silently dropped by `compileOpener`**.
- **~35% of Thailand/Philippines messages ship a detached politeness particle** -
  "Hi! po!", "Hey! krub!" - because `wa-guard`'s greeting swap eats the greeting
  word and leaves the particle stranded.
- One-day rentals read **"for 1 days"**.
- Every car opener reads **"an automatic suv car 5 seats"**.

The artifacts are embarrassing, but they are not the fatal property. **The
message asks for a price while giving no date.** It is therefore *unanswerable* -
a shop owner cannot quote without knowing when. The honest reading from the other
end is "reseller fishing for rates", **which is exactly the message people block
rather than reply to.**

That matters more than any pacing constant, because on the documented axis a
**reply refunds the quota**. A message people want to answer is not merely
politer - it is mechanically the strongest anti-ban measure available, and it is
the one we have been getting wrong.

Three changes:

1. **Put the dates back and lead with availability, not price.** Render
   `startDate` (and the return date when known) in every skeleton, and open with
   "Do you have X available on <date>" rather than a bare rate request. This is
   the change.
2. **Make the guard particle-aware** - `GREET_SWAPS` should consume an optional
   trailing `po|krub|ka` with the greeting, or exempt any greeting followed by one.
3. **A wire-text golden gate.** Freeze ~40 compiled-then-guarded openers
   (scooter/car x 1/3/30 days x each region, with and without extras) as
   snapshots and assert mechanical invariants: no "1 days", no stranded particle,
   a date always present, no stacked adjectives. Every prior review tested the
   *pools*; nobody tested the *wire*.

## 5.13 Warm-up: three of four mechanisms are dead, and reputation is mis-keyed

- **The companion does not sync history.** `syncFullHistory: false` is written on
  every `instance/create` path and is test-pinned. The "existing chats give the
  account organic reciprocity" idea is **disproven by our own config**.
- **Self-chat is theatre.** No counterparty; under an unanswered-outbound meter it
  is at best exempt and at worst a debit.
- **A shared support thread inverts into fleet risk.** One WheelDeal support
  number in every user's contact graph is **a ready-made cluster key** - the same
  common-mode failure as the phone-client string.
- **Only "require account age" is honest** - and we cannot measure WhatsApp
  account age at all, nor do we record when a session was first linked.

Two prerequisites, both days-scale:

- **`wa_sessions.first_linked_at`**, set once and never overwritten. Without it
  there is no tenure to gate on.
- **Stop keying reputation on email alone.** Store the linked phone JID on the
  reputation row and **quarantine or reset reputation when the JID changes** -
  otherwise a user who re-links a different number silently inherits the old
  number's standing, in either direction.

And present the warm-up ladder to the owner as **an explicit speed-vs-safety dial
with the cost stated**, not as a silent fix. `capacity.test.ts` pins the current
behaviour as intended, so this is a product decision being reversed, and the code
and the test should both say so.

## 5.14 Appended ordering

These slot into the existing sequence in Part 0.9 without displacing anything:

| Slot | Work | Size |
|---|---|---|
| With **A.0.1** | **A.0.8** Delete the false safety promises | hours |
| With **A.0.6** | Take the WhatsApp drains out of `/api/activity` and `/api/replies` | hours |
| After **M17** | One monotonic rung per shop; delete the client partition; three-zone status panel | days |
| Wave A tail | `NumberHealthPanel`; `burst` and `restricted` badge states; promote the badge to global chrome | days |
| Wave A tail | The five-surface copy set, as whole-sentence `t()` strings | days |
| Wave C | Consent sequence + "Which number is this?" (spare pre-selected) | days |
| Wave B | Activity cursor + backoff + connection pill | days |
| With **A.0.2** | Split the hourly pool: age-gated cold budget + large engaged-reply budget | days |
| Wave A tail | `shop_contact_ledger` + `to_key` on `whatsapp_messages` + `shopIntakeVerdict` for cold intros only | days |
| Wave A tail | Per-introduction latency ledger, so `q` becomes measured rather than assumed | days |
| Wave A tail | Measurement spec + the four append-only tables + versioned `wa_policy` + cohort tag | days |
| Wave B | Selection-time shop budget, widened candidate pool, user-dependent ranking term | days |
| Wave C | SLA copy tells the truth: first quotes within the hour, not the best price | hours |
| **With A.0.1** | **Put the date back in the opener; lead with availability.** Highest-leverage anti-ban change found in three reviews, and it is a compiler fix | hours |
| With the above | Particle-aware `GREET_SWAPS`; kill "1 days" and "an automatic suv car 5 seats" | hours |
| Wave A tail | Wire-text golden gate: ~40 compiled-then-guarded openers frozen as snapshots | days |
| Wave A tail | `wa_sessions.first_linked_at`; key reputation on the linked JID, not email | days |

---

# PART 6 - OWNER DIRECTIVES OF THE FOURTH ROUND, AND WHAT THEY SETTLE

> **Appended, not merged.** Nothing above was altered.
>
> **Research status: the fourth-phase workflow returned nothing.** All 24 agents
> failed on `You've hit your session limit - resets 1:10pm UTC`. Three prior
> rounds (177 agents, ~11M tokens) consumed the budget. Part 6 is therefore **my
> own analysis against prior verified research**, not new sub-agent output. The
> genuinely unresearched domains - the risk dashboard, the tone audit, the
> line-level critique - are queued and should be run once the limit resets.

## 6.1 Constraints added by the owner (binding on everything above)

1. **Absolute shop choice.** If a traveller selects a shop, we contact it. No
   refusal, no silent redirect. **This retires the per-shop budget gate proposed
   in 5.11** - that design is rejected and must not be revived.
2. **No global inter-user queue.** Any per-shop pacing must be a *signal that
   informs ordering*, never a gate that serializes users.
3. **No cross-user price caching.** *(Withdrawn by me; see 6.2.)*
4. **Day-one breadth is the product.** A new paid user wants 20-30 shops on day
   one, free tier 10, with a complete quote inside the hour. Protection must be
   invisible.
5. **Tone.** Operational pacing is framed as quality control and vendor batching.
   The phrase "avoiding a WhatsApp ban" appears only at account linking/consent.
6. **Budget: one-time up to $300** authorised for tools, infrastructure or
   licences that materially improve protection.

## 6.2 Cross-user price caching - proposed by me in 5.0-5.11, now withdrawn

The owner is right and the idea was wrong. Rental quotes are per-customer: season,
vehicle condition and model year, duration, add-ons, and the traveller's own
negotiating position all move the number. Serving a price derived from another
traveller's negotiation would show a figure that is not this user's, which is a
product failure regardless of how carefully it were labelled.

**Consequence, stated plainly.** That was the one lever which reduced cold volume
*without* touching user choice. Without it, **cold volume is irreducible** - every
selected shop receives a real first message from the traveller's own number. Safety
must therefore come entirely from *how* those messages are sent, and no
architecture makes 25 cold introductions from a day-old personal number look like
anything other than what it is. Everything in Part 6 is bounded by that.

**What survives from 5.11** (none of it gates a chosen shop): the
`shop_contact_ledger` and `to_key` so per-shop load is *measurable*; discovery-layer
diversification (widen the pool, add a user-dependent ranking term, stop the ~110 m
Places cache key handing identical lists to travellers at one hotel); and fixing the
`blocked` flag, which sets only on a send error and has therefore never fired.

## 6.3 The three named strategies

### Device-bound proxying - partly settled, and the $300 changes the live option

Settled by prior research: Baileys' `SocketConfig` has **no `localAddress`**; the
only injection point is `agent`, which Evolution constructs itself from proxy
fields. The phone cannot be an exit node - iOS suspends background sockets, and
Android would need a foreground service plus a reverse tunnel through carrier NAT.

**What the budget makes real:** mobile-carrier (4G/LTE) residential proxies,
country-matched to the destination, one exit per small cohort. Roughly $50-150 per
month for a handful of exits. It uses the layer **already built** at
`evolution.ts:231-270` and **currently switched off** - today every traveller
egresses from one shared Render Oregon range.

Four defects to fix alongside enabling it (from Part 0.37): `parseProxy` runs only
at link time; the failover recreate sends no proxy fields; the pin is a mod-hash
that remaps everyone when the pool resizes; and there is no country input at all.
Also verify the proxy actually applied (`/proxy/set` response plus `/proxy/find`)
before treating a session as safe for cold outreach.

Frame it honestly: **blast-radius containment, not prevention.** It caps how many
accounts share a fate; it does not change the behavioural signal.

### Forced inbound - settled, and it is not an engineering task

Google Business Messages **shut down in July 2024**. Of twelve mechanisms
enumerated in the third review, exactly one satisfies zero-user-effort,
no-app-exit and per-traveller inbound: **shop-side partner onboarding**. That is
supply-side business development, months per city. It remains the only design that
removes ban risk from the traveller entirely, and it belongs on the strategy
roadmap rather than in a wave.

Click-to-chat shortlinks and relay nodes both require the shop to tap something,
which needs a channel to reach them - the websites and forms the owner has
established do not exist.

### Noise-tunnel manipulation for an "undeniable signature" - declined

Binding traffic to a legitimate origin is fine and is covered above. Forging the
client fingerprint so Meta cannot distinguish our unofficial client from the
official app is **detection evasion of a platform's anti-abuse enforcement**, and
it is declined.

The engineering reason is as strong as the policy one: it fails on its own terms.
Prior research established two enforcement axes, and unofficial-client detection
carries the **full-ban** penalty - the one that lands on the traveller's personal
number. A fingerprint that is merely harder to detect delays that outcome and
raises its cost when it arrives.

**And the shape of the problem is the opposite of what "undeniable" implies.** The
`CONFIG_SESSION_PHONE_CLIENT=WheelDeal` string means a single rule catches the
entire fleet simultaneously - the third review's statistician put the effective
sample size at **1**. The fix is to stop being identifiable *as a fleet*, not to
become unfalsifiable.

## 6.4 What the $300 should actually buy

Ranked by protection per dollar, given everything above:

| | Item | Cost | Why |
|---|---|---|---|
| 1 | **Mobile/residential proxy exits**, country-matched, per cohort | ~$50-150/mo | Uses the built-and-disabled layer; ends single-range co-tenancy |
| 2 | **A burner WhatsApp number + cheap prepaid SIM** as a canary | ~$20 one-off | Prior research: *you cannot run a canary against a sensor that does not work* - so this comes after the detector repair, and then it is the only way to test a capacity change without risking a real user |
| 3 | **A second Evolution host** with its own DB/Redis and a unique `DATABASE_CONNECTION_CLIENT_NAME` | ~$10-25/mo | Splits the shared-fate config so one rule cannot catch everyone. Do **not** add hosts before per-host instance ownership is fixed |
| 4 | Log sink for Evolution container logs | ~$0-10/mo | Bad MAC and the deaf-session warn line are currently invisible |

Item 3 is the only purchase that addresses the fleet-correlated axis, and it is
cheap. It should be read together with A.0.1, which is free.

## 6.5 Still to research when the limit resets (1:10pm UTC)

Queued and genuinely unresearched - none depends on anything settled above:

- **The Ban Risk Management Dashboard** - metric inventory, real-time risk model,
  fleet-scale aggregation and common-mode exposure, and the page IA. Directive 4.
- **Full UI tone audit** - every user-facing string reframed to quality control
  and vendor batching, with the consent step keeping explicit risk language.
- **Line-level codebase critique** - races, performance, data integrity, and a
  brutal read of this plan for contradictions and sequencing errors.
- The five domains the third round never reached: queue architecture, quota
  accounting, cost model, legal posture, residual vectors.

---

# PART 7 - FIFTH ROUND: THE RESTRICTION SIGNAL WE ALREADY RECEIVE

> **Appended, not merged.** Research run `wf_4a3635ba-90c`. Integrated as results
> land; the challenge pass had not run when these were written.

## 7.0 Two corrections to things I asserted

**I was wrong that Baileys implements the quota API in our version.**
`fetchNewChatMessageCap` and `fetchAccountReachoutTimelock` **do not exist in
7.0.0-rc.9**, the version Evolution v2.3.7 pins. They shipped in **rc10**
(2026-05-06) and are absent from all 6.7.x.

**That turns out to be good news.** Both are ~15-line wrappers around a generic
`w:mex` IQ that rc.9's socket **already supports** through its public `query()`
and `generateMessageTag()`. So the cheapest path is a **~120-line Node
`--require` preload patch on the stock Evolution image** that reissues the same
two persisted-GraphQL queries. **No Baileys bump, no Evolution fork, no new
infrastructure, ~$0 marginal cost.** A full runbook was written to
`before-everything-launch-your-wondrous-steele-agent-a7be37aaec535b235.md`.

Also richer than I described: `NewChatMessageCapInfo` carries `total_quota`,
`used_quota`, `cycle_start_timestamp`, `cycle_end_timestamp`,
`server_sent_timestamp`, `ote_status` and more - so the cycle window is served,
not inferred.

## 7.1 THE FINDING: the restriction signal is already arriving, and we discard it

**WhatsApp's 463 new-chat restriction surfaces today as an Evolution
`MESSAGES_UPDATE` with `status: "ERROR"` on a `fromMe` key.**
`src/lib/wa/ingest.ts:187-206` only looks for delivery and read, so **it is
dropped on the floor.**

Every prior round concluded we had no working restriction detector and would need
to build one. **We do not.** The ground truth is on the existing webhook, and the
fix is extending one branch in `ingest.ts` - **hours, no new infrastructure, no
preload patch, no burner account.**

This is the highest-priority item in Part 7 and it should ship before anything
else in this section. It is also the prerequisite the third round named: *you
cannot run a canary against a sensor that does not work.* The sensor exists.

## 7.2 Proxy: the architecture is simpler than a pool, and two fixes are free

**Not a pool of proxy URLs - one residential gateway plus a per-user sticky
session token persisted on `wa_sessions`.** That dissolves the mod-hash remap
defect entirely, because there is no pool to resize.

**Two zero-cost changes that must land before any purchase:**

1. **Set `PROXY_HOST` / `PROXY_PORT` / `PROXY_PROTOCOL` / `PROXY_USERNAME` /
   `PROXY_PASSWORD` on the Evolution container.** Evolution's `loadProxy` reads a
   server-wide env proxy as a fail-closed default, overridden per-instance by the
   DB row. Setting it makes **naked datacenter egress structurally impossible**.
2. **Stop sending proxy fields on `/instance/create`.** `testProxy` throws 400
   **after** the Instance row is saved and registered in `waMonitor`, and our
   legacy flat-retry then pairs the user **on the datacenter IP, silently**. A
   momentarily unreachable proxy currently produces exactly the outcome the proxy
   was bought to prevent.

**Three more mechanics worth knowing:**

- Evolution **persists proxy config per instance and re-applies it on reconnect
  and host boot** - so it does not need re-asserting on every send, only after
  teardown.
- **`/instance/delete` cascades the Proxy row away.** Our `opts.fresh` path
  (logout + delete + recreate) therefore **destroys the user's proxy assignment
  every time they tap "Try again"**.
- **`POST /proxy/set/{instance}` is a real verification primitive**: Evolution
  fetches `icanhazip.com` directly *and* through the proxy and requires the two
  to **differ**. A 201 proves the proxy is actually carrying traffic - this is
  the "verify it applied" check prior rounds asked for, and it already exists.

**Correct sequence for `connectInstance`:** create with `qrcode:false` and **no**
proxy fields → `POST /proxy/set` (must return 201) → `/instance/connect?number=`.
On a `/proxy/set` failure, `/instance/delete` and refuse to link rather than
falling through to naked egress.

**Country:** match the **traveller's number**, pinned for the life of the link.
Do not chase them mid-trip - that buys a forced socket teardown and a fresh IP
with no history, for a benefit ranked third behind simply "not a datacenter ASN".

**Config shape** (Admin -> Keys, scope `messaging`):

```
EVOLUTION_PROXY_TEMPLATE        socks5://USER:PASS_country-{country}_session-{session}_lifetime-7d@<gateway>:<port>
EVOLUTION_PROXY_COUNTRY_DEFAULT th
EVOLUTION_PROXY_COUNTRY_ALLOW   th,id,vn,in,ph,my,sg,kh,np,lk,co,pe,br,ar,mx,il,gb,de,fr,us,au
EVOLUTION_PROXY_REQUIRED        on          # fail closed at link time
EVOLUTION_PROXY_MAX_PER_EXIT    3
```

Plus `wa_sessions.proxy_session_id` - minted once, never rotated automatically.

## 7.3 Revised ordering for Part 7

| # | Work | Size | Why here |
|---|---|---|---|
| 1 | **Error-ack restriction detector** in `ingest.ts:187-206` - handle `status:"ERROR"` on a `fromMe` key | hours | The ground-truth signal is already on the wire. Everything measurement-related depends on it |
| 2 | `PROXY_HOST` env on the Evolution container | hours | Makes naked datacenter egress impossible by construction, before spending anything |
| 3 | Re-sequence `connectInstance`; stop proxy fields on `/instance/create` | days | Today a transient proxy failure silently pairs the user on the datacenter IP |
| 4 | Persisted `proxy_session_id`; retire `EVOLUTION_PROXY_POOL` and the mod-hash pin | days | One gateway + sticky token; no pool to resize |
| 5 | Preserve the proxy row across `opts.fresh` | hours | "Try again" currently discards it |
| 6 | `w:mex` preload patch for the two quota queries, then a **live burner probe before any capacity logic consumes the number** | days | ~$0, no fork - but verify the response shape on a real account first |

## 7.4 The engagement loop does NOT compound breadth - I was wrong

I told the owner the reply-refund loop was the lever for 20-30 day-one
introductions. **It is not.**

Baileys' own type for the cap - `total_quota` / `used_quota` with
`cycle_start_timestamp` / `cycle_end_timestamp` - describes a **monotone
per-cycle accumulator, not a refundable concurrency meter**. Even under the
optimistic refund model the multiplier within one hour is only:

| reply rate `q` | breadth multiplier |
|---|---|
| 0.10 | **1.09x** |
| 0.20 | **1.18x** |
| 0.35 | **1.35x** |

Not 3x. **20-30 on day one is reachable only by raising the starting budget `B`
to roughly 18-25.**

Re-denominating in unanswered threads remains correct and necessary - but its
real job is different from what I claimed: **it makes a higher starting budget
defensible**, by capping the risk-bearing quantity (open unanswered threads)
rather than raw sends, and by making follow-ups free. That is a better argument
for day-one breadth than the refund loop was, and it is honest.

**Three defects make the loop unimplementable today:**

1. `wa_recipient_state` rows are **split across phone spellings**, so a reply
   lands on a different row than the send that caused it. Canonicalise on the
   phone tail (`numberVariants` / `TAIL_LEN`, the tolerance `numberFilter`
   already uses) before anything else here.
2. `introductionsInWindow` groups by **raw `to_number`**, inheriting the split.
3. The introduction ledger lives in a `whatsapp_messages` JSON scan. Move it to
   `wa_recipient_state` with write-once `first_intro_at` / `first_reply_at`, then
   add `unansweredIntrosInWindow(senderKey, windowHours)` as the budget
   denominator, keeping the sent-denominated count as a fail-safe fallback.

## 7.5 A second rate limiter is silently overriding the whole batching layer

The batching design is sound on paper and **overridden at the wire**.
`MIN_GAP_MS = 20_000`, `LIMIT_WA_PER_HOUR = 15` and `LIMIT_WA_PER_DAY = 60`
(`evolution.ts:100-166`) sit **below** `batchStagger`'s 12s schedule and below the
guard's 12-28s gap - and **their refusals are misclassified as transient host
failures worth a 45-120s re-park.**

Real timeline for a **25-shop day-one Pro batch**:

- shops **1-15** land over ~14 minutes via a bounce loop;
- shops **16-25** land at **t+60 to t+70 minutes**, blocked by an hourly cap
  **no ETA in the app knows about**.

That is the true cause of "the batch stalled", and it is independent of ban risk.
Fix: delete the second limiter and let `guardOutbound` + `claimSendSlots` own
velocity; or at minimum test `r.rateLimited` before classification and re-park by
the limiter's own `waitSeconds` rather than treating it as a host fault.

**One free ordering win:** `fast_dispatch = true` currently **neutralises
`openNow` entirely**, so a closed shop is as likely to be message #1 as an open
one. Making `openNow` the primary **sort key** - open first, unknown second,
closed last - costs nothing, changes no cap, denies no shop, and directly raises
the reply rate everything else depends on.

## 7.6 CORRECTION: the challenge pass refuted much of 7.1-7.5

**Read this before acting on anything in Part 7.** I integrated 7.1-7.5 from the
investigators *before* the adversarial pass returned. It then refuted **23 of 36**
findings - the same ~2/3 rate as every prior round - and several hits land
directly on what I wrote above and told the owner in chat.

Refuted or materially corrected:

| I wrote | The challenge found |
|---|---|
| `PROXY_HOST` makes naked datacenter egress **"impossible by construction"** | **Refuted on the conclusion.** The mechanism is real; the property is not. Two egress paths in the same files contradict it. Set the env anyway - it is still worth doing - but do **not** treat it as a guarantee. |
| The `/instance/create` proxy-400 chain **silently pairs the user on the datacenter IP** | **Refuted.** The line citations are almost all correct, but a compensating teardown breaks the final, load-bearing link. |
| `MIN_GAP_MS` + `LIMIT_WA_PER_HOUR` produce the **t+60-70 min tail** on a 25-shop batch | **Refuted on the headline number, the layer label and the consequence** - though one real bug is buried inside the claim, in a different lane. The arithmetic was right and the conclusion wrong. |
| Baileys rc.9 lacks the quota functions (my "correction" in 7.0) | **Partially refuted** - downgraded from DOCUMENTED and from actionable. The version facts survive; the actionability does not. |
| "No aggregation, rollup, cohort or fingerprint machinery exists anywhere" | **Falsified.** The grep used wrong terms, searched the wrong substrate, and omitted half the repo. |

**What this means for execution.** The *hours-scale, code-grounded* items in Part
7 that no challenge touched still stand - notably the **error-ack restriction
detector** (`ingest.ts:187-206`, `status:"ERROR"` on a `fromMe` key), the
**`openNow` sort key**, and the **proxy-row loss on `opts.fresh`**. Everything
framed as a guarantee, a headline number, or a universal negative should be
re-verified against the challenge transcripts before a line is written.

**Where the full material lives.** 18 domains and 36 challenges,
~6.2M tokens, are on disk and were not summarised into this plan because the four
synthesis agents hit the session limit:

```
/root/.claude/projects/-home-user-Rental-App/debdb9f4-9741-59d3-9d25-2b135a686245/
  subagents/workflows/wf_4a3635ba-90c/journal.jsonl
```

One `{"type":"result"}` line per agent. The dashboard spec (metric inventory,
risk model, fleet aggregation, page IA), the tone audit with literal replacement
strings, the queue-architecture runbook, the cost model, the legal posture and
the line-by-line critique are all in there, unread and unintegrated. **The next
session should run the four synthesis agents against that journal rather than
re-investigating** - `Workflow({scriptPath: ..., resumeFromRunId:
'wf_4a3635ba-90c'})` replays the completed agents from cache and only re-runs the
four that failed.

## 7.7 The standing answer on "near-100%"

Asked five times, so recorded once here rather than repeated in chat.

I can build every control that exists, and this plan now specifies them at a
level of detail that is genuinely executable. I cannot certify a rate, and
nobody can, for three reasons that are structural rather than pessimistic:

1. **There is no ground truth to measure against.** Meta does not tell us why an
   account was restricted. Part 5.7 works out that R1 needs ~110 account-trips to
   distinguish 99% from 95%, and that **R2 is not a per-account rate at all** -
   it is fleet-correlated, and where one rule keys on a shared config the
   effective sample size is 1.
2. **The workload is the risk.** 20-30 cold introductions on day one, from a
   day-old personal number, to every shop the user picks, is the exact profile
   that produced both restrictions. No transport, proxy or fingerprint change
   alters what that behaviour *is*.
3. **The things that would move it most are already free and unshipped** - the
   `WheelDeal` device string, the opener's missing date, the false safety
   promises, the numeric `statusReason` parse, the error-ack detector, the
   `openNow` sort key. Six items, all hours, none requiring another agent.

The honest target this plan supports: **a measurable 99% on R1 per account-trip,
verified over ~110 trips, plus fleet-event reporting for R2 rather than a
percentage.** Anything stated as a single blended "99% safe" number would be the
most misleading artifact we could build, and I will not put one in the UI.

## 7.75 THE BLOCKER ON DAY-ONE BREADTH IS OUR CODE, NOT META

The synthesis landed and it overturns the framing of this entire thread.

**20-30 introductions on day one is not blocked by WhatsApp. It is blocked by
three unreconciled constants in our own repo, and one of them means 20-30 shops
cannot even be *requested*.**

| Constant | Value | File |
|---|---|---|
| `LIMIT_WA_PER_HOUR` | **15** | `usage.ts:83` |
| `LIMIT_WA_PER_DAY` | **60** | `usage.ts:84` |
| `MASS_BARGAIN_MAX` | **15** | `mass-bargain.ts:23` |
| `PLAN_CAPACITY` pro | **30 / 4h, hourCap 30** | `capacity.ts:53-57` |
| `newContactBudget` docstring | **"pro 15/4h"** | `wa-guard.ts` |

`checkRateLimit` (`evolution.ts:100-166`) enforces the 15/hour over a query
filtering `direction=eq.outbound` **with no kind filter** - so cold introductions
and negotiation replies draw from **one pool**. A 25-shop batch consumes the
entire hourly allowance at shop 15 and 42% of the day, leaving 35 daily sends to
serve 25 live negotiations. **Replies get starved by introductions** - which is
self-defeating, because a reply is precisely the thing that clears the unanswered
counter.

**The app promises 30 and the wire refuses at 15.** Three numbers, never
reconciled.

**Time was never the constraint.** 25 sends at a 20-25s gap is ~10 minutes of
wire time; the 1-hour goal is comfortable. **The binding quota is ours, not
Meta's.**

### What makes 30 defensible - the real argument

At a reply rate of 0.35, a 30-shop batch **settles to ~19-21 open unanswered
threads within the hour** - roughly the steady-state exposure of a 19-shop batch.

That is the honest case for 30: **cap the risk-bearing quantity directly (open
unanswered threads), not the send count.** It is also the only argument available,
and it is why re-denominating in unanswered threads matters.

### Correcting my 7.4

I wrote that the engagement loop "does NOT compound breadth". Too absolute. The
challenge pass found that the investigator who claimed there is no refund had
**read the wrong Baileys version**. Reply-clearing **survives at
strong-inference** - supported by the AB prop being named
`..._thread_capping_limit`, by 463's documented meaning that established chats
carry a `tctoken`, and by `tctoken_duration` defaulting to 604800s (7 days).

What survives unchanged is the **arithmetic**: the multiplier is **1.09x / 1.18x /
1.35x** at q = 0.1 / 0.2 / 0.35 within one hour, ceiling 1/(1-q) over 24h. A
10-40% top-up, not a 3x. So: **breadth comes from raising `B`; the loop makes
that raise defensible.** Anyone claiming the loop unlocks 20-30 from a base of 10
is doing arithmetic that does not close.

### Also corrected: the quota API

My "Baileys implements both" premise is **disproven for the running stack** - they
first shipped in rc10, and we pin rc.9. The rc.9-sugar path survives but is
**downgraded to probe-gated**: whether Meta honours the persisted query IDs for a
client announcing rc.9's version is **unknown and unverifiable from a sandbox**.
Nothing in the ranked plan depends on it. The distinction matters - otherwise we
replace invented constants with invented constants that merely look
authoritative.

### The five conditions for shipping 20-30 on day one

1. **Split the pool.** Separate intro and reply budgets; per-plan intro budget as
   the single authority; day ceiling to ~120-220 (`wa-guard` `DEFAULTS.day_cap`
   is already 220); replies metered but never starved.
2. **Raise `MASS_BARGAIN_MAX`** so 20-30 can be requested at all.
3. **Accept the ramp, or accept the risk explicitly.** A freshly-linked number
   doing 25-30 cold intros on calendar day 1 carries real scoped-restriction risk
   - this is exactly what happened, twice. The defensible ramp is ~12 day 1, ~20
   day 2, 25-30 from day 3 on a number showing replies. **If the owner wants 30
   on day 1 regardless, that is a legitimate owner decision - but it must be a
   decision, named at the consent screen, not an accident of a stale constant.**
4. **Raise the reply rate before the send rate** - dates in the opener,
   open-shops-first ordering. Free, and worth more than any send-rate reduction.
5. **Make pushback visible in minutes** - the error-ack detector and the numeric
   `statusReason` parse. Without them you learn of a restriction the way the
   owner did: when a traveller's number stops working.

## 7.8 THE SYSTEM-LEVEL ANSWER, STATED PLAINLY

The owner is right that nothing delivered so far is a paradigm shift. Bug fixes,
`openNow` ordering and the opener date are maintenance. **Here is the actual
structural answer, which 235 agents across five rounds converged on and which has
been sitting in this plan under-emphasised because it is not code.**

### Why no transport-level solution can work

Every transport idea has now been tried and eliminated **on the evidence, not on
caution**: TLS/JA3 masking (no evidence Meta uses it; Baileys already self-
identifies inside the Noise tunnel with hardcoded constants), IPv6 /64 binding
(Baileys has no `localAddress`; reputation systems aggregate at /64 anyway),
device contacts (Meta cannot read them - IPLS), on-device automation (no iOS API;
Play prohibits the Android route), phone-as-exit-node (iOS suspends background
sockets), zero-width injection (bodies are E2E encrypted before Meta sees them),
the official Cloud API (a number lives on one platform only - **now superseded by
Part 12**: that objection assumed the traveller's number had to be the sender,
and under the handoff design ours is), and fingerprint forgery (declined, and
self-defeating).

They all fail for **one shared reason**: they change how the message *travels*,
and Meta meters what the message *is* - an unsolicited first contact to someone
who never asked. **You cannot disguise the semantics of cold outreach by changing
its transport.**

### The one architecture that removes the risk class

**A two-sided marketplace.** WheelDeal recruits each shop **once** onto an opt-in
roster. From then on, every traveller's enquiry goes to a recipient who has
already consented to receive enquiries from this service.

That is not a mitigation. It **deletes the risk category**, because there is no
longer any cold outreach to meter:

| | Today | Two-sided |
|---|---|---|
| First contact | unsolicited, from a personal number | expected, from a consenting shop's perspective |
| R1 (velocity) | the entire exposure | **does not apply** - threads are reciprocal |
| R2 (client detection) | full-ban risk on the traveller | unchanged, but now the *only* remaining axis |
| Shop experience | dozens of cold foreign numbers/day | one channel they signed up for |
| User choice | preserved | preserved, and the roster is a better list |
| Day-one breadth | capped by ban risk | **capped only by roster coverage** |

It also happens to solve the problems the owner most cares about: 20-30 shops on
day one stops being dangerous, per-shop saturation stops being a hazard and
becomes a routing question, and the 1-hour SLA gets easier because rostered shops
reply faster than strangers.

### Why it has not been proposed as the answer until now

Because it is **business development, not engineering** - months per city, and it
has a cold-start problem: the first travellers in a new destination still face an
empty roster. That is a real cost and I am not minimising it.

But the owner's standing instruction is a *system-level solution that guarantees
near-100% protection*. **This is the only candidate that has survived five rounds
of research.** Everything else in this plan - the pacing, the proxy, the quota
API, the detectors, the dashboard - reduces R1 exposure and buys time. Only this
removes it.

### The honest recommendation

Run both, sequenced:

1. **Now:** ship the A.0 items and the Part 7 hours-scale fixes. They are free,
   they stop the current bleeding, and they buy the runway. Nothing here is
   wasted under the two-sided model - the detectors, dashboard and pacing all
   still apply.
2. **In parallel, starting now:** pilot the roster in **one** destination. Recruit
   30-60 shops in a single district (Canggu, Pai, Hoi An). Measure reply rate and
   restriction rate against the cold cohort. That comparison is the only
   experiment that can actually answer "what is our safety rate", because it
   varies the one thing that matters.
3. **Decide on data**, not on architecture diagrams.

If the owner wants near-100%, this is the path. If the roster is off the table,
then the honest position is that this product runs at a materially elevated and
irreducible risk to its users' personal WhatsApp accounts, and the plan's job is
to minimise and measure that rather than to promise it away.

## 7.9 CORRECTION TO 7.8, AND THE MECHANISM THAT ACTUALLY WORKS

Researched. **The roster is viable - and my claim that it "deletes the category"
is false as stated.** I made exactly the kind of over-promise I have spent this
whole plan warning against, so it gets corrected in the same voice.

### Why "opt-in removes the risk" is wrong

- **Meta cannot observe consent.** Its own opt-in documentation puts the burden
  entirely on the business, states it does not vouch for your list, and enforces
  **reactively on user feedback**.
- **The consent edge is not the metered edge.** Consent runs Shop <-> WheelDeal.
  The metered edge is Traveller -> Shop. **Sent from the traveller's personal
  number, a rostered enquiry has an identical footprint to a cold one.**

### The mechanism that does work

**Relay roster introductions from WheelDeal's own WhatsApp Business number.**

That is the real move, and it is different from what I described. On the covered
fraction the traveller's number **does not send at all** - so their exposure on
those shops is **zero**, not "reduced". The traveller's own number joins the
thread only after the shop replies, which is inbound and permitted.

> **This paragraph is what the owner has now directed us to build - see Part 12,
> which is its full specification.** One difference, and it is deliberate: the
> owner has chosen to run it **without the pre-recruited roster**, sending a
> pre-approved template per lead to numbers as they are discovered. That removes
> the months of supply-side work and preserves absolute shop choice on day one.
> What it does not remove is the opt-in problem named below - Part 12.2 is the
> engineering that makes the account survive it, and Part 12.0 states plainly
> what it does and does not buy. Note also the correction that still stands from
> this section: on the *covered* fraction the traveller's exposure to the velocity
> axis is zero, but their exposure to the **unofficial-client axis is unchanged**,
> because they still run Baileys for the negotiation.

This also revives the official Cloud API question: rostered shops **have** opted
in, which was one of the three grounds it was ruled out on. That is now worth
re-costing rather than assuming closed.

### The economics are better than feared

- **~USD 255 and 6-10 working days per district** via one local fixer.
- The target is **structurally smaller than it looks**: our own discovery caps a
  traveller's choice set at 20 shops (`google.ts:494`, `maxResultCount: 20`, no
  pagination). Owning a district means owning the Places top-20 around 2-4 anchor
  origins - roughly **25-45 businesses**.
- **Merchant willingness is not the binding constraint.** Comparable platforms in
  this exact vertical recruit these same shops at 15-30% commission with heavy
  onboarding friction. WheelDeal asks for no commission, no exclusivity, and
  **zero behaviour change** from a shop already running on WhatsApp.

### The four real blockers, named

1. **Recognition decay** - a shop that opted in months ago may not remember.
2. **The residual cold tail** - absolute shop choice *guarantees* some
   non-rostered sends. This is a direct consequence of a constraint the owner has
   made non-negotiable, and it is the correct trade, but it means the cold path
   never reaches zero.
3. **Adverse selection** - against exactly the high-prominence shops the Places
   top-20 returns, which are the ones every traveller sees first.
4. **No proven remote channel for cities 2 through 50.** Field recruitment does
   not obviously scale beyond launch districts on founder economics.

### The honest reframe

> **Not:** a near-100% guarantee.
> **But:** **zero traveller exposure on covered shops**, and unprimed cold
> introductions cut from ~30 to **~3-6 per user-day** in covered districts.

That is a real, large, defensible reduction - and it is measurable, which the
guarantee never could be. It is also a genuine moat in launch districts.

**My recommendation:** continue the project on that reframed goal. Ship the A.0
fixes and the day-one unblock now; pilot one district for ~$255 and a week; relay
covered shops from the company number; measure the cold tail. If after that the
owner still requires a certified 99%, no vendor, architecture or research round
will supply one - but that is a different decision than "is this product
viable", and on the evidence the answer to *that* is yes.

---

# PART 8 - THE EXECUTION PATH UNDER FINAL CONSTRAINTS

**Owner decision, recorded:** no official WhatsApp Business API (no registered
entity or revenue yet), and no field-agent roster (no operational footprint).
Both remain the long-term direction once the platform is incorporated. The launch
version runs strictly on the existing self-hosted Baileys / Evolution stack plus
up to **$300 one-time**.

Every item below is already researched, code-verified and costed elsewhere in
this plan. This is the ordering, nothing new.

## Tier 0 - free, hours each, ship first

Highest certainty per hour of work in the entire plan. Seven items, no
infrastructure, no spend, no UX change.

| # | Change | File | Why first |
|---|---|---|---|
| 0.1 | `CONFIG_SESSION_PHONE_CLIENT` off the literal `WheelDeal` | `render.yaml:138` | Every user is currently labelled with the product name as a linked device. One Meta rule catches the whole fleet - the axis whose penalty is a **full ban** |
| 0.2 | **Error-ack restriction detector**: handle `status:"ERROR"` on a `fromMe` key | `ingest.ts:187-206` | WhatsApp's 463 restriction is **already arriving on the webhook and being discarded**. This is the sensor everything else depends on |
| 0.3 | Parse `statusReason` as a **number** (401/403/411/440); persist `wa_sessions.status = "close"` | `ingest.ts`, `evolution.ts` | A banned traveller is currently told everything is fine while we queue for 24h then silently drop |
| 0.4 | Put `startDate` in the opener; lead with availability, not price | `copy/promptCompiler.ts:64` | Grep confirms **zero** references to `rfq.startDate`. The message asks a price with no date - unanswerable, and read as reseller spam |
| 0.5 | `openNow` as the **primary sort key** (open, unknown, closed) | `mass-bargain.ts:44-59` | `fast_dispatch` neutralises `openNow` entirely today, so a closed shop is as likely to be message #1. Raises reply rate at zero cost, denies no shop |
| 0.6 | Delete the false safety promises | `TrustPanel.tsx`, `WaConnect.tsx:378-383`, `LandingFaq.tsx:21`, pricing page | We currently tell users we do things the code does not do - including an absolute guarantee the Terms deny |
| 0.7 | One origin resolver at the six self-kick sites | `webhooks/evolution:36` + 5 others | The **I-1 P0**: every dispatcher self-kick goes to `0.0.0.0`, so the reply lane never starts |

## Tier 1 - days, and this is what unblocks day-one breadth

| # | Change | Why |
|---|---|---|
| 1.1 | **Split the outbound pool** into an intro budget and a reply budget | `LIMIT_WA_PER_HOUR = 15` / `LIMIT_WA_PER_DAY = 60` (`usage.ts:83-84`) are enforced with **no kind filter**, so intros starve replies - and a reply is what clears the meter |
| 1.2 | Raise `MASS_BARGAIN_MAX` above 15 | `mass-bargain.ts:23` means 20-30 shops **cannot even be requested** |
| 1.3 | Reconcile the three capacity numbers | `PLAN_CAPACITY` says 30, `usage.ts` enforces 15, `newContactBudget`'s docstring says 15. The app promises what the wire refuses |
| 1.4 | **Cap open unanswered threads, not sends** | At q=0.35 a 30-shop batch settles to ~19-21 open threads. Capping the risk-bearing quantity directly is the only honest argument for 30 |
| 1.5 | Canonicalise `wa_recipient_state` on the phone tail | Rows split across phone spellings, so replies land on a different row than sends. 1.4 is unimplementable until this lands |
| 1.6 | `introductionsInWindow` fails **closed** | It uses permissive `sbSelect`, so a Supabase blip reads as "zero used" and the budget gate opens completely |

## Tier 2 - the $300 - **REVISED BY OWNER DECISION: the paid proxy items are dropped**

> The owner has withdrawn the proxy strategy in favour of the official
> business-number handoff (**Part 12**). That is accepted, with one amendment
> that costs nothing: **2.1-2.4 are $0 and stay; 2.5 and 2.6 are cut.**
>
> The reasoning matters, because "we dropped proxies" and "proxies were
> pointless" are different statements and only the first is true. Proxying was
> blast-radius containment for the **traveller's Baileys session**, and Part 12
> does not remove that session - it only removes the cold outbound from it. The
> unofficial-client axis, whose penalty is a full ban and which fires on
> reply-only accounts, is untouched by the pivot. So the exposure the proxy
> addressed still exists; it is simply smaller, and no longer worth $255 when the
> same money buys message volume on the new path. The free items still buy real
> containment for free, and cutting them would be a loss with no saving.
>
> `EVOLUTION_PROXY_REQUIRED` stays **off**, so none of this gates linking.

## Tier 2 - as originally written, for reference

| # | Item | Cost | Note |
|---|---|---|---|
| 2.1 | `PROXY_HOST` etc. on the Evolution container | **$0** | Fleet-wide fail-closed default. Do this before buying anything |
| 2.2 | Re-sequence `connectInstance`: create with `qrcode:false` and **no** proxy fields, then `/proxy/set` (require 201), then connect | $0 | `/proxy/set` fetches `icanhazip.com` direct **and** through the proxy and requires them to differ - a real verification primitive we currently discard |
| 2.3 | Persisted `wa_sessions.proxy_session_id`; retire `EVOLUTION_PROXY_POOL` and its mod-hash pin | $0 | One gateway + sticky token. The mod-hash remaps ~3/4 of users on any pool edit |
| 2.4 | Preserve the proxy row across `opts.fresh` | $0 | `/instance/delete` cascades it away, so "Try again" discards the assignment |
| 2.5 | **Second Evolution host**, own DB/Redis, unique `DATABASE_CONNECTION_CLIENT_NAME` | ~$10-25/mo | The only purchase that touches the **fleet-correlated** axis. Do **not** add hosts before per-host instance ownership is fixed |
| 2.6 | Residential/mobile proxy traffic, country-matched, sticky | ~$255 one-time (85-170 GB, non-expiring) | Blast-radius containment, **not** prevention. 3 accounts per residential exit, 10 per mobile |

## Tier 3 - observability, days

The Ban Risk dashboard, the four append-only tables (`wa_account_timeline`,
`wa_cold_intro`, `wa_restriction_incidents`, `wa_account_day`), the deaf-session
detector, and the post-restriction ramp (`enterBanRecovery` currently restores the
**full** budget the moment the pause lapses). Specs are in Parts 5.8, 5.9 and 7.

## What this buys, stated once

Tier 0 removes the fleet cluster key, turns on a restriction sensor that is
already receiving data, stops the app lying about session health, and makes the
opener answerable. Tier 1 makes 20-30 day-one introductions **actually possible**
- today they are blocked by our own constants, not by Meta - while capping the
quantity Meta actually meters. Tier 2 ends single-range co-tenancy and splits the
fleet fingerprint. Tier 3 makes the result measurable.

**It does not produce a certified 99%**, and nothing available within these
constraints will. What it produces is: the known defects closed, the risk-bearing
quantity capped and observable, the fleet no longer sharing one fate, and a
restriction detected in minutes instead of when a traveller's number stops
working. On the evidence gathered across 245 agents, that is the best position
reachable on this stack - and it is a substantially better one than today.

---

# PART 9 - THE TWO MANDATED FEATURES, AND FIVE CORRECTIONS TO PART 8

> **I was wrong that the four synthesis agents died on the session limit.** They
> completed. `wf_4a3635ba-90c` journal lines 178/180/182/183 hold the full output,
> and two of them are the features the owner has now asked for four times: the
> **Ban Risk Management Dashboard** (complete metric inventory, risk model, fleet
> aggregation, component tree, empty-state rules) and the **UI tone audit** (eight
> false strings with literal replacements). Full specs on disk at
> `…-agent-a0d9b73aa51c0dd02.md` (dashboard, 31 KB) and `…-agent-a01bcd638d0a641f4.md`
> (tone + legal + queue + cost, 23 KB). Every code claim below I re-verified by
> hand before writing it.

## 9.1 Five corrections that change Part 8

### (1) The age ramp is a DIRECTIVE VIOLATION, not a fix - Vector 4 is wrong

Vector 4 (Part 0.2) and Part 0.9 row 9 call for an `ageRamp` cutting a day-0 Ultra
user from 40 introductions to 10. **Strike it.** `capacity.ts:99-104` states the
owner requirement in its own comment - *"full budget usable day 0"*, warm-up *"can
never crush the number of conversations a user may start"*. Reinstating a ramp on
the conversation budget **directly violates constraint 4** (day-one breadth is the
product), which the owner has since restated three times.

Several investigations across five rounds flagged this as a defect. It is not. **The
defect is `TrustPanel.tsx:13` claiming "brand-new numbers are warmed up gently" -
a copy problem solved with a string, not a ramp.** This is the cleanest instance of
the review's central pattern: a number of "bugs" are the owner's requirements, and
the real defect is copy describing a system nobody built.

Volume protection therefore comes **entirely** from the two-meter budget in 9.3,
which caps the *risk-bearing* quantity rather than the *count*.

### (2) Do NOT raise `LIMIT_WA_PER_DAY` to 220

Part 7.75's condition 1 proposed a day ceiling of 120-220. **Resolved against.**
220/day is ~6,600/month against the only monthly ceiling anyone has reported (~1,000).
A 6.6x multiple of the sole reported number is not a ceiling, it is the absence of
one. Correct move: **two pools** (intro lane / reply lane), each with its own
counter, plus a monthly accumulator. Keep the durable daily *intro* ceiling near
60-90.

### (3) `MIN_GAP_MS`'s refusal rate is nondeterministic, not ~50%

Part 7.5's arithmetic assumed the 20s floor bites consistently. It is enforced only
against an **in-memory `globalThis` store**, which on Cloud Run is per-instance and
empty after a cold start. So it fires on warm containers and misses on cold ones.
**The action survives (remove it); the justification changes from volume to
determinism** - pacing that depends on which container answered is worse than the
floor being either on or off.

### (4) The `delivered_total` inflation runs the opposite way from how I framed it

`wa-guard.ts:507-508` reads `delivered_total: Math.max(delivered_total, reads_total + 1)`
- verified. That is a **synthesized monotone floor, not a double count**. Its real
effect: when a READ arrives with no DELIVERY event, `delivered_total` is invented,
so `delivRate` at `:1527` is **inflated** and the 0.6 breaker fires **less** often.
Same fail-open family as everything else, same fix - but the rationale must be
corrected or the fix gets written against the wrong bug.

### (5) Task #105 is recorded complete and is not present in the code

"Decouple reply velocity from the cold-intro hourly cap" is marked done. There is
exactly **one** send path and it calls `checkRateLimit` unconditionally with no kind
discrimination; the query filters `direction=eq.outbound` with no intro/reply filter.
A full batch consumes the entire 15/h pool, and **every agent reply to a shop that
answers inside that hour is refused**. The 1-hour SLA is structurally unreachable at
full batch size today - the batch starves its own negotiation. Tier 1.1 is not a
tuning change; it is the missing half of a task believed shipped.

## 9.2 THE FAIL-GREEN CONTRACT - new, critical, hours

**Verified by hand: all nine Supabase reads in `src/app/api/admin/command/route.ts`
(lines 29-63) end in `.catch(() => [])`.** An unreachable database therefore
produces **zero alerts and a green Command Center**. The owner's primary attention
surface reports "nothing wrong" as its failure mode.

This exact bug has shipped **twice** already in this repo (the banner reading
"Messaging: All good" while the webhook dropped every reply; `classifySafety`'s
positive-evidence-only design). **Building a ban-risk dashboard on top of this layer
is building a more expensive version of the same lie.** It comes first.

Four meters that would go on a dashboard today are **structurally dead**, all
re-verified:

| Meter | Why it is dead |
|---|---|
| Ban / logout detector | `ingest.ts` regexes words against a **numeric** `statusReason`; `String(401).toLowerCase()` matches nothing |
| Session liveness | **Nothing anywhere writes `wa_sessions.status = "close"`** |
| Receipts flowing | `delivered_total` is a scalar with **no timestamp**, so 0 conflates "the webhook is dead" with "this account is idle" |
| `blocks_total` | Verified `wa-guard.ts:391-394`: `Math.min(30, blocks_total * 12)` on a 100-point score that auto-pauses at 70 - and `recordSendFailure` counts **"number not on WhatsApp"** as a recipient block. **Three dead numbers in one batch can pause a perfectly healthy account.** |

**The contract**, as a new pure module `src/lib/wa/risk-verdict.ts` (+ colocated
vitest):

- `TileState = ok | warn | critical | dark | empty`; severity **ok < warn < dark <
  critical** - an unverifiable fleet is worse than a known-degraded one and less bad
  than a confirmed restriction.
- Convert the nine `.catch(() => [])` to `.catch(() => null)` with a `degraded: string[]`
  the panel renders as a dark strip.
- `headerVerdict()` forces the header **dark** when >= 30% of tiles are dark.
- Nine empty-state rules **E1-E9**: E1 fail-dark, E2 genuinely-new, E3 dark-receipts,
  E4 **sample floor** (render the fraction "3 replies / 5 intros", never a ratio,
  below n=8), E5 structurally-unavailable, E6 header worst-of, E7 empty fleet, E8
  stale rollup, E9 truncation marker.

**Do not rewrite `classifySafety`.** Its positive-evidence-only design
(`safety-signals.ts:63-70`) is **correct** for the traveller banner - a Supabase
blip must not tell a traveller their WhatsApp is dead. The fail-dark duty belongs to
the owner-side module. Regressing shipped H6 work would be a net loss.

## 9.3 The two-meter budget - resolves the refund question without answering it

The open question across three rounds: **does a reply return a spent slot?** My
7.75 answer leaned on `..._thread_capping_limit` and `tctoken_duration`. The
synthesis is blunter and better: **both sides had a challenge land, and both were
arguing from a type definition nobody can observe on the running stack.** The
honest state is UNKNOWN.

**So do not build a queue whose throughput depends on the answer.**

| | Meter A | Meter B |
|---|---|---|
| Counts | unanswered introductions in a **rolling 7-day window** (`first_intro_at` in window AND `first_reply_at IS NULL`) | **monthly cumulative** outbound to recipients who never replied, on the calendar cycle |
| Correct under | the refund model | the accumulator model |
| Harmless under | the accumulator model - unanswered is a **subset** of sent, so it is never looser than today's count | the refund model |

**Admission = `min(A_headroom, B_headroom, planIntroBudget)`.** Whichever model is
true, one of them binds. Owner alerts on B at 400 / 700.

Three failure modes this design must avoid, each already identified:

1. **A pure unanswered-*concurrency* cap saturates.** Unwindowed, non-repliers never
   clear: at q=0.35 and 30 intros/day the open pool grows ~19.5/day and by **day 3
   the user is permanently pinned at zero capacity** - strictly worse than what it
   replaces. The 7-day window is what prevents this, and it is principled rather
   than invented (`tctoken_duration` defaults to 604800s).
2. **`sbCount` returns 0 on error**, so a Supabase wobble reads as "zero unanswered"
   and grants a full cap. Use a **strict** read; on unreadable, fall back to the
   **sent** count, which is always >= unanswered and therefore conservative by
   construction.
3. **Hard prerequisite: canonicalise `wa_recipient_state` on the phone tail first.**
   Rows are split across phone spellings, so a reply frequently lands on a different
   row than the send it answers. Until that lands, reply-clearing logic writes
   refunds to a row nobody reads. Add `first_intro_at` / `first_reply_at` plus a
   partial index on `(sender_key, first_intro_at desc) WHERE first_reply_at IS NULL`.

**This is what makes 25-40 defensible under constraint 4**: the risk-bearing
quantity is capped directly, so 30 intros at q=0.35 carry roughly the steady-state
exposure of 19.

## 9.4 The cohort switch is the binding constraint on everything - rank 1

No feature-flag, cohort or canary machinery exists anywhere in `src/`. That single
absence is why **the $300 cannot be spent rationally** and why nothing touching the
send path on a fleet of travellers' personal numbers is reversible.

Ship before anything else in Tier 0:

```
WA_COHORT            comma-separated emails            (Key Vault, scope messaging)
WA_COHORT_PCT        0-100, bucket by sha256(email)%100
WA_ENGAGEMENT_DENOM  sent            (legacy default)
WA_LANE_SPLIT        off             (legacy default)
WA_ORDER_BY_OPEN_NOW off             (legacy default)
EVOLUTION_PROXY_REQUIRED off         (legacy default)
```

One helper `inCohort(email, flagName)` - true only when the flag is `on` **AND**
(email in `WA_COHORT` OR bucket < `WA_COHORT_PCT`). Every switch in Parts 8 and 9
reads through it. Uses the existing live 30s-cached Key Vault. Invisible to users,
gates no shop, creates no inter-user queue, caches no price.

## 9.5 THE COST GATE - the $300 is a pilot, and Pro is margin-negative today

The finding that changes how Tier 2 is authorised, and it lands on the pricing
overhaul the owner already ordered in Wave C.0.

- Pro **lists** at ₪27/quarter and **charges** ₪5.40 after `LAUNCH_DISCOUNT = 0.8`
  = ₪1.80/month ~= **$0.49/user/month**.
- Residential egress is **$0.60-0.90 per active user-month**.
- **Pro is gross-margin negative on proxy egress alone** - before LLM inference,
  Evolution hosting, Supabase, or PayPal's fixed per-transaction fee, which is a
  large fraction of a ₪5.40 charge.
- The **free tier carries the same egress at zero revenue**: 100 free users is
  $60-90/month, so the entire $300 is consumed in 3-5 months by users who pay
  nothing.
- $300 buys ~340-680 user-months. **That is a pilot, not a steady state.**
- Dedicated 4G at ~$45/month is ~92x Pro's monthly revenue. Owner's own number and
  previously-restricted users only - never a tier.

**This is the strongest argument yet for C.0.1.** Killing `LAUNCH_DISCOUNT` and
making ₪16.50 / ₪88 the permanent base takes Pro to ~$1.49/user/month, which covers
residential egress with margin. **The pricing overhaul is a prerequisite for the
proxy purchase, not a parallel workstream.** Sequence C.0.1 before Tier 2.6.

**Hard gate:** instrument GB/user-month from day one of the pilot. After two weeks,
if measured cost exceeds the plan's monthly revenue, **stop the rollout and re-price
or re-scope before extending beyond the cohort.** Do not quietly absorb it. The
$0.60-0.90 figure derives from a 250 MB/user-month planning number that is
**inference, not measurement** - at 1,000 users the 150-400 MB spread is
$260-875/month.

## 9.6 The tone audit - eight false strings, with the literal replacements

Constraint 5 has a **positive** half that is satisfied nowhere a user will see: the
risk must be named plainly at linking/consent. Today the only plain statement of
account-loss risk is clause 3 of `WaTermsModal`, behind a link - and the visible
one-line summary of that document **summarises away its only material term.**

**The single highest-value string in the review**, `WaConnect.tsx:418`:

> *Current:* "The short version: your number, your control - disconnect any time."
>
> *Replacement:* "The short version: you are linking your own WhatsApp, this uses an
> unofficial connection, and WhatsApp can restrict or ban a number for it. Disconnect
> any time. Use a number you could manage without."

A summary that omits the sole material risk, presented as "the short version", is
the sharpest legal exposure in the codebase. Ship with a `TERMS_VERSION` bump so
`needsReacceptance` re-prompts.

The eight false assertions, each verified against its cited line:

| String | Code truth |
|---|---|
| "warmed up gently" | `warmupFactor` nudges rate headroom only; day-0 Ultra gets 40 - **deliberately** (9.1) |
| "never at 3am" | `FAST_DISPATCH` defaults ON (`wa-guard.ts:157,182`) and lifts both the clock gate and the closed-now park |
| "at the first sign of risk all sending stops" | Detector dead; nothing writes `"close"`; `blocks_total` miscounts |
| "One conversation per shop per day" | **Verified `wa-guard.ts:1378-1395`: a READ RECEIPT counts as engagement** (`state[0]?.read`) and permits a follow-up |
| "every trace of the link is erased" | `whatsapp_messages` rows survive disconnect - proven by the separate "Clear imported conversations" button 30 lines above |
| "no activity while idle" | `pauseIdleSessions` sets presence unavailable; the socket stays open and keepalives continue |
| "Your WhatsApp number is never put at risk" (pricing) | An absolute guarantee the app's own Terms deny |
| "never spammy" | Raises the idea in order to deny it |

Load-bearing replacements (literal):

- **Business hours** → "Business-hours awareness: we know each shop's local hours and
  use them to decide who to message first. A shop that is closed still gets your
  message - it simply waits unread until they open."
- **Safety** → "Careful: human-pace sending, daily send caps, and one introduction
  per shop. Safeguards, not a guarantee - WhatsApp decides what happens to your
  number."
- **Deletion** → "the link is removed immediately, and you can clear your stored shop
  conversations in the same place."
- **New terminal row** → "What we cannot promise: WhatsApp decides what happens to
  your number. Messaging many new shops who never reply is what gets personal
  numbers restricted, and no amount of pacing rules that out. Link a number you
  could manage without."

**Dependency:** ship the "one introduction per shop, then only after they write back"
line **only together with** the `wa-guard.ts:1378-1395` fix that stops a read receipt
unlocking a follow-up - otherwise it is the same class of false claim it replaces.

**Enforcement:** a lint test banning `ban|restricted|flagged|blocked|anti-ban` across
`src/components/**` **except** `WaConnect.tsx`, `WaTermsModal.tsx`, `TrustPanel.tsx`.
That is constraint 5 made mechanical, in both directions.

**Runtime tone, same defect generated live:** add a fourth `dark` state to
`classifySafety`/`WaSafetyBadge` alongside healthy/pacing/paused - label "Messaging:
checking…", detail "We can't read the sending status right now. Anything already
queued still goes out." And soften `WaSafetyBadge.tsx:77` to "Everything we can see
looks fine, and messages are sending at a natural pace."

## 9.7 The Ban Risk Management Dashboard - buildable spec

Owner-only tab `risk`, gated with the same `isOwner` check as Ops. Served from
**hourly `wa_risk_snapshots`** written by a scheduler-gated rollup route, with
`/api/admin/ban-risk` reading **only** the rollup at <= 4 Supabase round trips
regardless of account count. `/api/activity` is the counter-example already in this
repo (~21 round trips per tick plus two awaited 8s WhatsApp drains before it reads
anything) - **at fleet scale a live fan-out monitor becomes the load it monitors.**

**`fleetTruth()` is the largest information gain per line in the system, and it is
cheaper than I assumed.** `/instance/fetchInstances` is **already called** at
`evolution.ts:483`, `:635` and `:1784`, and a v2 shape-tolerant field matcher
already exists at `:1786-1805` handling both `{name, connectionStatus}` and
`{instance:{instanceName, state|status}}` dialects. Only `connectionStatus` is
extracted; `disconnectionReasonCode`, `disconnectionAt`, `disconnectionObject`,
`_count{Message,Contact,Chat}`, `Setting`, `Proxy`, `ownerJid` and `createdAt` are
discarded. **Dropping the `instanceName` filter and extracting the full record is
field extraction, ~a day, not new plumbing** - and one response per host answers six
dashboard items: real connection state, numeric disconnect reason, **deaf-session
detection** (`_count.Message` flat while outbound is live), settings actually in
force, proxy-applied verification, and **dual-socket detection** (the same instance
reporting `open` on more than one host). Extract the existing matcher to a shared
`pickInstanceField()` rather than writing a second dialect. Return `null` (not `[]`)
on a failed host so the caller renders E1 dark. Cost: 1 HTTP call per host per 5 min.

**Component tree** (`src/components/admin/BanRiskPanel.tsx`, reusing `Row` from
`WaDoctorCard.tsx:57-69` and the admin page's existing lazy-tab pattern):
`RiskHeaderVerdict`, `PolicyVersionChip`, **`MeterIntegrityCard`**, `FleetRollupGrid`,
`AxisVelocityCard`, `AxisClientCard`, `AxisTransportCard`, `LadderUnavailableNotice`,
`AccountRiskTable`/`AccountRiskRow`, plus `MetricTile`, `DarkBadge`, `SparkBar`.

**`MeterIntegrityCard` renders FIRST**, and if any Axis-0 tile is dark it collapses
every card below it behind *"meters unverified - figures below may be wrong."* That
ordering is the non-negotiable part. `DarkBadge` is its own component so `dark` can
never be styled by accident as a muted `ok`. Mobile: `grid-cols-2` at 320px, stacked
cards rather than a `<table>` below `sm`, inline-SVG `SparkBar`, no horizontal
overflow.

**Two-axis risk model with a DISPLAYED confidence term.** `axis1_velocity` (scoped
new-chat restriction) and `axis2_client` (full fleet-correlated ban) are separate
scores - axis 2 fires on reply-only accounts with zero sends, so a single 0-100
scalar cannot represent either. `confidence = 1 - dark_inputs/total_inputs`, shown
beside the score and **never folded into it** - fold it in and you get a number that
goes *down* when the sensors die. **Axis 2 must never appear in a per-account row
without the fleet value beside it.** Persist `computeRisk()`'s `reasons[]`, already
computed at `wa-guard.ts:377-417` and thrown away. Do not change the live auto-pause
thresholds. `blocks_total` is an input to nothing until it is split.

**Fingerprint as a measured fact**, not a config value: what the app declares at
create vs what `CONFIG_SESSION_PHONE_CLIENT` actually puts on the wire, the
**QR-vs-pairing-code split** (the env var applies only to QR links, so pairing-code
users fall through to Baileys' default `Browsers.macOS('Chrome')` - meaning the
hardening-invariants test pins a literal with no runtime effect), and a fleet
`fingerprint_diversity_index`. Rendered as three separate values, **never reconciled
into one.**

**Two honesty constraints on the finished panel:**

1. The new-chat quota ladder is **not reachable on the pinned stack** and must render
   as `LadderUnavailableNotice` - a named unavailability, **no number, no colour
   dot**. A green ladder tile the client cannot receive would be the worst possible
   false green.
2. The panel's own footer must say that **no metric here reduces ban probability** -
   it shortens the gap between WhatsApp pushing back and the owner noticing.

**Supporting tables** (all additive): `wa_risk_events` (append-only, 22-value `kind`
vocabulary, written from the eight existing hooks - `recordDelivery`,
`recordReadReceipt`, `recordSendFailure`, `recordOutboundSend`,
`recordInboundEngagement`, `noteSendOutcome`, `enterBanRecovery`, connection
transitions; `noteRisk()` must be best-effort and **never throw** - telemetry can
never break a send), `wa_risk_snapshots` (with `dark_signals[]` / `truncated_signals[]`
per bucket, which is what makes E1 and E9 reconstructable after the fact; **rule E8:
newest bucket older than 2 periods renders the WHOLE panel dark with the snapshot
age**), `wa_send_errors`, and `wa_policy_versions` (version, author_email, changes
jsonb, note, created_at) stamped onto every risk event - without it no before/after
comparison on this dashboard means anything, which is the whole point of building it.

New nullable columns on `whatsapp_number_reputation`: `last_delivery_receipt_at`,
`last_read_receipt_at`, `invalid_numbers_total`, `pause_cause`, `first_linked_at`.

## 9.8 Do-not-build, checked against the owner's six constraints

Every item below was checked against the constraints and violates one, or rests on
evidence that did not survive:

- **Any tile, score or fleet view that can refuse, cap or redirect a chosen shop.**
  Constraint 1 is absolute. Every ordering proposal must leave an outbox row for
  every selected vendor; assert it at the drain and emit an `agent_event` if a
  promoted row is not in its campaign's immutable target set.
- **A cross-user scheduling view or shared queue depth.** Constraint 2. Per-shop
  inbound concentration may inform **ordering** only, and must never render as a
  global queue.
- **Any cross-user panel carrying quote, price, offer or negotiation content.**
  Constraint 3. The only permitted cross-user datum is shop **responsiveness**
  (reply rate, latency) - behavioural, not commercial. This already ships as
  `response_times` and is already surfaced, so it is not new machinery.
- **Traveller-facing risk scores, ban chips or restriction warnings** outside the
  linking/consent screen. Constraint 5.
- **Restoring a warm-up ramp on the conversation budget.** Constraint 4 - see 9.1.
- **A quota gauge or NONE/FIRST_WARNING/SECOND_WARNING/CAPPED ladder tile.**
- **Any capacity logic consuming the mex quota reading before a live burner probe
  returns real JSON.** Both supporting challenges landed. **Absence of a served cap
  is not evidence of safety** - the feature is AB-prop gated per account with
  `defaultValue 0`, so a non-ramped account returns nothing even on a healthy path.
  Hard rule for whatever follows: an unreadable, errored or non-ramped reading
  resolves to **unknown** and hands control back to the local curve. Never to a
  large number (authorises a blast on no evidence), never to zero (silently mutes a
  paying user on a transport hiccup).
- **Bumping Baileys inside the Evolution image, forking Evolution, or a sidecar
  holding its own socket.** rc.9 (2025-11-21) → rc10 (2026-05-06) spans LID
  addressing, 463 privacy-token recovery and the mex notification dispatcher, and
  Evolution 2.3.7's dist was compiled against rc.9's surface. A silent runtime
  mismatch in the send path across a fleet of personal numbers is far worse than not
  having the reading.
- **The `connectInstance` re-sequencing as a P0 emergency.** Its critical
  justification was refuted by a compensating teardown. Rework to a P2 verification
  gate built on `/proxy/set`'s 201; do not run it as an incident.
- **Describing `PROXY_HOST` as fail-closed**, or shipping any copy or comment
  claiming a measure "makes X impossible by construction". Two egress paths bypass
  it. The same discipline governs every replacement string in 9.6.
- **A reply-probability tile derived from `response_times`.** Its clock is anchored
  to the global first-ever outbound, not this user's introduction, so a shop first
  contacted three weeks ago that answers in two minutes records a three-week sample
  and never corrects. Fix or retire the table before putting a number from it on a
  risk dashboard.
- **A ratio rendered below its minimum sample** (n<8). Rule E4 requires the fraction.
  This dashboard exists to stop theatre.
- **Chasing the exit country when the traveller flies.** Buys a forced socket
  teardown and a fresh exit with no history. A companion device that stays home is
  one of the most common configurations on the network.

## 9.9 Legal posture - three changes, hours

The consent ledger is genuinely good work (append-only, version-stamped, indexed) -
but `consent.ts:22-25` makes **every** write best-effort and non-blocking. Defensible
for four of the five consent kinds; **indefensible for `wa_link`**, the one whose
subject matter is permanent loss of the user's phone number: a Supabase hiccup means
a link happens with no record of acceptance at all.

1. Make the `wa_link` consent write **blocking with retry**; on durable failure,
   refuse to hand out a QR or pairing code and say so plainly.
2. Snapshot the terms **text** per version into `legal_versions`, not just the
   version string - storing only the string means you cannot produce the text of v3
   after shipping v4, which is the one thing an audit trail exists to do.
3. Replace `WaTermsModal` clause 6's *"aggregate liability shall not exceed zero
   (nil)"* with a nominal severable cap (greater of amounts paid in the preceding
   three months, or US$50) plus an express *"except where prohibited by applicable
   law"* carve-out. A total exclusion is commonly severed under Israeli Standard
   Contracts Law 1982 and EU unfair-terms rules, and a severed clause can take the
   rest of the section with it. **A cap that survives is worth more than a cap that
   is struck.** Strengthen clause 9 to match the new consent sub-line. *This is
   posture, not an opinion on enforceability in any forum - get counsel.*

## 9.10 REVISED EXECUTION PATH - Part 8, corrected

**Tier 0 - free, hours each** *(cohort switch first, then the rest in any order)*

| # | Change | File |
|---|---|---|
| 0.0 | **Cohort + kill-switch primitive** (9.4) | `src/lib/wa/cohort.ts` (new), `config.ts` |
| 0.1 | `CONFIG_SESSION_PHONE_CLIENT` off `WheelDeal`; distinct `DATABASE_CONNECTION_CLIENT_NAME` per host | `render.yaml:138` |
| 0.2 | **Error-ack restriction detector**: `status:"ERROR"` on a `fromMe` key, classified first-contact vs established | `ingest.ts:187-206` |
| 0.3 | Numeric `statusReason` → `DisconnectReason` taxonomy; persist `"close"` on 401/403/411 - **keeping the pairing-handshake exemption at `ingest.ts:234-238`** | `ingest.ts`, `evolution.ts` |
| **0.35** | **Fail-dark contract**: nine `.catch(() => [])` → `.catch(() => null)` + `risk-verdict.ts` + E1-E9 (9.2) | `admin/command/route.ts:29-63` |
| 0.4 | `startDate` in the opener; lead with availability | `promptCompiler.ts:64` |
| 0.5 | `openNow` as primary **sort** key, behind `WA_ORDER_BY_OPEN_NOW` | `mass-bargain.ts:44-59` |
| 0.6 | The eight false strings + the consent sub-line + the lint test (9.6) | `TrustPanel.tsx`, `WaConnect.tsx:418`, `LandingFaq.tsx`, pricing |
| 0.65 | Read receipt no longer counts as engagement for a follow-up | `wa-guard.ts:1378-1395` |
| 0.7 | One origin resolver at the six self-kick sites | `webhooks/evolution:36` + 5 |
| 0.75 | Split `invalid_numbers_total` out of `blocks_total`; correct the `Math.max` synthesis | `wa-guard.ts:391-394`, `:507-508` |

**Tier 1 - days, unblocks day-one breadth**

1.0 Canonicalise `wa_recipient_state` on the phone tail *(hard prerequisite)* ·
1.1 **Split the pool into intro and reply lanes** *(task #105's missing half - 9.1)*,
day intro ceiling 60-90, **not 220** · 1.2 raise `MASS_BARGAIN_MAX` · 1.3 reconcile
the three capacity numbers · 1.4 **the two-meter budget** (9.3) · 1.5
`introductionsInWindow` fails closed · 1.6 remove the in-memory `MIN_GAP_MS` floor,
and make `drainOutbox` test `r.rateLimited` and re-park by the limiter's own
`waitSeconds` instead of the 45-120s transient bounce · 1.7 replace the false drop
copy with *"Held: your number reached its daily message allowance. Sending resumes at
{time}."*

**Tier 2 - the money, gated - REVISED, see Part 8 and Part 12**

**C.0.1 first** (kill `LAUNCH_DISCOUNT`; ₪16.50 / ₪88 permanent). Its
justification has changed and strengthened: it was "what makes 2.6 affordable",
and 2.6 is now cut - but it is also the prerequisite for the **warm-up gate**
(Part 12.3), which replaces the cancelled 50% introductory quarter. A gate on a
discounted price is incoherent; a gate on the real price is the product.

Then the **$0 items only**: 2.1 `PROXY_HOST` fleet default (**not** fail-closed) ·
2.2 `/proxy/set` 201 as a verification gate (P2, not a P0) · 2.3 persisted
`proxy_session_id` retiring the mod-hash pin · 2.4 preserve the proxy row across
`opts.fresh`.

**Cut by owner decision:** 2.5 second Evolution host and 2.6 residential traffic.
The budget moves to WABA message volume. The four free items stay because the
unofficial-client axis they contain is the one Part 12 does **not** address.

**New in this tier:** Part 12's W0-W7, which is where the money now goes, and
which ships behind a flag that defaults off.

**Tier 3 - observability:** `fleetTruth()` (~a day, 9.7) → `wa_risk_events` →
`wa_risk_snapshots` + rollup → `BanRiskPanel` → `wa_policy_versions` → transport
tiles *(after the proxy work, or every tile honestly reads "not configured")*.

**Then Tier 4 - legal (9.9),** which is hours and gates nothing.

## 9.11 The standing caveat, in the words it must keep

To survive into the code comments, not just this document:

> None of this makes 20-30 cold introductions from a fresh personal number safe.
> Every measure here addresses the **velocity** axis. The unofficial-client axis
> fires on reply-only accounts, correlates across the fleet, and is untouched by
> pacing, ordering, metering or proxies.

That is the honest floor. Everything in Parts 8 and 9 raises the ceiling above it.

---

# PART 10 - PUBLISHING THIS PLAN TO THE REPO

Owner request: this document should live in the repository root so it can be read
and copied from GitHub rather than only from the agent's plan directory.

- **File:** `MASTER-PLAN.md` at the repo root, matching the existing convention
  there (`ANTI-BAN.md`, `PRODUCTION-READINESS.md`, `V2-BLUEPRINT.md`, `GUIDE.md`).
- **Content:** a verbatim copy of this plan (Parts 0 through 9), with a short
  header noting it is the living master plan and that `ANTI-BAN.md` is superseded
  wherever the two disagree - Part 0.37 establishes that `ANTI-BAN.md` describes
  defences that are inert (`CONNECT_FINGERPRINT`) and attributes the restriction to
  the wrong cause.
- **No secrets.** The document names config **keys** only (`PROXY_HOST`,
  `EVOLUTION_PROXY_TEMPLATE`, `CONFIG_SESSION_PHONE_CLIENT`) and no values,
  credentials, gateway hostnames or account identifiers. Verify once before commit.
- **Commit** on `claude/rental-agents-legal-setup-o7rgcv` and push with
  `git push -u origin claude/rental-agents-legal-setup-o7rgcv`. Docs-only, so no
  typecheck or build gate applies. No pull request unless asked.
- **Keep in sync:** future rounds edit the plan file, then re-copy. The repo copy is
  the published artifact, not the working one.

---

# PART 11 - FIVE OWNER FEATURES, INTEGRATED

**Context.** The owner specified five additions: wave-paced initial outreach, a
global agency response scanner that prunes non-responders, a forced free-tier
warm-up before any paid upgrade, a premium progress bar, and a sanity pass over
all of it. Three of the five collide with constraints locked in earlier rounds.
This part resolves each collision, and one of the features turns out to fix a
contradiction the plan has been carrying since Part 0.

**Four decisions taken by the owner** (asked because the arithmetic forced a
choice, not because the intent was unclear):

| # | Decision |
|---|---|
| 1 | **5-8 shops per 20 min, day-one ceiling 24** - the pacing spec wins, the 30-shop mandate is revised down |
| 2 | **Reversible suppression + re-test trickle**, not permanent deletion |
| 3 | ~~Days linked AND a clean safety signal~~ → **REVISED: usage depth, same-day achievable** (Part 12.3). A calendar-day floor would have hidden the paywall behind a window longer than the average trip |
| 4 | **Two-segment progress bar** - reaching, then collecting |

## 11.1 F1 - Wave-paced initial outreach

**This supersedes Vector 1's 5-8 per 8-12 min** (Part 0.2) and the SLA table in
Part 0.3. Both must be edited when this ships, or the plan contradicts itself.

```
planWaves({ total, plan, rand }) -> Wave[]
  size drawn 5-8 (gaussianUnit, not flat)
  gap  drawn 18-22 min around a 20 min centre
  ceiling: 3 waves / 24 shops on day one
```

The owner's spec is **2.5x slower than the existing Vector 1 design** and slower
than anything the last five rounds proposed. That is a real safety gain, and it
costs 6 shops off the day-one ceiling. At q=0.35 a 24-shop batch settles to ~15
open unanswered threads against ~19-21 for 30 - so this lands meaningfully below
the exposure the two-meter budget (9.3) was sized for.

**Five integration points, all of which change other code:**

1. **`BATCH_WINDOW_MINUTES = 15` (`capacity.ts:77`) changes meaning** from "the
   whole batch" to "wave 1", and every reader changes with it - including ETA copy
   and F4's bar.
2. **The wave must be expressed twice**, at the enqueue-time `not_before` floor
   **and** as a wave-aware admission rule in the drain. Part 0.2 already
   establishes that the drain is the authoritative pacer and would otherwise
   reshape the schedule on first contact.
3. **The drain's 2-cold-rows-per-invocation budget** re-stamps the rest by 2-4 min.
   Inside a 20-min wave that is harmless, but a wave of 8 needs 4 drain
   invocations to clear. Wave size and drain budget must be reconciled explicitly
   rather than left to fight.
4. **`fast_dispatch` must be off for cold intros**, or the 20-min schedule is
   decorative - it lifts the clock gate and fires everything immediately.
   Already in the plan (Tier 0/Vector 4); F1 makes it load-bearing.
5. **`HARD_MIN_GAP_SEC = 8` (`pacing.ts:71`) is unaffected** - `batchStagger` runs
   unchanged *inside* each wave with `windowMs` at roughly 60% of the wave gap, so
   each wave is a short burst followed by real silence.

**Per-tier duration is NOT one hour.** Free tier is 10 shops = 2 waves ≈ 20-25
min. Only a full 24-shop batch approaches 60 min. **F4's bar must be driven by the
computed schedule, never a hardcoded 60 minutes.**

**The 1-hour SLA framing must change, and Part 5.10 already established why.** If
dispatch ends at t+60, the last shop cannot reply *and* negotiate inside the hour.
The honest promise is **"your first real quotes within the hour"** - wave 1 replies
land around t+5-8 - not "the best local price within the hour."

## 11.2 F2 - Agency health scanner and suppression

**This is the strongest ban-safety feature in the set, and that is not why it was
requested.** Unanswered introductions are the quantity Meta meters (Part 0.37).
Removing shops that never answer *directly reduces the metered quantity* - it is
the only proposal in eleven parts that raises revenue quality and lowers ban risk
with the same mechanism.

It also compounds with F1: **suppression raises q, higher q means fewer open
unanswered threads, and the two-meter budget (9.3) then grants more headroom.
F2 is how the day-one ceiling gets back from 24 to 30 honestly** - earned from
measured reply data rather than asserted.

**Three-state model, per shop, global across users:**

```
live       default
watch      failing, still shown, still selectable
suppressed hidden from discovery, NOT deleted, re-tested on a trickle
```

**Constraint 1 is preserved by putting the filter in exactly one layer.**
Suppression is a **discovery-layer** filter and **never** a send-layer gate. Three
rules make that real:

- A shop that appears in the list is always contacted. No suppression check ever
  runs in `guardOutbound` or the drain.
- A suppressed shop remains reachable by **explicit search by name**, so a
  traveller standing outside that shop can always message it.
- The re-test trickle (roughly 1 in 20 searches carries one suppressed shop)
  guarantees suppression is self-correcting. Permanent deletion is not: a deleted
  shop can never generate the evidence that it was wrongly judged.

**Two hard sequencing gates. F2 must not run before either.**

1. **Not before Tier 0.4 and 0.5 have been live long enough to gather clean data.**
   Today the opener carries no date (`promptCompiler.ts:64` - unanswerable, reads
   as reseller spam) and `fast_dispatch` neutralises `openNow`, so closed shops are
   as likely to be message #1 as open ones. **Pruning on that data deletes shops
   that failed our defect, not their service.** This is the single most important
   sequencing constraint in Part 11.
2. **Sample floor n >= 8** per shop (rule E4, Part 9.2). Most shops will sit at
   n=1-2 for months, so suppression will affect very few shops at first. Say that
   plainly rather than promising a fast climb to 100%.

**Data source.** Not `response_times` - Part 9.8 already rules it out, because its
clock is anchored to the global first-ever outbound rather than this user's
introduction, so a shop contacted three weeks ago that answers in two minutes
records a three-week sample and never corrects. F2 rides on the **clean per-(shop,
user) intro→reply ledger already planned**: `first_intro_at` / `first_reply_at` on
the tail-canonicalised `wa_recipient_state` (Tier 1.0/1.5) and `wa_cold_intro`
(Part 5.8). **No new plumbing** - F2 is an aggregation over rows Tier 1 already
creates.

Cross-user aggregation is permitted: Part 9.8 allows shop **responsiveness** as
behavioural data. It carries no quote, price or negotiation content, so constraint
3 is intact.

## 11.3 F3 - The exclusive club, and the contradiction it resolves

**This is the best of the five features, and it fixes something the plan has been
stuck on since Part 0.**

Part 9.1 established that an `ageRamp` cutting a day-0 Ultra user from 40 to 10
**violates constraint 4** - `capacity.ts:99-104` records "full budget usable day 0"
as an explicit owner requirement. So the plan had a genuine tension: day-0 volume
is the top ban risk, and reducing it was forbidden.

**F3 dissolves it by moving the warm-up from the capacity layer to the
monetization layer.** Instead of selling Ultra and then secretly throttling to 10 -
the dishonest version - **we do not sell Ultra until the number is warm.** The free
tier's 10 introductions *is* the safe day-0 number. Every user gets the full budget
of the plan they are actually on. No hidden throttle, no `ageRamp`, no constraint-4
violation, and `capacity.ts` stays exactly as the owner specified.

**It also makes a false claim true.** Part 9.6 lists "brand-new numbers are warmed
up gently" (`TrustPanel.tsx:13`) among eight strings the code contradicts. F3 is
what makes that sentence honest for the first time - so 0.6's replacement copy
should be written *once*, against the post-F3 behaviour.

**Unlock rule - REVISED, and the revision is important.** The rule below was
`days_since_first_link >= 7 AND replies_received >= 1 AND restriction_events == 0`.
**A calendar-day floor is wrong for this product and would have quietly destroyed
conversion.** Our users are travellers: a large share search for a bike on the day
they land and have finished with the app inside 72 hours. A seven-day clock hides
the paywall behind a window longer than the entire trip, so the modal purchaser
would never see a purchasable Premium at all - and the failure is invisible,
because it looks like low conversion rather than a closed door.

Owner decision: **warm-up is measured in usage depth, not elapsed time.** The
predicate, its thresholds, the copy and the enforcement points are specified in
**Part 12.3**, which is now the single source for this feature. The reply
condition survives into it unchanged and for the same reason: **a number nobody
has ever answered is not a warmed-up number**, it is a number accumulating
exactly the signal that gets accounts restricted.

**Prerequisites and edge cases, all of which must be handled or the feature
strands users:**

| Issue | Resolution |
|---|---|
| `wa_sessions.first_linked_at` **does not exist** (Part 5.13) | Hard prerequisite. Set once, never overwritten |
| User never links WhatsApp → clock never starts → can never pay | The gate must render as "link your number to start" with the clock visibly not running, not as a silent block |
| User restricted during the free window | Needs a defined recovery path to eventual unlock, never a dead end |
| `TEST_MODE` testers ride Ultra free | Must be exempt, or beta testers cannot test paid tiers |
| Server-side enforcement | The gate belongs on the checkout route, not only in `UpgradeSheet` - a client-only gate is not a gate |

**Cost.** Part 9.5 established the free tier carries proxy egress at zero revenue.
Seven forced free days at $0.60-0.90/user-month is roughly **$0.14-0.21 per new
user** - small, and it is why **C.0.1 (killing `LAUNCH_DISCOUNT`, ₪16.50/₪88
permanent) should ship before or with F3**, since Pro at the discounted price is
margin-negative before this feature adds any cost at all.

**Tone.** Framed as an exclusive club that unlocks, never as a punishment or a
restriction - and per constraint 5 the mechanism is described as protecting the
number, with ban language reserved for the linking/consent screen.

## 11.4 F4 - The two-segment progress bar

**The single largest risk in this feature is that it becomes a fifth number that
disagrees with the other four.** Part 5.5: there are four live derivations of
"how many shops have been contacted" plus a fifth dead one, and `page.tsx:2996`
renders `Math.max()` of two of them - the app already picks which of its own
numbers to believe at render time.

**Hard dependency: F4 must be built on the single server-side monotonic rung per
shop (M17 / Part 5.5), not alongside it.** Built any other way it makes the worst
UI defect in the app measurably worse.

**Definition** (owner decision 4):

```
segment 1  0-60%    shops reached / shops selected      exact, from outbox rows
segment 2  60-100%  quotes collected / shops reached    exact, from the rung
```

- Segment 1 is exactly computable and monotone.
- Segment 2 **continues past t+60**, which is what keeps the bar honest about the
  fact that dispatch finishing is not the same as the price being found.
- The bar **never** displays 100% while any negotiation is live.
- Duration comes from `computeQueueEtas` (`eta.ts:77`), which today models a
  continuous trickle and **has no concept of waves** - M2.2 in Wave B. F4 and F1
  need the same edit, so they ship together.

**Three states the bar must express, or it will lie:**

| State | Behaviour |
|---|---|
| Held on the hourly cap | Bar **stops**, with the honest reason - never keeps climbing |
| Cold intros halted by the error-ack detector | Bar stops at segment 1; copy is *"Waiting on replies before opening more conversations"* - **never** "ban" or "restricted" (constraint 5) |
| Shops that never reply | Segment 2 resolves against **shops reached**, so silence does not hang the bar at 80% forever |

Reuse the existing bar at `page.tsx:3319-3330` and the existing loading primitives
rather than introducing a parallel set.

## 11.5 SANITY CHECK - the conflicts, and what breaks if they are ignored

### The one that would ship a visible bug

**F1 and F4 are both dead on arrival until Tier 1.1, and together they expose an
existing bug directly to the user for the first time.**

Verified: there is exactly **one** send path (`evolution.ts:1925`) and it calls
`checkRateLimit` unconditionally with **no kind filter** - `LIMIT_WA_PER_HOUR = 15`
(`usage.ts:83`). At 8 shops per 20 minutes, **shop 16 arrives around t+40min and is
refused.** Today that is an invisible stall. With F4 shipped, the user watches a
premium progress bar **freeze at roughly 65% for twenty minutes** and then resume.

The same cap starves the reply lane: every agent reply to a shop that answers
inside that hour competes with the intro batch for the same 15 slots. **Tier 1.1
(split the pool) is a hard prerequisite for F1 and F4 both.**

### The rest, with the consequence of ignoring each

| # | Conflict | Consequence if ignored |
|---|---|---|
| 1 | F1 supersedes Vector 1 (5-8 per 8-12 min) and the Part 0.3 SLA table | The plan contradicts itself in two places |
| 2 | `MASS_BARGAIN_MAX = 15` (`mass-bargain.ts:23`) | 24 shops **cannot be requested at all**. Tier 1.2 must land first |
| 3 | Three capacity numbers still disagree - `PLAN_CAPACITY` 30, `usage.ts` 15, `newContactBudget` docstring 15 | F1's ceiling of 24 becomes a fourth number in the argument |
| 4 | F1's 20-min gap vs `BATCH_WINDOW_MINUTES = 15` | ETA copy and F4's bar both read a constant that no longer means what it says |
| 5 | F1 vs `fast_dispatch = true` default | The wave schedule is decorative; everything fires at once |
| 6 | F1 vs the drain's 2-cold-row budget and 2-4 min re-stamp | Wave boundaries smear; a wave of 8 needs 4 invocations |
| 7 | F2 vs constraint 1 (absolute shop choice) | Resolved by confining suppression to the discovery layer, plus name-search escape and the re-test trickle |
| 8 | F2 running on pre-Tier-0.4 data | Suppresses shops that failed **our** broken opener. Worst failure mode in Part 11 |
| 9 | F2 vs `response_times` | Its latency clock is anchored wrong (Part 9.8). Use the Tier 1.0 ledger instead |
| 10 | F2 sample floor | A ratio from n=2 is theatre; rule E4 applies |
| 11 | F3 vs the Part 9.1 `ageRamp` prohibition | **Not a conflict - F3 resolves it.** Warm-up moves to monetization, capacity untouched |
| 12 | F3 vs missing `first_linked_at` | The unlock clock has nothing to count from |
| 13 | F3 vs `TEST_MODE` | Testers cannot test paid tiers |
| 14 | F3 vs free-tier egress cost | Small (~$0.14-0.21/user), but pairs with C.0.1 |
| 15 | F4 vs the four existing derivations | A fifth disagreeing number on the most-watched surface |
| 16 | F4 vs `computeQueueEtas` having no wave concept | The bar's duration cannot be computed; same edit as F1 |
| 17 | F4 vs constraint 5 tone | A restriction rendered to the traveller in ban language |
| 18 | F1 per-tier duration | Free tier finishes in ~22 min; a hardcoded 60-min bar would sit at 40% while already done |

### Nothing here contradicts the anti-ban protocols

Checked against all six standing constraints. F1 **strengthens** pacing. F2
**directly reduces the metered quantity** and is the only feature that improves
safety and revenue with one mechanism. F3 **removes** day-0 volume without
violating constraint 4, which nothing else in eleven parts managed. F4 is
presentation only and touches no send path. The one genuine tension - F2 versus
absolute shop choice - is resolved by layer separation, not by weakening the
constraint.

**The caveat from 9.11 is unchanged and none of these five features move it.**
All of this addresses the velocity axis. The unofficial-client axis fires on
reply-only accounts, correlates across the fleet, and is untouched by pacing,
curation, monetization gates or progress bars.

## 11.6 WHERE THESE LAND IN THE EXECUTION PATH

Nothing in Part 11 displaces Tier 0. Two features have hard Tier 1 dependencies.

| Feature | Ships after | Blocked by |
|---|---|---|
| **F3** exclusive club | Tier 0 | `wa_sessions.first_linked_at`; C.0.1 pricing. **Otherwise independent - the earliest of the five** |
| **F1** wave pacing | Tier 1.1, 1.2 | Pool split, `MASS_BARGAIN_MAX`, `fast_dispatch` off for cold |
| **F4** progress bar | Tier 1.1 + M17 | The monotonic rung, and the pool split, or it renders a 20-minute freeze |
| **F2** agency scanner | Tier 1.0/1.5 + a data-collection window | Tier 0.4 and 0.5 must have been **live long enough for n>=8 per shop** |

**F3 first.** It is the only one of the five with no send-path dependency, it
removes day-0 volume immediately, and it makes the warm-up copy in Tier 0.6 true
so that string only has to be written once.

---

# PART 12 - THE BUSINESS-NUMBER HANDOFF, AND THE WARM-UP GATE

> **This part is referenced from, not appended to, the rest of the plan.**
> Wave C.0 (pricing), Part 11 F3 (warm-up), Part 8 Tier 2 (proxies), Part 9.10
> (execution path) and Part 0.9 (ordering) have each been edited in place to
> point here. Where an earlier part contradicts this one, this one wins and the
> earlier text carries a correction marker.

## 12.0 What this changes, and the three things it does not

The owner's directive: WheelDeal buys official WhatsApp Business Platform access
through a reseller. When a traveller starts a chat with an agency, **our** official
number sends the first message - *"we have a client interested in renting a
motorcycle, please message them at <number>"* - the agency messages the traveller
directly, our ingest detects that inbound, and the AI agents take over the
negotiation from the traveller's own linked number.

**The core insight is correct and it is the best structural idea in twelve parts.**
Every previous round tried to make an unsolicited first contact *safe*. This makes
the unsolicited first contact **somebody else's problem to survive** - specifically
ours, on an asset we can replace, instead of the traveller's, on an asset they
cannot. That is a real and large improvement, and the plan adopts it.

Three claims in the directive do not survive contact with the evidence, and the
architecture below is designed around their being false rather than true.

### (1) It does not "100% eliminate ban risk" - it relocates one of the two axes

Part 0.37 established two independent enforcement axes. This pivot addresses
exactly one of them:

| | Axis 1 - velocity / unanswered cold volume | Axis 2 - unofficial-client detection |
|---|---|---|
| Penalty | scoped restriction: may reply, may not start new chats | **full ban** |
| Before the pivot | on the traveller's personal number | on the traveller's personal number |
| **After the pivot** | **moved to our WABA** | **unchanged - still the traveller's personal number** |

The traveller still links their own WhatsApp through Baileys/Evolution, because
the negotiation still runs from their number. Axis 2 **fires on accounts doing
reply-only work** - that is not speculation, it is the finding that killed the
"inbound-first is immune" thesis in Part 0.37. So the honest statement is:

> The pivot removes the traveller's exposure to the *scoped restriction* almost
> entirely, and reduces - but does not remove - their exposure to the *full ban*,
> because a lower-volume reply-only session is a smaller target but still an
> unofficial client.

This wording is load-bearing. It must reach the consent screen and the Trust
panel, and it must not be softened into "your number is protected". Part 9.6
already deleted eight strings that made exactly that class of promise; shipping a
ninth would be worse than the eight, because this one would *feel* earned.

### (2) It does not "guarantee that agencies will respond" - it may lower reply rate

We are replacing *"a traveller messages you"* with *"a middleman asks you to go
message a stranger"*. The second is more work for the agency and reads more like
lead-gen, which is the register Part 5.12 identified as the thing people block.
The reply rate `q` - still unmeasured, still the quantity every SLA claim in this
plan rests on - could move in either direction, and the design must not assume up.

**The engineering answer is to remove the work.** The template carries a
**dynamic URL button** that opens the traveller's chat in one tap, so the agency
never types or saves a number. See 12.1.3 - and note that `wa.me` links are
**rejected by Meta inside templates**, which is why this routes through our own
domain and is also how we get per-agency click telemetry.

### (3) Dropping proxies is defensible, but not for the stated reason

The owner is dropping the proxy layer. **Accept the paid items, keep the free
ones.** Tier 2.6 (~$255 residential traffic) and 2.5 (second Evolution host) were
blast-radius containment for the traveller's session, and with cold outbound gone
from that session the value drops enough that the money is better spent on WABA
message volume. But **2.1-2.4 cost $0** and still protect the axis this pivot does
not touch. Part 8 Tier 2 has been edited in place accordingly.

### (4) And the constraint the owner set - no conflicts with what we are executing

Owner decision, recorded and binding: **the legacy path stays default-ON.** The
official-API path is built completely, wired completely, and ships **off**, behind
a real feature flag, activated by pasting credentials into the dashboard and
flipping a switch. Nothing in Tiers 0 and 1 is wasted or reversed - every one of
those items remains load-bearing for the default path, and remains the fallback
for the new one. The coexistence contract is 12.8, and it is the part most likely
to be got wrong by a future edit, so it is written as invariants rather than prose.

## 12.1 The handoff, mechanically

### 12.1.1 The one platform fact the whole design turns on

Outside a customer service window, a business may only send a **pre-approved
template**, which is metered, priced, and subject to the per-recipient marketing
cap. **Inside** an open 24-hour service window - opened by *any* inbound message
from that agency, and restarted by every subsequent one - the business may send
**free-form** messages that are unlimited, free, and **do not count against the
messaging tier at all**, because the tier meters unique recipients contacted
*outside* a window.

So there are two lanes, and they behave nothing like each other:

| | Template lane (cold) | Service-window lane (warm) |
|---|---|---|
| When | no inbound from this agency in the last 24h | agency messaged us within 24h |
| Cost | per-message, marketing or utility rate | **free** |
| Tier limit | counts against unique-recipients/24h | **does not count** |
| Per-recipient cap | error **131049** applies to marketing | does not apply |
| Content | fixed, pre-approved, variables only | **anything, including informal text and `wa.me` links** |

**Every design decision below follows from wanting traffic in the right-hand
column.** The first traveller to pick an agency pays the template; if that agency
answers, every subsequent traveller that day is free, uncapped and instant.

### 12.1.2 The template

Owner decision: **template per lead, no pre-recruited roster.** The traveller
picks any agency in the app and the handoff fires immediately, with no manual
district onboarding. The risks were raised and the decision reaffirmed; what
follows is the engineering that makes it survivable rather than a re-argument.

Register **one** first-contact template, drafted for **utility** categorisation
and neutral in register. Utility matters enormously: utility templates are
**exempt from the 131049 per-recipient marketing cap** and are priced lower.
Meta assigns the category and can re-assign it, so this is a goal, not a
guarantee - the queue in 12.2 is built to survive being categorised marketing.

Drafting rules, each one traceable to a documented rejection reason:

- No promotional language, no offer, no urgency, no emoji-led opener.
- **No `wa.me` link and no URL shortener anywhere** - both are named rejection
  causes. The button URL is our own domain.
- Name WheelDeal explicitly. A message that hides who is contacting them is both
  a policy problem and, per 12.5, a strategy that cannot work anyway.
- Variables carry only: agency display name, vehicle class, rental dates, and the
  link token. Never the traveller's raw number in the body - it goes in the
  button target, so the agency taps rather than transcribes.
- Register the template in **English plus the primary language of each launch
  region**, and select by region the way `promptCompiler.ts` already does for
  openers.

**A second template is required and is easy to forget:** a *re-engagement*
template for an agency that replied once and has since gone quiet past 24h. It
is the same shape and the same category question.

### 12.1.3 The one-tap handoff link, and why it also fixes attribution

The template's call-to-action is a **dynamic URL button**: a fixed base on our own
domain plus a variable suffix.

```
https://<APP_DOMAIN>/h/{token}
   -> 302 -> https://wa.me/<traveller-number>?text=<prefilled opener>
```

This single indirection buys four things, and three of them are problems we would
otherwise have had to solve separately:

1. **It is permitted.** A full domain URL passes template review where a `wa.me`
   link does not.
2. **It removes the agency's work entirely** - one tap opens a chat with the
   traveller. This is the mitigation for 12.0(2).
3. **It gives us the first real per-agency engagement telemetry in the product** -
   template delivered, template read, **link tapped**, chat actually started. That
   is a far better responsiveness signal than anything Part 11 F2 could compute,
   and F2's agency scanner should consume it.
4. **It solves thread attribution.** The prefilled text is authored by us, so when
   the agency's message lands on the traveller's phone it carries a phrase our
   ingest can recognise, plus a short opaque code. That matters more than it
   sounds - see 12.9(1).

`token` is a single-use, expiring, opaque id bound to (lead, agency, traveller).
It must not be guessable and must not encode a phone number, because anyone who
receives a forwarded template can tap it.

### 12.1.4 The state machine

One lead, one row, one path through these states. Terminal states are marked.

```
draft
  -> window_open?  yes -> handoff_freeform_queued -> handoff_sent
                   no  -> template_allowed?  yes -> template_queued -> template_sent
                                             no  -> held(reason) [see 12.2]
template_sent -> agency_replied_to_us   (service window opens; flush any held leads)
              -> link_tapped
              -> traveller_got_inbound  -> handed_off  [TERMINAL - agents take over]
              -> undelivered(131049|other) -> held / fallback
              -> expired(no response in N)  -> fallback_legacy | abandoned [TERMINAL]
```

`handed_off` is the moment the existing product resumes: from there the
negotiation is exactly today's flow, on the traveller's own number, through SPTE
and the graph engine, with every Tier 0/1 protection intact.

## 12.2 The queue and the rate governor - the owner's explicit requirement

> *"build intelligent rate-limiting, queue management, and fallback mechanisms
> directly into the backend. Ensure that high-volume shops don't trigger Meta's
> spam blocks or volume caps, and protect our WABA asset gracefully."*

This is the heart of the new backend and the part that decides whether the pivot
scales to hundreds of concurrent users or collapses in a week. It is a **single
admission decision** taken per lead, against **four independent budgets**, and it
fails **closed** in every direction - because unlike the traveller's session, a
mistake here degrades an asset shared by every user simultaneously.

### 12.2.1 The four budgets, and why the popular agency is the real bottleneck

| # | Budget | Bound | Why it exists |
|---|---|---|---|
| B1 | **Per-agency template cooldown** | 1 template / agency / 24h (tunable) | The binding constraint. **131049 caps a recipient at roughly two marketing templates per 24h across all businesses combined** - not just ours. Our ranking is a pure total order with no user-dependent term (Part 5.11), so every traveller in a district sees the *same* top agencies. Without B1 the third traveller of the day is silently undelivered at exactly the shops that matter most |
| B2 | **Portfolio tier budget** | unique recipients / 24h outside a window | 250 unverified, 1,000 after business verification, then 10k/100k. Note this counts **unique agencies**, not messages, and **excludes service-window traffic** - so it is far less binding than it first appears, because agencies are a small shared set |
| B3 | **Quality-rating governor** | derived from Meta's per-number quality signal | A falling rating is the early warning before a restriction. It must throttle automatically, not wait for a human |
| B4 | **Spend ceiling** | owner-set $/day and $/month | A runaway loop on a per-message-priced API is a financial incident, not a bug |

`admit = min(B1, B2, B3, B4)` - the same shape as `newContactBudget`'s
`Math.min(...)` in `wa-guard.ts`, deliberately, so the two governors read alike.

### 12.2.2 The mechanism that makes B1 survivable instead of merely safe

B1 looks like it caps a popular agency at one traveller per day. It does not,
because of the service window - and this is the single most important behaviour
in the design:

> Traveller 1 picks Agency A. No window is open, so A gets **the template**.
> Travellers 2-9 pick Agency A in the same hour. They are **held**, not dropped.
> A replies to our business number → **the 24h service window opens** → every
> held lead for A **flushes immediately as free-form messages**: free, uncapped,
> outside the tier, and in whatever informal register we like.

So the cost and the risk of an agency are paid **once per day at most**, and
popularity becomes cheap rather than expensive. The hold is short by
construction: if A does not reply within the configured window (default 20-30
min, tunable), the held leads take a fallback.

**Held is a first-class, user-visible state, not a silent queue.** Part 5.5's
finding stands: a shop dropped before the loop is counted nowhere and cannot be
explained. Every held lead emits a row and a reason, and the traveller sees
*"waiting for <agency> to open the conversation"* - not a stalled spinner.

### 12.2.3 Fallback ladder

In order, first applicable wins:

1. **Service window open** → free-form. Always preferred.
2. **Template allowed** → template.
3. **Held** → wait for the window, up to the hold timeout.
4. **Legacy direct path**, if the flag permits it → the traveller's own number
   sends, through the existing fully-hardened Tier 0/1 pipeline. This is why 12.8
   keeps the old engine alive rather than deleting it, and it is the answer to
   *"a shop the business number cannot reach must still be reachable"*
   (constraint 1, absolute shop choice).
5. **Honest refusal** → surfaced with a real reason and a retry time. Never a
   silent drop, never a fake "sent".

### 12.2.4 Reacting to what Meta tells us

Every one of these arrives on the webhook today and would be discarded by a naive
integration. Each gets a handler and a state transition:

- **131049** (`failed`) → mark the agency `template_capped_until` = +24h; do **not**
  retry; drop to the ladder. Counting this as a generic failure and retrying is
  the mistake that turns a soft cap into a quality-rating problem.
- **131047** (no open window, template required) → a bug in our own window
  bookkeeping. Alert, do not paper over.
- **Quality rating drop** → B3 tightens automatically; owner alerted.
- **Number restricted / flagged** → **global kill switch on the official path**,
  automatic and immediate, with every subsequent lead taking the legacy fallback.
  The WABA is rented from a reseller, not owned - see 12.6 - so a complaint spike
  can end the account with someone else's decision. Fail fast and loudly.

### 12.2.5 The fail-dark contract applies here too, unchanged

Every read behind these budgets uses `sbSelectStrict`, and an unreadable budget
**denies** rather than permits. Part 9.2's `TileState` vocabulary
(`ok | warn | critical | dark | empty`, severity `ok < warn < dark < critical`)
and the E1-E9 empty-state rules are reused verbatim for the new dashboard in
12.4.2 - not re-derived. The failure this repo has shipped twice is a green panel
over a dead sensor; a second dashboard is a second chance to ship it.

## 12.3 The warm-up gate - pricing, access and the copy

Supersedes Wave C.0.2 and Part 11 F3's unlock rule. Both now point here.

### 12.3.1 The decision, and the trap avoided

There is **no discount**. ₪16.50 Pro / ₪88 Ultra quarterly from day one, one
price source (`plans.ts`), per C.0.1.

Instead, **a user cannot buy a paid plan until the account is warmed up**, and
warm-up is measured in **usage depth, not calendar days**. The days-based rule
in Part 11 F3 would have hidden the paywall behind a window longer than the
average trip; the reasoning is recorded there so it is not reintroduced.

### 12.3.2 The predicate

Every threshold is an owner-tunable Key Vault value with the default shown, and
the whole gate has a kill switch. Numbers are a starting position to be moved
from the dashboard once real cohort data exists - not a claim.

```
warmedUp(user) =
      completedSearches      >= WARMUP_MIN_SEARCHES      (default 1)
  AND agenciesEngaged        >= WARMUP_MIN_ENGAGED       (default 3)
  AND repliesReceived        >= WARMUP_MIN_REPLIES       (default 1)
  AND whatsappLinked         == true
  AND restrictionEvents      == 0
  AND NOT accountFlagged
```

- `agenciesEngaged` counts distinct agencies actually reached, from the
  tail-canonicalised `wa_recipient_state` built in Tier 1.0 - **not** a raw send
  count, and not `response_times`, whose clock is anchored wrong (Part 9.8).
- `repliesReceived >= 1` is the condition carried over from F3, and it carries
  its original justification: an account nobody has answered is not warm.
- All of it is computable from data Tier 1 already writes. **No new counters are
  required for the predicate itself** - only for the dashboard in 12.4.1.
- A same-day traveller who runs one real search and gets three shops talking is
  warm within the hour. That is the intent.

### 12.3.3 Enforcement - four points, and three of them are the ones people forget

1. **`/api/billing/checkout`** - server-side, before any PayPal call. This is the
   only one that actually enforces anything; a client-only gate is not a gate.
2. **`UpgradeSheet`** - renders the locked state instead of the buy button.
3. **Deep links and the pricing page** - a user who arrives at checkout by URL
   must meet the same wall, with the same explanation.
4. **`TEST_MODE` and users flagged `test` are exempt**, or beta testers cannot
   test the paid tiers at all. Same for the owner allowlist.

Two edge cases that otherwise strand people permanently:

- **Never linked WhatsApp** → the gate must render as *"link your number to
  begin"* with the progress visibly not started, never as a bare refusal.
- **Restricted during the free window** → a defined recovery path to eventual
  unlock. A dead end here converts a bad day into a lost user.

### 12.3.4 The copy - eye level, desire not denial

Constraint 5 governs: this is quality control and access, and **the words "ban",
"restricted" and "risk" do not appear** outside the linking/consent screen. The
lint test from Part 9.6 already enforces exactly that and covers these strings
for free.

Primary, at eye level on the upgrade surface, with a live two-segment progress
indicator reusing F4's component rather than a new one:

> **Premium unlocks soon**
> We want you to get the most out of Premium, so unlock it by using the app a
> little more first.
> *You are 2 of 3 shops away.*

Secondary, on the locked buy button: **"Unlocks as you use the app"**.
On completion, a genuine moment - a one-time celebratory state, *"Premium is
unlocked for your account"* - because the entire value of a gate is the release.

Three rules the copy must hold to:

- **Always show the distance.** A gate with no visible progress is a wall, and
  reads as a bug.
- **Never imply the user did something wrong.** The subject of every sentence is
  the product getting ready, not the user being insufficient.
- **Never say "we are still evaluating you".** True, and corrosive.

## 12.4 The two dashboards

Both live in the existing Management Section, both owner-gated the way Ops
already is, both **read from hourly rollups rather than fanning out live**.
Part 9.7's reasoning is not repeated but is binding: `/api/activity` costs ~21
Supabase round trips per tick, and at fleet scale a live fan-out monitor becomes
the load it monitors.

### 12.4.1 Monetization and lifecycle (the owner's directive 1)

The question this answers is *"who is converting, who is stuck, and where"* -
which today has no surface at all.

**The funnel, as one row of counts with conversion between each pair.** This is
the spine and everything else hangs off it:

```
signed up -> linked WhatsApp -> ran a search -> reached >=1 agency
  -> received >=1 reply -> WARMED UP -> viewed upgrade -> checked out -> paid
  -> renewed
```

**Warm-up cohort analytics**, which is the part the owner asked for by name:

- Warmed-up users now, and the rate of warming per day.
- **Median and p90 time-to-warm** - the single number that says whether the
  threshold is set correctly. If p90 exceeds a typical trip, the gate is too
  tight and should be loosened from this screen.
- **Distribution of where non-warm users stall**, by predicate term. If most
  users fail on `agenciesEngaged`, the threshold is wrong; if most fail on
  `whatsappLinked`, the problem is onboarding, not pricing. This one chart
  changes what you work on next.
- **Conversion within 24h / 72h of unlocking.** The whole thesis of the gate is
  that earned access converts better. This is the only measurement that can
  falsify it, and it should be prominent enough to be uncomfortable.

**Suggested additions, offered because the directive asked for them:**

- **A holdout cohort.** Reuse the `WA_COHORT_PCT` primitive from Part 9.4 to let
  a small percentage buy immediately. Without it, "the gate improves conversion"
  is unfalsifiable forever - and with it, one number settles the argument.
- **Revenue per warmed-up user vs per signup**, and **refund/chargeback rate by
  cohort** - the gate's real claim is better-fit buyers, which shows up in
  retention and refunds before it shows up in volume.
- **Segments as saved predicates, not hardcoded tabs** - `warm & unconverted`,
  `converted & inactive`, `linked & never searched`, `restricted`. Each clickable
  through to the user list. Hardcoded segments go stale in a month.
- **Unit economics per cohort**, wired to the same meters as 12.4.2's spend, so
  the C.0.1/9.5 cost gate stays live instead of being a one-off calculation.
- **Trip-shaped time axis.** Days-since-signup is the wrong x-axis for a product
  with a 72-hour lifecycle; use hours-since-first-search for anything about
  activation.

### 12.4.2 The Business Platform console (the owner's directive 4)

Owner-only, and the operational counterpart to the risk dashboard in Part 9.7 -
same components, same `TileState` vocabulary, same empty-state rules, so it reads
as one system rather than a second dialect.

**Live state:** connection and credential health; phone number and display name;
**quality rating**; current messaging tier and headroom; today's spend against
B4; and the kill-switch, present and obvious.

**The lead ledger** - the thing the owner specifically asked to track. Every
first message we send, one row: agency, traveller, template vs free-form, lane,
send time, delivery, read, **link tap**, agency-replied-to-us, traveller-got-
inbound, handed-off, and terminal outcome. Filterable, exportable, and with a
single-lead detail view that shows the exact wire text and every timestamp -
because the first question about any failed handoff is always *"what did we
actually send them"*.

**Funnel tiles** on the same ledger: sent → delivered → read → **tapped** →
replied → handed off. The tap column is the one that tells you whether the
message worked, and no other product surface has it.

**Per-agency view:** template cooldown state, `template_capped_until`, window
open/closed with expiry, lifetime taps and replies, and the responsiveness score
that Part 11 F2's scanner consumes. **This is where F2's data problem gets
solved** - F2 needed a clean per-agency reply ledger and was blocked on one.

**Configuration, live and without a redeploy** - this is the "AI-agentic,
flexible" half of the directive, and it means *owner-editable behaviour*, not a
chat box:

- Template selection per region and language, with the approved body rendered
  read-only next to it so what Meta approved and what we think we send cannot
  drift.
- The prefilled traveller-opener text, per language, editable and previewed.
- Every budget in 12.2.1 as a live value: per-agency cooldown, hold timeout,
  daily spend ceiling, fallback ladder toggles.
- Which fallback rungs are enabled, including whether the legacy path may catch.
- **Dry-run mode**: run the whole pipeline, render the exact wire text, send
  nothing. This is how the template gets tested without spending quality rating.

**Sub-agent monitoring:** the handoff pipeline's own agents - lead composer,
category classifier, reply classifier (is this inbound the agency accepting, or
declining, or a bounce), attribution matcher - each with its recent decisions,
confidence, and a manual-override trail. Mirror `src/lib/ops/*` conventions and
route every behaviour change through `saveVersionedSpec`; do not invent a second
versioning mechanism.

**Two honesty constraints, carried from Part 9.7:** every configuration change is
a versioned row with an author and a diff, or before/after comparison on this
screen means nothing; and the footer states plainly that nothing here reduces the
chance of Meta restricting the number - it shortens the time between Meta pushing
back and the owner knowing.

## 12.5 "Humanizing" the official account - the honest answer

The directive asks for research into making the official account look and act
human: informal openers, and cycling profile picture, name and status every few
hours. Researched properly, and the answer splits cleanly in two.

### What is impossible, and why

**The display name cannot be cycled.** It is a *certified* name: submitted to
Meta, reviewed (typically 24-48h), and issued as a certificate. Changes are
capped at roughly ten per 30 days and each one needs review. Rotating it every
few hours is not rate-limited, it is structurally unavailable - and attempting it
would put the account into permanent review.

**The account is labelled as a business by WhatsApp itself.** An API-connected
number renders in the recipient's client with business-account treatment that we
do not control and cannot suppress. The agency will know. **This is not a
solvable engineering problem** - it is a property of the platform, and any design
whose value depends on concealing it is building on sand.

**And concealment is against the terms of the account we are renting.** Not our
own account: per 12.6 the WABA sits under a reseller's verified portfolio.
Deliberately disguising an automated business account is the kind of thing that
ends with the reseller terminating us, which takes every user's handoff path down
at once. The failure mode is not a warning - it is a Tuesday with no product.

**So: no persona rotation, no fake human identity, no attempt to pass as an
individual.** I am not going to design that, and it would not work.

### What is genuinely available, and it is more than it sounds

The owner's actual goal - *the first interaction should feel informal enough that
the agency engages rather than filing it as automated spam* - is reachable, and
the service window is what makes it reachable.

- **Inside the 24h window, message content is completely unconstrained.** No
  template, no review, no category. *"Hey - got someone looking for a scooter for
  4 days, can you message them?"* is entirely sendable there, along with `wa.me`
  links, and it is free. **Since 12.2.2 puts most traffic in this lane, most of
  our messages can be written in exactly the register the owner wants.** The
  template is only ever the first contact with a given agency in a given day.
- **Profile picture and the 139-character "about" text are freely updatable** via
  the profile endpoint - no review. A seasonal or campaign-appropriate picture is
  legitimate brand management. Cycling them hourly to fake authenticity is not,
  and buys nothing once the business label is visible anyway. The console exposes
  them as editable fields with an audit trail, and deliberately does **not** ship
  an automatic rotator.
- **Human timing is real and free.** Everything Vector 3 established still
  applies: send inside the agency's local business hours, vary the gaps, do not
  fire a burst at 03:00. This moves perception far more than a fake avatar would.
- **Warmth is a copy problem, and it is the one lever with real headroom.**
  Naming a specific vehicle and specific dates, writing in the agency's own
  language, and asking one answerable question does more for reply rate than any
  identity trick - which is precisely what Part 5.12 found when it discovered our
  opener was unanswerable.

**The strategic reframe worth stating:** the "authentic local traveller" illusion
is not being lost here, it is being *traded*. What replaces it is better -
predictable delivery, a business the agency can recognise and come back to, and
one tap to a live customer. An agency that learns WheelDeal means real renters
will answer faster than any stranger ever did. **Design for being a recognised
channel, not for being an unrecognised person.**

## 12.6 Prerequisites - what to obtain, and in what order

Owner's position, recorded: **there is no registered legal entity**, which is why
access is being bought through a provider rather than opened directly. That is
the correct call and it shapes everything below. Note `src/lib/legal.ts` still
carries `OPERATOR_NAME = "the Operator"` with a `TODO` to replace it with the
legal entity name - the same gap, already visible in the code.

**Consequence to go in with eyes open:** under a reseller, the WABA is **rented**.
The provider's verified portfolio hosts it, the provider can suspend it, and the
per-recipient and tier limits are Meta's regardless of who bills us. Two things
follow: quality rating is not a metric but an existential asset (hence B3 and the
automatic kill switch), and the migration path to a directly-owned WABA should be
kept open from day one - which is what 12.8's adapter boundary is for.

### From the provider

| # | Item | Notes |
|---|---|---|
| 1 | Account + **API key** | Stored only in the Key Vault, never in the repo or `render.yaml` |
| 2 | **Base URL / host** | Most resellers issue a per-account host; it must be configuration, not a constant |
| 3 | **Sender phone number** | Must be a number **not currently registered on WhatsApp** - it cannot be a personal number in use, and enabling it strips that number of normal WhatsApp use |
| 4 | **Approved display name** | Reviewed by Meta; expect 24-48h and a possible rejection round |
| 5 | **Two approved templates** | First-contact and re-engagement, per language, each with the dynamic URL button and its declared base URL |
| 6 | **Inbound webhook** configured to our endpoint | Many resellers configure this by support ticket rather than self-serve - lead time, not a task |
| 7 | **Delivery/status webhook** | Separate subscription on several providers. Without it there is no ledger, no 131049 handling, and no dashboard |
| 8 | **Webhook authentication method** | Meta signs with `X-Hub-Signature-256`; resellers often do not sign at all. If unsigned, the endpoint takes a secret path segment plus a shared-secret header, and rejects everything else |
| 9 | Sandbox or test sender | Needed to exercise the pipeline before spending quality rating on a live number |
| 10 | Written pricing per template category, per country, **and whether free-form is billed** | Directly determines whether 12.2.2's economics hold. Some resellers bill free-form messages that Meta provides free - on this design that fee lands on the majority of traffic |

### Config keys (Admin → Keys, scope `messaging`) - names only, no values

```
WABA_ENABLED              off        # the master switch. Default OFF (12.8)
WABA_PROVIDER             meta|reseller
WABA_BASE_URL
WABA_API_KEY
WABA_SENDER_ID                       # phone-number id or sender identifier
WABA_WEBHOOK_SECRET
WABA_TEMPLATE_FIRST_CONTACT
WABA_TEMPLATE_REENGAGE
WABA_LINK_BASE                       # must match the approved button base URL
WABA_AGENCY_COOLDOWN_HOURS   24
WABA_HOLD_TIMEOUT_MINUTES    25
WABA_DAILY_SPEND_CEILING_USD
WABA_DRY_RUN              on         # ships on; turned off deliberately
```

### Infrastructure

No new hosting tier. The webhook is a Next.js route on the existing Cloud Run
service; the queue is Supabase rows drained by the scheduler that already exists.
`APP_DOMAIN` becomes load-bearing in a new way - it is the approved button base
URL, so **changing it invalidates approved templates**, which is worth a comment
next to the setting.

## 12.7 Database - additive only, as always

Four tables and a few nullable columns. `add column if not exists` throughout; no
migration of existing rows; nothing here is read by the legacy path.

| Table | Purpose |
|---|---|
| `waba_leads` | One row per handoff attempt. The state machine of 12.1.4, the traveller, the agency, the search session, lane, template id, link token, and every timestamp the ledger renders |
| `waba_agencies` | Per-agency canonical state: phone tail key, `window_expires_at`, `template_capped_until`, last template at, lifetime sent/delivered/read/tapped/replied. **Keyed on the phone tail**, reusing `nationalTail()` from Tier 1.0 - re-splitting rows across spellings here would reproduce the exact bug Tier 1.0 just fixed |
| `waba_events` | Append-only wire log: every outbound send, every webhook, raw payload, error code. This is what makes a failed handoff diagnosable a week later |
| `waba_rollups` | Hourly aggregate for the dashboards, with `dark_signals[]` so E1/E8/E9 stay reconstructable |

New nullable columns: `app_users.warmed_up_at` (write-once, the moment the
predicate first passed - needed for time-to-warm and for cohort analysis) and
`app_users.warmup_snapshot` (the predicate terms at unlock, so a later threshold
change does not rewrite history).

**One thing not to build:** a new shop table. Agencies are still discovered per
search from Places; `waba_agencies` is keyed on the phone tail and is a
*messaging-state* table, not a directory. Introducing a second notion of "shop"
would be a genuine architectural regression.

## 12.8 Coexistence - the flag contract

Owner requirement, verbatim in intent: the old engine stays default, the new one
ships complete but **off**, and activation is credentials plus a switch.

These are invariants, written to survive a future edit that does not read this
section:

1. **`WABA_ENABLED` defaults OFF.** With it off, not one code path changes
   behaviour, no new table is read, and no new request leaves the process. A
   fresh clone with no configuration behaves exactly as it does today.
2. **The flag is checked server-side, at one choke point**, in the outreach
   dispatch decision - not scattered through the UI. `inCohort()` from Part 9.4
   is the primitive; the official path is a cohort like any other, so it can be
   enabled for the owner alone before anyone else.
3. **Credential absence is equivalent to the flag being off**, and says so in
   the console. A half-configured official path must never silently half-send.
4. **The legacy path is the fallback, permanently.** Rung 4 of 12.2.3 is not a
   migration artefact to be removed later - it is what makes constraint 1
   (absolute shop choice) survivable when an agency is uncontactable officially.
5. **Provider access sits behind one adapter interface**, with the Meta dialect
   as the reference implementation, because every reseller proxies the Cloud API
   underneath. `src/lib/whatsapp.ts` already speaks that dialect and the existing
   Meta-shaped webhook already does the challenge and signature dance - so the
   reseller adapter is a variation on something that exists, not a new subsystem.
   This is also the migration path off the rented WABA.
6. **No existing test changes meaning.** If a Tier 0/1 test needs editing to make
   this pass, that is a signal the flag is leaking, not a chore.

## 12.9 Conflicts with the current implementation - each one named and resolved

Owner requirement: *no conflicts with our current implementation or the plan we
are executing.* Ten were found. Two are serious, and the first is the one that
would have silently broken the whole feature.

**1. [SERIOUS] The traveller's inbound gate is built to reject exactly this
message.** Task #67 ("Z1: Privacy isolation - receiver scoping, ingestion gate,
anti-spoof") and #85 (the privacy leak where personal chats surfaced as shop
replies) exist precisely to stop an unknown inbound number being treated as a
shop reply. **The new design requires the traveller's system to accept and act on
an inbound from a number it has never written to** - which is the thing those
tasks made impossible, correctly. Resolution: a *narrow, pre-authorised*
exception. When a handoff is dispatched, write an expiring expectation for
(traveller, agency-tail, search-session); the ingest admits an unknown inbound
**only** if it matches a live expectation. Everything else stays rejected. The
prefilled opener code from 12.1.3 is the secondary matcher for the case where the
agency replies from a staff mobile rather than the listed number - which is
common, and which tail matching alone would miss. **This must not be implemented
by loosening the existing gate.**

**2. [SERIOUS] Two rate governors that know nothing about each other.** The WABA
governor (12.2) and `wa-guard`'s traveller-session governor would both be live
whenever the fallback ladder can reach rung 4. Part 0.37 already recorded what
happens when two rate systems fight - the plan model loses silently, and it took
a round to diagnose. Resolution: the fallback is a **single explicit handoff**
with a recorded reason, not two systems racing; a lead that has been admitted by
the WABA governor is never simultaneously eligible for the legacy path.

**3. `MASS_BARGAIN_MAX = 24` and the wave pacing of Part 11 F1** are constraints
on *the traveller's number*. Sending from our WABA has entirely different limits.
Resolution: the batch cap applies per lane; F1's wave pacing governs the legacy
lane only, and the official lane is paced by 12.2's budgets. Do not let one
constant try to mean both.

**4. Part 0.37 and Part 7.8 rule out the official Cloud API for cold contact** on
three grounds. Two still bite (131049; no opt-in on scraped numbers) and are
engineered around in 12.2. The third - *"a number lives on exactly one platform,
so a traveller's personal number can never be the WABA sender"* - **is no longer
an objection but the actual design**: our number is the sender, theirs is not.
Those sections carry correction markers pointing here.

**5. The two-meter unanswered budget (Part 9.3)** meters the traveller's
introductions. Official-lane leads are not introductions from that number and
**must not debit it**, or a user who never cold-sends will be throttled for
traffic they did not generate.

**6. Part 11 F2's agency scanner** was blocked on the absence of a clean
per-agency reply ledger. `waba_agencies` plus the tap telemetry is a better one
than it was going to build. F2 should consume it rather than aggregate its own.

**7. Part 11 F4's progress bar** gains a state. Segment 1 is now "agencies asked
to make contact"; a lead sitting in the 12.2.2 hold must render as *waiting for
the shop to open the conversation*, not as a stalled bar. Same rule as before:
the bar stops with a reason rather than climbing on nothing.

**8. Wave C.0.4/C.0.5's capacity copy** describes introductions from the
traveller's number. Under the official lane the number the traveller cares about
is different, and the copy needs a second variant selected by the active lane.

**9. The traveller's number is disclosed to a third party.** This is new, it is
personal data, and it is the sharpest item under the owner's *"100% clear to the
user"* requirement. It needs its own consent - a fourth entry in `CONSENTS`
alongside `terms`, `wa_risk` and `ai_responsibility`, with its own durable column
and a `TERMS_VERSION` bump so `needsReacceptance` re-prompts - plus a Privacy
Policy section naming what is shared, with whom, and why. The consent write
follows Part 9.9's rule for `wa_link`: **blocking, with retry**, and on durable
failure we do not dispatch.

**10. The user-facing model of the product changes** and the app currently says
the opposite. Today: *we message shops for you*. Under this lane: *we ask shops
to message you*. Every string describing outreach needs a lane-aware variant, and
the first-run explanation must state plainly that the agency will contact them
directly on WhatsApp and that WheelDeal's own number - not theirs - makes the
first approach. **A traveller who is surprised by an incoming message from a
rental shop is a support ticket and a trust failure.** This is the single largest
copy surface in Part 12 and it is not optional.

## 12.10 Where this lands in the execution path

Nothing here displaces Tier 0 or Tier 1, both of which remain load-bearing for
the default path. Ordering inside the new work:

| # | Work | Size | Why here |
|---|---|---|---|
| W0 | **The flag, the adapter boundary, and dry-run mode** | days | Everything else is unreachable without a switch that is provably off, and dry-run is how the rest is built without credentials |
| W1 | **Schema (12.7) + the lead state machine** | days | The ledger has to exist before anything writes to it |
| W2 | **Inbound expectation gate** (conflict 1) | days | The narrow exception, with tests that prove the general gate did not loosen |
| W3 | **Send path + webhook + status handling** | days | Includes 131049, quality rating, and the kill switch - not as follow-up work |
| W4 | **The governor and the fallback ladder** (12.2) | days | The part that decides whether this scales |
| W5 | **Business Platform console** (12.4.2) | days | Nothing can be operated safely without it |
| W6 | **Consent, privacy copy, and the lane-aware user-facing strings** (conflicts 9, 10) | days | **Gates first live activation.** No credentials go in before this ships |
| W7 | **Live validation on one owner-operated lead**, dry-run first, then a single real agency | days | The template's real category, the real button behaviour, and the real webhook shape are all unverifiable from here |

**The warm-up gate (12.3) and its dashboard (12.4.1) are independent of all of
the above** and depend only on C.0.1 plus Tier 1's recipient ledger. They should
ship first - they need no credentials, no provider, and no legal entity.
