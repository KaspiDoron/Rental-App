-- =============================================================================
-- WheelDeal - Supabase schema
-- =============================================================================
-- Run this once in your Supabase project: SQL Editor → paste → Run.
-- Only the service role (used server-side by the app) touches these tables, so
-- Row Level Security is enabled with NO public policies - the anon key can read
-- nothing here. Secrets are additionally encrypted at the app layer before they
-- are ever written to app_config.
-- =============================================================================

-- ---- Runtime config / Key Vault ---------------------------------------------
-- Stores admin-managed integration secrets (AES-256-GCM encrypted app-side).
create table if not exists public.app_config (
  key         text primary key,
  value       text not null,          -- ciphertext: v1:<iv>:<tag>:<data>
  updated_at  timestamptz not null default now()
);

-- ---- WhatsApp message log ---------------------------------------------------
-- Inbound vendor replies (from the webhook) + outbound agent messages.
create table if not exists public.whatsapp_messages (
  id            bigint generated always as identity primary key,
  wa_message_id text,
  from_number   text,
  to_number     text,
  body          text,
  type          text default 'text',
  direction     text not null check (direction in ('inbound','outbound')),
  raw           jsonb,
  received_at   timestamptz not null default now()
);
create index if not exists whatsapp_messages_received_idx
  on public.whatsapp_messages (received_at desc);
-- Thread lookup: match an inbound vendor reply to the last outbound message we
-- sent that number (powers the fully automatic in-app reply loop).
create index if not exists whatsapp_messages_thread_idx
  on public.whatsapp_messages (to_number, received_at desc);
