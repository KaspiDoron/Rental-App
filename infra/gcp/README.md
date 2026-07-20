# WheelDeal on GCE — deploy runbook

The VM runs **redis + gateway + workers** only (~450MB on a free-tier
`e2-micro`). The Next.js frontend stays on **Vercel**; the DB + storage stay on
**Supabase**. There is no `web` container and nothing DB-shaped on the VM.

Public path: `https://<APP_DOMAIN>/api/webhooks/evolution` → nginx :443 →
gateway :8080 → BullMQ/Redis → workers → the negotiation engine.

## What runs where

| Piece | Host | Notes |
|---|---|---|
| Gateway (webhook ingress, <200ms ack, SSE) | GCE VM :8080 behind nginx | `apps/gateway` via `tsx` |
| Workers (5 BullMQ consumers) | GCE VM | `services/workers` via `tsx` |
| Redis (queues + hot state) | GCE VM container | `maxmemory 160mb`, AOF, `no-appendfsync-on-rewrite yes` |
| Frontend | Vercel | unchanged |
| Postgres + Storage | Supabase | pooled (Supavisor, port 6543) for the `pg` path |

## One-time owner prerequisites

1. **Enable APIs / billing** on the GCP project (`compute`, `secretmanager`).
2. **Create the env secret** — the payload is the literal `infra/docker/.env`:
   ```bash
   cat > /tmp/wd.env <<'ENV'
   SUPABASE_URL=https://<ref>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<service-role>
   SUPABASE_DB_URL=postgres://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:6543/postgres
   SESSION_SECRET=<MUST EQUAL the Vercel value>
   ADMIN_EMAILS=owner@example.com
   EVOLUTION_API_URL=http://<evolution-host>:8080
   EVOLUTION_API_KEY=<evolution-key>
   APP_DOMAIN=https://<vercel-frontend-domain>
   ENV
   gcloud secrets create wheeldeal-env --data-file=/tmp/wd.env && rm /tmp/wd.env
   ```
   > `SESSION_SECRET` **must** match the Vercel deployment — the webhook token is
   > `sha256("wd-webhook:"+SESSION_SECRET).slice(0,32)` and it also derives the
   > `app_config` AES key. A mismatch = every webhook 403s and pasted keys can't
   > decrypt.
3. **(Private repo)** create a GitHub token secret for the clone:
   `gcloud secrets create wheeldeal-gh-token --data-file=<(printf %s "<token>")`.

## Provision

```bash
PROJECT=<proj> REGION=us-central1 ZONE=us-central1-a \
APP_DOMAIN=api.example.com OWNER_EMAIL=you@example.com \
ENV_SECRET=wheeldeal-env REPO_SECRET=wheeldeal-gh-token \
./infra/gcp/deploy.sh
```

This creates a **static IP**, the **VM** (with `startup.sh` as metadata), and the
**80/443 firewall**. The startup script installs Docker, adds swap, pulls the
`.env` from Secret Manager, clones the branch, `docker compose up -d --build`,
and installs nginx (HTTP). Watch it: `sudo tail -f /var/log/wd-startup.log` (via
the GCP console SSH).

## SSL (after DNS)

certbot's HTTP-01 challenge needs the domain resolving to the VM **first**:

1. Point `APP_DOMAIN`'s **A-record → the static IP** the script printed.
2. Once it resolves, SSH via the GCP console and:
   ```bash
   sudo certbot --nginx -d <APP_DOMAIN> --non-interactive --agree-tos -m <owner-email> --redirect
   ```
   certbot rewrites `nginx.conf` to add the :443 server + the :80→:443 redirect.

## Cut over

Set the **Evolution dashboard webhook URL** to
`https://<APP_DOMAIN>/api/webhooks/evolution?token=<webhook-token>`. The gateway
accepts `/api/webhooks/evolution` and `/webhooks/evolution` — same shape as the
legacy Next route, so this is only a URL change.

## Verify

```bash
curl http://<STATIC_IP>:8080/healthz          # pre-DNS: {"ok":true,"redis":true}
curl https://<APP_DOMAIN>/healthz             # post-certbot
# a wrong token must 403:
curl -s -o /dev/null -w '%{http_code}\n' "https://<APP_DOMAIN>/api/webhooks/evolution?token=nope"
# on the VM:
cd /opt/wheeldeal/infra/docker && sudo docker compose ps   # redis+gateway+workers healthy
```

## Operate

- Logs: `sudo docker compose logs -f gateway workers` in `/opt/wheeldeal/infra/docker`.
- Redeploy a new branch commit: re-run the clone + `docker compose up -d --build`
  (or `sudo bash /opt/wheeldeal/infra/gcp/startup.sh`).
- Redis is AOF-persisted on the data volume; the DLQ + queue depth are the
  health signals (the scheduler logs a `dlq-sweep` line every 15m).
