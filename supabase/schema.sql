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

-- ---- App users (access control) ---------------------------------------------
create table if not exists public.app_users (
  email      text primary key,
  status     text not null default 'active' check (status in ('active','blocked')),
  added_at   timestamptz not null default now(),
  last_seen  timestamptz not null default now()
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

-- ---- Bookings ---------------------------------------------------------------
create table if not exists public.bookings (
  id           bigint generated always as identity primary key,
  user_email   text,
  vendor_id    text,
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
-- No policies are created on purpose: the anon/public key gets zero access;
-- the server uses the service role key, which bypasses RLS.
