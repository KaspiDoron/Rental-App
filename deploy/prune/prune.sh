#!/bin/sh
# Evolution-Postgres retention (owner report 6, J4).
#
# The Baileys store keeps every Message/MessageUpdate row forever, and the
# recovery sweep only ever reads a 10-row tail per chat - so on the
# basic-256mb plan the database fills unbounded with rows nothing will read
# again. This prunes rows older than PRUNE_DAYS (default 30), defensively:
# every statement is IF-EXISTS-guarded and the job exits 0 on a missing
# table, so an Evolution upgrade that renames things degrades to a no-op
# with a log line rather than a red cron.
#
# Env (set on the cron service, never committed):
#   EVO_DATABASE_URL = the wd-evo-db connection string (Render: fromDatabase)
#   PRUNE_DAYS       = optional, default 30
set -eu
DAYS="${PRUNE_DAYS:-30}"
if [ -z "${EVO_DATABASE_URL:-}" ]; then
  echo "prune misconfigured: EVO_DATABASE_URL missing"
  exit 1
fi
psql "$EVO_DATABASE_URL" -v ON_ERROR_STOP=0 <<SQL
do \$\$
begin
  if to_regclass('public."Message"') is not null then
    -- messageTimestamp is epoch seconds in Evolution's Prisma schema.
    delete from public."Message"
     where "messageTimestamp" < extract(epoch from now() - interval '${DAYS} days')::bigint;
    raise notice 'Message pruned';
  else
    raise notice 'Message table not found - skipped';
  end if;
  if to_regclass('public."MessageUpdate"') is not null
     and to_regclass('public."Message"') is not null then
    delete from public."MessageUpdate" mu
     where not exists (select 1 from public."Message" m where m.id = mu."messageId");
    raise notice 'MessageUpdate pruned';
  end if;
end
\$\$;
SQL
echo "prune done ($DAYS days) $(date -u +%FT%TZ)"