-- Hot paths at scale: nearly every outbound guard/feed query filters by the
-- sender email stored in raw->>'sender', and the engagement check filters by
-- from_number - without these two, both become sequential scans as the table
-- grows (this is the app's hottest table).
create index if not exists whatsapp_messages_sender_idx
  on public.whatsapp_messages ((raw->>'sender'), received_at desc);
create index if not exists whatsapp_messages_from_idx
  on public.whatsapp_messages (from_number, received_at desc);

-- ---- App users (access control + signup details) -----------------------------
create table if not exists public.app_users (
  email                text primary key,
  phone                text,
  name                 text,
  provider             text default 'email',
  status               text not null default 'active' check (status in ('active','blocked')),
  plan                 text not null default 'free' check (plan in ('free','pro','business')),
  password_hash        text,
  must_change_password boolean default false,
  terms_accepted_at    timestamptz,
  added_at             timestamptz not null default now(),
  last_seen            timestamptz not null default now()
);
-- If you already ran an older schema, run these once:
alter table public.app_users add column if not exists plan text not null default 'free';
alter table public.app_users add column if not exists password_hash text;
alter table public.app_users add column if not exists must_change_password boolean default false;
-- The top tier is now "Ultra" (stored as 'business' for compatibility, but
-- allow both values):
alter table public.app_users drop constraint if exists app_users_plan_check;
alter table public.app_users add constraint app_users_plan_check
  check (plan in ('free','pro','business','ultra'));

-- ---- Auth events (every login/signup is recorded) -----------------------------
create table if not exists public.auth_events (
  id         bigint generated always as identity primary key,
  email      text,
  event      text,
  provider   text,
  created_at timestamptz not null default now()
);

-- ---- Email-ownership verification (pending signups) ----------------------------
-- Holds a hashed 6-digit code + the encrypted pending signup until the user
-- proves they control the email. Rows are deleted on success/expiry.
create table if not exists public.email_verifications (
  email       text primary key,
  code_hash   text not null,
  payload     text,
  expires_at  timestamptz not null,
  sent_at     timestamptz not null default now(),
  created_at  timestamptz not null default now()
);
alter table public.email_verifications enable row level security;

-- ---- Shop response-time samples (first reply speed, for the fast-responder tag)
create table if not exists public.response_times (
  id         bigint generated always as identity primary key,
  phone      text not null,
  ms         bigint not null,
  created_at timestamptz not null default now()
);
alter table public.response_times enable row level security;

-- ---- AI provider usage log -----------------------------------------------------
create table if not exists public.ai_usage (
  id         bigint generated always as identity primary key,
  provider   text,
  tokens     int default 0,
  failed     boolean default false,
  created_at timestamptz not null default now()
);

-- ---- Owner-taught bargaining transcripts ---------------------------------------
create table if not exists public.agent_training (
  id         bigint generated always as identity primary key,
  text       text not null,
  note       text,
  added_by   text,
  source     text default 'text',   -- 'text' | 'photo'
  created_at timestamptz not null default now()
);
-- If you already ran an older schema, run this once:
alter table public.agent_training add column if not exists source text default 'text';

-- ---- Vendor replies (raw) + composed bargain drafts ----------------------------
create table if not exists public.vendor_replies (
  id            bigint generated always as identity primary key,
  user_email    text,
  vendor_id     text,
  vendor_name   text,
  reply_text    text,
  image_count   int default 0,
  found         boolean default false,
  price_per_day numeric,
  matches_spec  boolean default false,
  confidence    text,
  auto          boolean default false,   -- true = ingested by the webhook agent
  created_at    timestamptz not null default now()
);
-- If you already ran an older schema, run these once:
alter table public.vendor_replies add column if not exists auto boolean default false;
create index if not exists vendor_replies_user_idx
  on public.vendor_replies (user_email, created_at desc);

create table if not exists public.bargain_drafts (
  id         bigint generated always as identity primary key,
  user_email text,
  vendor_id  text,
  tactic     text,
  message    text,
  created_at timestamptz not null default now()
);

-- ---- Search history (agent memory) -------------------------------------------
create table if not exists public.searches (
  id            bigint generated always as identity primary key,
  user_email    text,
  query_text    text,
  lat           double precision,
  lng           double precision,
  radius_km     numeric,
  vehicle_class text,
  source        text,
  results       int,
  created_at    timestamptz not null default now()
);

-- ---- Offers (real + simulated, flagged) ---------------------------------------
create table if not exists public.offers (
  id                 bigint generated always as identity primary key,
  user_email         text,
  vendor_id          text,
  vendor_name        text,
  price_per_day      numeric,
  list_price_per_day numeric,
  currency           text default 'USD',
  round              int default 0,
  simulated          boolean default true,
  verified           boolean default false,
  created_at         timestamptz not null default now()
);

-- ---- Agent learning memory (negotiation playbook) ---------------------------
create table if not exists public.agent_tactics (
  id               text primary key,
  label            text not null,
  script           text not null,
  uses             int  not null default 0,
  wins             int  not null default 0,
  avg_discount_pct numeric not null default 0,
  updated_at       timestamptz not null default now()
);

-- ---- Partner vendor directory (opted-in) ------------------------------------
create table if not exists public.vendors (
  id               text primary key,
  name             text not null,
  lat              double precision not null,
  lng              double precision not null,
  rating           numeric default 4.0,
  reviews          int default 0,
  vehicle_classes  text[] default '{}',
  fulfillment      text[] default '{}',
  whatsapp         text not null,      -- E.164, opted-in
  base_price_per_day numeric,
  partner          boolean default true,
  created_at       timestamptz not null default now()
);

-- ---- Personal WhatsApp sessions (Evolution API instances per user) -----------
create table if not exists public.wa_sessions (
  email         text primary key,
  instance_name text not null,
  status        text default 'connecting',
  host_url      text,
  updated_at    timestamptz not null default now()
);
create index if not exists wa_sessions_instance_idx
  on public.wa_sessions (instance_name);
-- If you already ran an older schema, run this once:
alter table public.wa_sessions add column if not exists host_url text;

-- ---- Bookings ---------------------------------------------------------------
create table if not exists public.bookings (
  id           bigint generated always as identity primary key,
  user_email   text,
  vendor_id    text,
  vendor_name  text,
  price_per_day numeric,
  total_price  numeric,
  fulfillment  text,
  scheduled_at timestamptz,
  status       text not null default 'confirmed',
  created_at   timestamptz not null default now()
);

-- ---- Feedback (triaged) -----------------------------------------------------
create table if not exists public.feedback (
  id             bigint generated always as identity primary key,
  category       text,
  body           text not null,
  reporter_email text,
  is_real_issue  boolean default false,
  severity       text,
  summary        text,
  triage_reason  text,
  image_count    int default 0,
  created_at     timestamptz not null default now()
);
create index if not exists feedback_created_idx on public.feedback (created_at desc);

-- ---- Billing events (Stripe webhook) ----------------------------------------
create table if not exists public.billing_events (
  id              bigint generated always as identity primary key,
  stripe_event_id text,
  type            text,
  verified        boolean default false,
  created_at      timestamptz not null default now()
);

-- ---- Lock everything to the service role ------------------------------------
alter table public.app_config       enable row level security;
alter table public.whatsapp_messages enable row level security;
alter table public.app_users        enable row level security;
alter table public.agent_tactics    enable row level security;
alter table public.vendors          enable row level security;
alter table public.bookings         enable row level security;
alter table public.feedback         enable row level security;
alter table public.billing_events   enable row level security;
alter table public.searches         enable row level security;
alter table public.offers           enable row level security;
alter table public.auth_events      enable row level security;
alter table public.ai_usage         enable row level security;
alter table public.agent_training   enable row level security;
alter table public.vendor_replies   enable row level security;
alter table public.bargain_drafts   enable row level security;
alter table public.wa_sessions      enable row level security;
-- No policies are created on purpose: the anon/public key gets zero access;
-- the server uses the service role key, which bypasses RLS.

-- ---- API usage log (cost tracker + per-user daily limits) --------------------
create table if not exists public.api_usage (
  id         bigint generated always as identity primary key,
  kind       text not null,
  count      int not null default 1,
  user_email text,
  created_at timestamptz not null default now()
);
create index if not exists api_usage_kind_idx on public.api_usage (kind, created_at desc);
create index if not exists api_usage_user_idx on public.api_usage (user_email, kind, created_at desc);
alter table public.api_usage enable row level security;

-- ---- Feedback screenshots (viewable in the management workspace) ------------
create table if not exists public.feedback_images (
  id          bigint generated always as identity primary key,
  feedback_id bigint,
  data_url    text not null,
  created_at  timestamptz not null default now()
);
create index if not exists feedback_images_fid_idx on public.feedback_images (feedback_id);
alter table public.feedback_images enable row level security;

-- ---- Market floor prices (owner + AI weekly research) ------------------------
-- Lowest realistic daily rental price per area + vehicle bucket. Keyed at the
-- AREA level ("koh samui, thailand") with a COUNTRY fallback row - never one
-- row per town. The bargaining agent anchors its single ask to these floors.
create table if not exists public.market_floor_prices (
  id              bigint generated always as identity primary key,
  region_key      text not null,
  vehicle_key     text not null,
  currency        text not null default 'USD',
  floor_per_day   numeric not null,
  typical_per_day numeric,
  source          text not null default 'ai', -- 'ai' | 'owner'
  updated_at      timestamptz not null default now(),
  unique (region_key, vehicle_key)
);
create index if not exists market_floor_region_idx
  on public.market_floor_prices (region_key, vehicle_key);
alter table public.market_floor_prices enable row level security;

-- ---- WhatsApp number reputation (Anti-Ban engine) -----------------------------
-- Dynamic Trust Score per connected sender. Replies build trust and relax the
-- hourly budget; pure outbound decays it. New numbers warm up on half budget.
create table if not exists public.whatsapp_number_reputation (
  id            bigint generated always as identity primary key,
  sender_key    text not null unique,   -- user email (one WA number per user)
  trust_score   int not null default 20,
  sent_total    int not null default 0,
  replies_total int not null default 0,
  last_send_at  timestamptz,
  created_at    timestamptz not null default now()
);
alter table public.whatsapp_number_reputation enable row level security;

-- ---- WhatsApp security policies (owner control panel) -------------------------
-- Every anti-ban knob lives here so the owner tunes the engine from the DB /
-- admin UI without a redeploy. Missing keys fall back to safe code defaults.
create table if not exists public.whatsapp_security_policies (
  id    bigint generated always as identity primary key,
  key   text not null unique,
  value text not null
);
alter table public.whatsapp_security_policies enable row level security;

-- ---- WhatsApp outbox (business-hours + pacing queue) --------------------------
-- Automated messages blocked by recipient night hours or pacing gaps park here
-- and are drained opportunistically by the webhook / status poll.
create table if not exists public.wa_outbox (
  id         bigint generated always as identity primary key,
  sender_key text not null,
  to_number  text not null,
  body       text not null,
  not_before timestamptz not null,
  meta       jsonb,
  created_at timestamptz not null default now()
);
create index if not exists wa_outbox_due_idx on public.wa_outbox (not_before asc);
-- The per-sender pending-count check in the outbound guard runs on every send.
create index if not exists wa_outbox_sender_idx on public.wa_outbox (sender_key);
alter table public.wa_outbox enable row level security;

-- ---- WA idle pause (session quiets down while the app is not in use) ----------
alter table public.wa_sessions add column if not exists last_active timestamptz;
alter table public.wa_sessions add column if not exists idle_paused boolean default false;

-- ---- Sponsored rental shops (owner-managed, paid placement) -------------------
-- Shops that pay to appear at the top of results with a glowing card and a
-- "Recommended" tag. Matched against Google results by phone digits or name.
create table if not exists public.sponsored_shops (
  id          bigint generated always as identity primary key,
  name        text not null,          -- shop name exactly as on Google Maps
  place_query text,                   -- optional "name, area" hint for matching
  phone       text,                   -- digits-only phone for exact matching
  active      boolean not null default true,
  notes       text,                   -- deal terms, contact, price paid...
  created_at  timestamptz not null default now()
);
alter table public.sponsored_shops enable row level security;

-- ---- Agent events (owner notifications: vague replies, funnel anomalies) ------
create table if not exists public.agent_events (
  id          bigint generated always as identity primary key,
  kind        text not null,           -- 'vague-reply' | 'funnel-gap' | ...
  vendor_id   text,
  vendor_name text,
  detail      text,
  handled     boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists agent_events_kind_idx on public.agent_events (kind, created_at desc);
alter table public.agent_events enable row level security;

-- ---- Anti-Ban v2: deeper reputation + risk signals ---------------------------
-- Extra columns tracked per connected number so the risk engine can score ban
-- likelihood from real behaviour (cold-contact volume, block/read rates, etc.).
alter table public.whatsapp_number_reputation add column if not exists blocks_total       int default 0;
alter table public.whatsapp_number_reputation add column if not exists fails_total        int default 0;
alter table public.whatsapp_number_reputation add column if not exists reads_total        int default 0;
alter table public.whatsapp_number_reputation add column if not exists delivered_total    int default 0;
alter table public.whatsapp_number_reputation add column if not exists new_contacts_today int default 0;
alter table public.whatsapp_number_reputation add column if not exists new_contacts_date  text;
alter table public.whatsapp_number_reputation add column if not exists last_reply_at      timestamptz;
alter table public.whatsapp_number_reputation add column if not exists paused_until       timestamptz;
alter table public.whatsapp_number_reputation add column if not exists risk_score         int default 0;

-- Per-recipient delivery state (read receipts + block detection) so the
-- engagement halt can require a blue tick OR a reply before any follow-up,
-- and so we can measure delivered-but-never-read (a strong bot signal).
create table if not exists public.wa_recipient_state (
  id            bigint generated always as identity primary key,
  sender_key    text not null,
  to_number     text not null,
  last_sent_at  timestamptz,
  last_read_at  timestamptz,
  last_reply_at timestamptz,
  delivered     boolean default false,
  read          boolean default false,
  blocked       boolean default false,
  unique (sender_key, to_number)
);
create index if not exists wa_recipient_state_idx on public.wa_recipient_state (sender_key, to_number);
alter table public.wa_recipient_state enable row level security;

-- ---- User cooldowns (free-tier pickup-bypass enforcement, etc.) ---------------
-- Temporary per-user blocks. Free users who try to arrange a next-day pickup
-- (bypassing the today-only limit) are blocked from sending for 6 hours.
create table if not exists public.user_cooldowns (
  email      text not null,
  kind       text not null,
  until      timestamptz not null,
  reason     text,
  created_at timestamptz not null default now(),
  primary key (email, kind)
);
alter table public.user_cooldowns enable row level security;

-- ---- Feedback workflow (owner triage: status + notes) ------------------------
alter table public.feedback add column if not exists status     text default 'open';
alter table public.feedback add column if not exists owner_note text;
alter table public.feedback add column if not exists resolved_at timestamptz;

-- ---- Shop intelligence (New#18): tag offers with area + vehicle bucket ---------
-- So we can aggregate real market data by area and vehicle type (lowest /
-- highest / typical price, rental duration, delivery signal) for the owner.
alter table public.offers add column if not exists region_key   text;
alter table public.offers add column if not exists vehicle_key  text;
alter table public.offers add column if not exists duration_days int;
alter table public.offers add column if not exists delivers      boolean;
create index if not exists offers_intel_idx on public.offers (region_key, vehicle_key);

-- ---- Honest local pricing + confirmed conditions (Wave 35) --------------------
-- vendor_replies carries the shop's OWN currency and any explicitly-confirmed
-- deposit / delivery terms, so the app never silently defaults to USD and can
-- show truthful tags ("Passport deposit", "Delivers") on the cards.
alter table public.vendor_replies add column if not exists currency text;
alter table public.vendor_replies add column if not exists deposit  text;
alter table public.vendor_replies add column if not exists delivers boolean;
alter table public.offers         add column if not exists deposit_note text;
alter table public.bookings add column if not exists currency text;

-- ---- Verified reply-based shop tags (item #13) --------------------------------
-- One row per (reply, tag) fact a shop explicitly stated. A tag is shown to
-- travellers only after >= 2 DISTINCT replies (reply_hash) confirmed it.
create table if not exists public.vendor_tag_signals (
  id         bigint generated always as identity primary key,
  vendor_id  text not null,
  tag        text not null,
  user_email text,
  reply_hash text,
  created_at timestamptz not null default now()
);
create index if not exists vendor_tag_signals_idx
  on public.vendor_tag_signals (vendor_id, tag);
alter table public.vendor_tag_signals enable row level security;

-- ---- Agent orchestrator traces (full decision visibility) ---------------------
-- One row per pipeline stage per decision: input -> reasoning -> output, plus
-- validator verdicts and strategist wait choices. Powers the owner's live
-- decisions viewer in Admin -> Agents.
create table if not exists public.agent_traces (
  id          bigint generated always as identity primary key,
  decision_id text not null,
  user_email  text,
  vendor_id   text,
  vendor_name text,
  stage       text not null,
  input       text,
  reasoning   text,
  output      text,
  verdict     text,
  created_at  timestamptz not null default now()
);
create index if not exists agent_traces_created_idx
  on public.agent_traces (created_at desc);
create index if not exists agent_traces_decision_idx
  on public.agent_traces (decision_id);
alter table public.agent_traces enable row level security;

-- ---- Inbound webhook dedupe claim (exactly-once processing) --------------------
-- One row per processed inbound WhatsApp message id. processVendorReply claims
-- a message by inserting here; the primary key makes the claim atomic so two
-- concurrent webhook deliveries can never both reply (or both bail).
create table if not exists public.wa_processed (
  wa_message_id text primary key,
  created_at    timestamptz not null default now()
);
alter table public.wa_processed enable row level security;

-- ---- Rental funnel build-out: richer booking + offer terms ---------------------
alter table public.bookings add column if not exists duration_days   int;
alter table public.bookings add column if not exists start_date      date;
alter table public.bookings add column if not exists return_date     date;
alter table public.bookings add column if not exists delivery_address text;
alter table public.bookings add column if not exists one_way_dropoff text;
alter table public.bookings add column if not exists driver_age      int;
alter table public.bookings add column if not exists scheduled_tz    text;
alter table public.offers   add column if not exists delivery_fee     numeric;
alter table public.offers   add column if not exists insurance_included boolean;
alter table public.offers   add column if not exists km_limit_per_day text;
alter table public.offers   add column if not exists fuel_policy      text;
alter table public.offers   add column if not exists effective_daily_rate numeric;
alter table public.vendor_replies add column if not exists insurance_included boolean;
alter table public.vendor_replies add column if not exists delivery_fee        numeric;

-- Structured deposit (from lib/deposit.ts): the KIND the shop wants held plus a
-- cash figure + its currency, so the app shows a precise deposit tag next to the
-- price ("Passport", "THB 3,000 cash") and can filter by deposit kind.
alter table public.offers         add column if not exists deposit_type     text;
alter table public.offers         add column if not exists deposit_amount   numeric;
alter table public.offers         add column if not exists deposit_currency text;
alter table public.vendor_replies add column if not exists deposit_type     text;
alter table public.vendor_replies add column if not exists deposit_amount   numeric;
alter table public.vendor_replies add column if not exists deposit_currency text;

-- Market floors gained a 'web' source (live web research) alongside 'ai'/'owner'.
-- (source is already a free-text column; no migration needed - noted for clarity.)

-- ---- Web Push subscriptions (shop-reply alerts, all plans) --------------------
-- One row per browser/device a user opted in from. The reply webhook sends a
-- push to every row for that user so alerts arrive even when the app is closed.
create table if not exists public.push_subscriptions (
  id         bigint generated always as identity primary key,
  user_email text not null,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);
create index if not exists push_subs_user_idx on public.push_subscriptions (user_email);
alter table public.push_subscriptions enable row level security;

-- ================================================================================
-- DIGRAPH NEGOTIATION ENGINE (graph orchestration v2)
-- ================================================================================

-- ---- Per-thread durable negotiation state (the engine's checkpoint) -----------
-- One row per user<->shop WhatsApp thread. The graph engine loads it on every
-- event, mutates phase/fields/node_runs, and writes it back with an optimistic
-- version check - serverless-safe resume between webhook invocations.
create table if not exists public.negotiation_threads (
  thread_key       text primary key,            -- user_email:to_digits
  user_email       text not null,
  vendor_id        text,
  vendor_name      text,
  to_number        text not null,
  phase            text not null default 'opening',
  version          int  not null default 0,
  fields           jsonb not null default '{}'::jsonb,
  node_runs        jsonb not null default '{}'::jsonb,
  waiting_until    timestamptz,
  last_decision_id text,
  updated_at       timestamptz not null default now()
);
create index if not exists negotiation_threads_user_idx
  on public.negotiation_threads (user_email, updated_at desc);
alter table public.negotiation_threads enable row level security;

-- ---- Deferred-decision wakeups (strategic waits + judge jobs) ------------------
-- The engine parks a "decide again later" marker here; every opportunistic
-- drain site (webhook, wa/status poll, replies poll, queue, ping) claims due
-- rows atomically (delete-returning) and re-runs the graph with FRESH context,
-- so a rival offer that arrived during the wait changes the leverage math.
create table if not exists public.graph_wakeups (
  id         bigint generated always as identity primary key,
  kind       text not null default 'tick',      -- 'tick' | 'judge' | 'session-judge'
  thread_key text not null,
  not_before timestamptz not null,
  payload    jsonb,
  created_at timestamptz not null default now()
);
create index if not exists graph_wakeups_due_idx on public.graph_wakeups (not_before asc);
alter table public.graph_wakeups enable row level security;

-- ---- Judge team scores ----------------------------------------------------------
-- Move judges grade every automated outbound (tactic fit / tone / uniqueness,
-- 1-5 each); the chief judge aggregates per thread with the hard outcome math
-- (discount %, floor gap, deal complete). Feeds tactic learning + the Studio.
create table if not exists public.agent_scores (
  id             bigint generated always as identity primary key,
  decision_id    text,
  thread_key     text,
  node_id        text,
  scorer         text not null,                 -- 'move-judge' | 'chief-judge' | 'deterministic'
  rubric_version text not null default 'v1',
  scores         jsonb not null,                -- {tacticFit,tone,uniqueness,outcomeDelta}
  tactic_id      text,
  provider       text,                          -- which LLM judged (family-bias audit)
  verdict        text,                          -- one-line justification
  created_at     timestamptz not null default now()
);
create index if not exists agent_scores_thread_idx
  on public.agent_scores (thread_key, created_at desc);
create index if not exists agent_scores_decision_idx
  on public.agent_scores (decision_id);
alter table public.agent_scores enable row level security;

-- ---- Trace path stamps: which graph node/edge produced each trace row ----------
alter table public.agent_traces add column if not exists node_id text;
alter table public.agent_traces add column if not exists edge_id text;

-- ---- Deal completeness gating on offers ----------------------------------------
-- An offer is PRESENTED to the traveller only once price + deposit + how to
-- get the vehicle (pickup/delivery/on-shop) are known (or probing timed out).
alter table public.offers add column if not exists presentable boolean default false;
alter table public.offers add column if not exists fulfillment text;   -- pickup|delivery|on-shop

-- ---- Terms acceptance (legal shield) --------------------------------------------
alter table public.app_users add column if not exists terms_version text;
alter table public.app_users add column if not exists terms_accepted_at timestamptz;
alter table public.app_users add column if not exists wa_risk_accepted_at timestamptz;
alter table public.app_users add column if not exists ai_responsibility_accepted_at timestamptz;

-- ================================================================================
-- AI OPERATIONS CENTER - owner review console + learning loop
-- ================================================================================

-- ---- Owner reviews of agent decisions -------------------------------------------
-- One row per reviewed decision (decision_id null = a thread-level review, e.g.
-- an auto-flag from the weak-conversation detector). Powers the Ops inbox,
-- the exemplar channel, edge priors and judge calibration.
create table if not exists public.agent_reviews (
  id              bigint generated always as identity primary key,
  decision_id     text,                           -- null = thread-level review
  thread_key      text not null,
  user_email      text,
  vendor_id       text,
  vendor_name     text,
  node_id         text,                           -- denormalized from the trace
  edge_id         text,                           -- chosen edge (priors/heatmap)
  rating          int,                            -- 1..5
  verdict         text,                           -- 'approve' | 'reject'
  branch_correct  boolean,
  outcome_impact  text,                           -- 'improved'|'worsened'|'neutral'
  better_response text,                           -- what SHOULD have been sent
  feedback        text,
  tags            text[] not null default '{}',   -- failure-pattern labels
  bookmark        boolean not null default false, -- exemplar negotiation
  status          text not null default 'open',   -- open|flagged|auto_flagged|resolved
  source          text not null default 'owner',  -- 'owner' | 'auto'
  auto_reason     text,                           -- detector explanation
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists agent_reviews_decision_idx
  on public.agent_reviews (decision_id);
create index if not exists agent_reviews_thread_idx
  on public.agent_reviews (thread_key, created_at desc);
create index if not exists agent_reviews_status_idx
  on public.agent_reviews (status, created_at desc);
alter table public.agent_reviews enable row level security;

-- ---- Versioned behavior changes (audit trail + one-click rollback) ---------------
-- Every graph-spec or policy-overlay write lands here as a full snapshot; the
-- active row is what production runs, and rollback re-activates an old row.
create table if not exists public.policy_versions (
  id           bigint generated always as identity primary key,
  kind         text not null,          -- 'graph_spec' | 'policy_overlay'
  version      int  not null,          -- monotonic per kind
  spec         jsonb not null,         -- full snapshot
  note         text,                   -- why (audit trail)
  author       text,
  replay_score jsonb,                  -- golden replay report at activation
  active       boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists policy_versions_kind_idx
  on public.policy_versions (kind, version desc);
alter table public.policy_versions enable row level security;

-- ---- Golden replay cases ----------------------------------------------------------
-- Deterministic regression suite snapshotted from REAL conversations: frozen
-- extraction stubs + floor make each case bit-stable, so spec/policy changes
-- can be gated on "every golden case still passes".
create table if not exists public.agent_golden_cases (
  id         bigint generated always as identity primary key,
  name       text not null,
  thread_key text,                     -- provenance (real conversation source)
  rfq        jsonb not null,
  region     text,
  floor      jsonb,                    -- frozen {floor, typical, currency}
  turns      jsonb not null,           -- [{shopSays, stubExtraction, rival...}]
  expects    jsonb not null,           -- [{action?, edgeId?, pathContains?...}]
  enabled    boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.agent_golden_cases enable row level security;

-- ---- Latency + attribution stamps on decisions ------------------------------------
alter table public.agent_traces add column if not exists ms int;
alter table public.agent_traces add column if not exists spec_rev int;
alter table public.agent_scores add column if not exists spec_rev int;

-- ---- Cancellation tombstones (absolute queue deletion) ----------------------------
-- When a user removes queued messages for a shop (or clears/closes a search
-- session), a tombstone is written here. guardOutbound refuses AUTOMATED sends
-- to a tombstoned recipient - across the outbox drain, wakeup re-compositions
-- and retries - until the user explicitly re-initiates contact (which deletes
-- the tombstone). This is what makes "remove" permanent on serverless.
create table if not exists public.wa_cancellations (
  id         bigint generated always as identity primary key,
  sender_key text not null,
  to_number  text not null,
  reason     text,                     -- 'user-removed' | 'session-closed' | 'deal-closed'
  created_at timestamptz not null default now(),
  unique (sender_key, to_number)
);
create index if not exists wa_cancellations_sender_idx
  on public.wa_cancellations (sender_key);
alter table public.wa_cancellations enable row level security;

-- Exact-match owner scoping for wakeup purges (replaces fragile LIKE patterns
-- where '_' in an email is itself a wildcard).
alter table public.graph_wakeups add column if not exists user_email text;
create index if not exists graph_wakeups_user_idx
  on public.graph_wakeups (user_email);

-- ---- Send-slot claims (lock-free concurrency control for sends) -------------------
-- Vercel serverless has no locks: 5+ concurrent drain callers each read the
-- same pacing state and could all pass the min-gap/caps together. A claim row
-- with a PRIMARY KEY makes the decision atomic: the invocation whose INSERT
-- succeeds owns the slot; a 409 conflict means another invocation won.
-- Slot kinds: "gap:<bucket>" (one send per min-gap window per sender) and
-- "msg:<digits>:<hash>" (idempotency - one delivery per unique message).
-- Rows are garbage-collected after 24h by the outbox drain.
create table if not exists public.wa_send_claims (
  sender_key text not null,
  slot_key   text not null,
  created_at timestamptz not null default now(),
  primary key (sender_key, slot_key)
);
alter table public.wa_send_claims enable row level security;

-- Exact ownership scoping for the risk feed (replaces a LIKE substring
-- filter on detail that could match across users).
alter table public.agent_events add column if not exists user_email text;
create index if not exists agent_events_user_idx
  on public.agent_events (user_email, kind, created_at desc);
