# The $0 Evolution fleet

One `docker-compose.yml`, brought up once per host. Each host is a
self-contained lane: Evolution + its own Postgres + its own Redis. Nothing is
shared between hosts, because none of the free managed databases survive an
always-on Evolution (the reasoning is written out at the top of the compose
file).

## Why more than one host at all

Three separate reasons, and only the first is about capacity.

1. **Capacity.** Render `starter` is 512 MB - below Evolution's own stated
   production floor of 2 vCPU / 2 GB - and `render.yaml` itself says that holds
   roughly 30-50 live sockets. `maxPerHost` is 25 and now genuinely REFUSES at
   the cap rather than overfilling, so one host means a beta capped at 25
   linked numbers.
2. **Geography.** IP-vs-number geo mismatch is a separately scored WhatsApp
   signal. Our whole fleet was one box in Oregon carrying numbers whose shops
   are in south-east Asia.
3. **Blast radius.** One burned IP range must not take the whole beta down.
   Four hosts on four providers is four ASNs.

Migrating off Render also **saves $13/mo** ($7 web + $6 Postgres).

## The lanes

| Lane | Host | Cost | Notes |
|---|---|---|---|
| A | Oracle Cloud Always Free | $0 forever | 2 OCPU / 12 GB ARM, 200 GB. **The home region is permanent** - create this account LAST, once the majority tester country is known. |
| B | Azure free tier | $0 for 12 months | B1s / B2pts v2, 750 h/mo. Many regions including SE Asia; covers the whole beta window. |
| C | Northflank Sandbox | $0 | 2 services, 1 vCPU / 1 GB, no sleep. Docker-native. 1 GB is one small lane. |
| D | Render (existing) | $13/mo | Keep only until A and B are proven, then retire it. |

Fly.io's free tier is dead (2024) and Koyeb closed theirs to new users in early
2026 - both are listed here so nobody re-researches them.

## Standing one up

1. Create the VM in the region that matches its numbers. Open only 443 to the
   internet.
2. `git clone` this repo (or copy `deploy/fleet/`), then:
   ```
   cd deploy/fleet
   printf 'AUTHENTICATION_API_KEY=%s\nPOSTGRES_PASSWORD=%s\n' \
     "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env
   docker compose up -d
   ```
   A **unique key per host**, so one leak burns one cohort, not the fleet.
3. Put HTTPS in front of it. Cloudflare Tunnel is free and unmetered (since
   Jul 2026) and needs no inbound port at all:
   `cloudflared tunnel --url http://127.0.0.1:8080`. Caddy with a real DNS name
   works equally well.
4. Add the line to **Admin -> Keys -> EVOLUTION_HOSTS**, with its region:
   ```
   https://sg.example.com|<the key from .env>|66,84,855,856,60,65
   ```
   The third field is a comma-separated list of **calling-code prefixes**. Omit
   it for a region-neutral host. See `src/lib/wa/host-region.ts`.
5. Watch **Admin -> Keys -> host occupancy**. New links now prefer a host that
   claims their number's country; a placement that could not get one leaves a
   `host-geo-mismatch` entry on the message trail, so a fleet that is out of
   capacity in the right region says so instead of looking uniformly green.

`.env` is gitignored by the repo root rule. Never commit a key.

## Monitoring (also $0)

- **UptimeRobot** free: 50 monitors, 5-minute checks - one per Evolution host
  plus the app itself.
- **Healthchecks.io** free: a dead-man's switch on the queue-drain cron. This is
  the gap `deploy/ping/ping.mjs` cannot close by itself - its exit-1 alarm only
  fires if the cron still RUNS. If the cron service is deleted or dies, nothing
  tells anyone. Only a dead-man's switch catches a drain that stopped existing.
