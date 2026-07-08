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
