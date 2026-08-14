-- WheelDeal - security hardening (owner report 5, Wave 0). Run ONCE in the
-- Supabase SQL editor. Idempotent and safe to re-run.
--
-- WHY THIS EXISTS. `prune_old_rows` (supabase/retention.sql) is a
-- SECURITY DEFINER function: it runs with the privileges of its OWNER (the
-- table owner), NOT of the caller. PostgreSQL grants EXECUTE on new functions
-- to PUBLIC by default, and Supabase exposes every function in the `public`
-- schema over PostgREST RPC (`/rest/v1/rpc/<name>`) to the anon and
-- authenticated roles. The net effect: ANYONE holding the publishable anon key
-- (it ships to every browser) could call
--   POST /rest/v1/rpc/prune_old_rows  { "retain_days": 0 }
-- and delete operational history as the definer, straight past every RLS grant
-- the schema relies on. `retain_days => 0` would wipe agent_events,
-- agent_traces and the un-priced whatsapp_messages immediately.
--
-- The function is meant to be called by pg_cron (which runs as a superuser) and
-- by the owner from the SQL editor - never from the Data API. So we revoke the
-- default PUBLIC/anon/authenticated grant and hand EXECUTE to service_role
-- only (the server-side key, never shipped to a browser). pg_cron is unaffected
-- because it does not go through PostgREST role checks.

revoke all on function public.prune_old_rows(int) from public;
revoke all on function public.prune_old_rows(int) from anon;
revoke all on function public.prune_old_rows(int) from authenticated;
grant execute on function public.prune_old_rows(int) to service_role;

do $$
begin
  raise notice 'prune_old_rows is now service_role-only. The anon/authenticated Data API can no longer call it.';
end;
$$;
