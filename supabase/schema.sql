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
  updated_at    timestamptz not null default now()
);
create index if not exists wa_sessions_instance_idx
  on public.wa_sessions (instance_name);

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
