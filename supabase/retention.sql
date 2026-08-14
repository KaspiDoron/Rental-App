-- WheelDeal - data retention (owner report 4, scale #4). Run ONCE in the
-- Supabase SQL editor. Idempotent: safe to re-run, and safe to run before
-- pg_cron is enabled (the schedule block degrades to a no-op with a NOTICE).
--
-- WHY THIS EXISTS. Four tables grow without bound on the live path and were the
-- top row-growth risk at launch scale:
--   - whatsapp_messages : every inbound/outbound frame (the biggest by far)
--   - agent_events      : holds, drops, latency, read/presence receipts, ...
--   - agent_traces      : per-decision reasoning rows (several per turn)
--   - api_usage         : one row per provider call, for the cost tracker
-- At hundreds of users these accumulate millions of rows a month, which slows
-- every hot-path query that scans by created_at and inflates the DB bill.
--
-- WHAT IS KEPT. 90 days of operational history is plenty for the Ops center,
-- the message-path tracer and incident forensics. Two things are NEVER pruned:
--   - PRICED whatsapp_messages rows (raw->>'reading' present, or a stamped
--     offer): a board photographed once is cross-thread leverage for the whole
--     search session, and the golden suite freezes real conversations.
--   - api_usage is ROLLED UP to a daily total per (kind, day) before its raw
--     rows are pruned, so the cost tracker keeps its history at 1/1000th the
--     rows.
--
-- Everything here is bounded and re-entrant; it removes only rows older than
-- the window, and only from these four tables.

-- ---------------------------------------------------------------------------
-- 1. Monthly rollup target for api_usage (keeps cost history, drops the rows).
-- ---------------------------------------------------------------------------
create table if not exists public.api_usage_daily (
  day        date not null,
  kind       text not null,
  total      bigint not null default 0,
  primary key (day, kind)
);
alter table public.api_usage_daily enable row level security;

-- ---------------------------------------------------------------------------
-- 2. The prune function. One transaction, bounded, idempotent.
-- ---------------------------------------------------------------------------
create or replace function public.prune_old_rows(retain_days int default 90)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  cutoff timestamptz := now() - make_interval(days => retain_days);
  msgs   bigint := 0;
  events bigint := 0;
  traces bigint := 0;
  usage_rows bigint := 0;
begin
  -- api_usage: roll up to the daily table FIRST, then prune the raw rows.
  insert into public.api_usage_daily (day, kind, total)
  select date_trunc('day', created_at)::date as day, kind, sum(count)::bigint
    from public.api_usage
   where created_at < cutoff
   group by 1, 2
  on conflict (day, kind) do update set total = public.api_usage_daily.total + excluded.total;

  delete from public.api_usage where created_at < cutoff;
  get diagnostics usage_rows = row_count;

  -- whatsapp_messages: keep priced/read rows forever (leverage + golden cases).
  delete from public.whatsapp_messages
   where received_at < cutoff
     and (raw ->> 'reading') is null
     and (raw ->> 'englishGloss') is null
     and coalesce((raw ->> 'ok')::text, '') <> 'priced';
  get diagnostics msgs = row_count;

  delete from public.agent_events where created_at < cutoff;
  get diagnostics events = row_count;

  delete from public.agent_traces where created_at < cutoff;
  get diagnostics traces = row_count;

  return jsonb_build_object(
    'cutoff', cutoff,
    'whatsapp_messages_deleted', msgs,
    'agent_events_deleted', events,
    'agent_traces_deleted', traces,
    'api_usage_rolled_and_deleted', usage_rows
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Schedule it nightly via pg_cron when available; a clean NOTICE otherwise.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    -- Unschedule a prior copy so a re-run does not stack duplicate jobs.
    perform cron.unschedule(jobid)
      from cron.job where jobname = 'wheeldeal-prune-nightly';
    perform cron.schedule(
      'wheeldeal-prune-nightly',
      '17 3 * * *',                        -- 03:17 UTC daily, off the hour
      $cron$ select public.prune_old_rows(90); $cron$
    );
    raise notice 'Scheduled wheeldeal-prune-nightly (03:17 UTC).';
  else
    raise notice 'pg_cron not installed - enable it (Supabase: Database -> Extensions) then re-run this file, OR call select public.prune_old_rows(90); on your own schedule.';
  end if;
end;
$$;
