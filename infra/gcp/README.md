# WheelDeal on GCE — 5-minute deploy runbook

The VM runs **redis + gateway + workers** only (~450MB on a free-tier
`e2-micro`). The Next.js frontend runs as a separate **Cloud Run** service
(built from the root `Dockerfile`); the DB + storage stay on **Supabase**. There
is no `web` container and nothing DB-shaped on the VM.

**Zero-DNS routing:** the gateway is served at **`<static-ip>.sslip.io`**.
sslip.io is a public wildcard resolver (`A.B.C.D.sslip.io → A.B.C.D`), so the
domain points at the VM the instant it boots — which means **certbot issues TLS
automatically during startup, with no A-record and no waiting**. One command in,
a working `https://…` webhook endpoint out.

Public path: `https://<ip>.sslip.io/api/webhooks/evolution` → nginx :443 →
gateway :8080 → BullMQ/Redis → workers → the negotiation engine.

## What runs where

| Piece | Host | Notes |
|---|---|---|
| Gateway (webhook ingress, <200ms ack, SSE) | GCE VM :8080 behind nginx | `apps/gateway` via `tsx` |
| Workers (5 BullMQ consumers) | GCE VM | `services/workers` via `tsx` |
| Redis (queues + hot state) | GCE VM container | `maxmemory 160mb`, AOF, `no-appendfsync-on-rewrite yes` |
| Frontend | Cloud Run (root `Dockerfile`) | Next.js standalone image |
| Postgres + Storage | Supabase | pooled (Supavisor, port 6543) for the `pg` path |

## Step 1 — create the secrets (Cloud Shell)

The env secret's payload **is** the literal `infra/docker/.env`. Copy this block,
swap the `REPLACE_…` placeholders for your real values, and create the secret:

```bash
cat > wd.env <<'ENV'
# --- Supabase (external managed DB + storage) --------------------------------
SUPABASE_URL=https://REPLACE_REF.supabase.co
SUPABASE_SERVICE_ROLE_KEY=REPLACE_SERVICE_ROLE_KEY
# Pooled connection (Supavisor, TRANSACTION mode, port 6543) - NOT the direct 5432:
SUPABASE_DB_URL=postgresql://postgres.REPLACE_REF:REPLACE_DB_PASSWORD@aws-0-REPLACE_REGION.pooler.supabase.com:6543/postgres
NEXT_PUBLIC_SUPABASE_ANON_KEY=REPLACE_ANON_KEY

# --- Sessions / admin --------------------------------------------------------
# MUST be byte-identical to the SESSION_SECRET on your Cloud Run web service, or
# every webhook 403s and admin-pasted keys can't decrypt (openssl rand -hex 32).
SESSION_SECRET=REPLACE_WITH_EXACT_WEB_SESSION_SECRET
ADMIN_EMAILS=REPLACE_owner@example.com

# --- Evolution (WhatsApp bridge) - single-host form --------------------------
EVOLUTION_API_URL=http://REPLACE_EVOLUTION_HOST:8080
EVOLUTION_API_KEY=REPLACE_EVOLUTION_API_KEY

# --- Public identity ---------------------------------------------------------
# The Cloud Run FRONTEND origin (drives the gateway's SSE CORS allow-origin).
# This is SEPARATE from the gateway's own <ip>.sslip.io domain.
APP_DOMAIN=https://REPLACE_your-frontend.run.app

# --- Optional tuning ---------------------------------------------------------
LOG_LEVEL=info
PG_POOL_MAX=5
ENV

gcloud secrets create wheeldeal-env --data-file=wd.env && rm wd.env
```

> Provider keys (Groq/Gemini/OpenRouter/Cerebras, Maps, Resend, PayPal) are
> **not** required here — their canonical store is the admin Key Vault (Supabase
> `app_config`). You may mirror them into `wd.env` if you want, but it's optional.

**Private repo** (this one is): also create a GitHub token secret for the clone
(a fine-grained token with read-only Contents on the repo):

```bash
printf %s "REPLACE_GITHUB_TOKEN" | gcloud secrets create wheeldeal-gh-token --data-file=-
```

To rotate any secret later: `gcloud secrets versions add <name> --data-file=<file>`.

## Step 2 — provision (one command)

```bash
git clone -b claude/rental-negotiation-app-pc33ux https://github.com/KaspiDoron/Rental-App.git
cd Rental-App

PROJECT=<your-project-id> OWNER_EMAIL=you@example.com \
ENV_SECRET=wheeldeal-env REPO_SECRET=wheeldeal-gh-token \
./infra/gcp/deploy.sh
```

`deploy.sh` allocates a static IP, computes `API_DOMAIN=<ip>.sslip.io`, grants
the VM's service account read access to the secrets, opens 80/443, and creates
the `e2-micro` VM with `startup.sh` as metadata. The VM then self-bootstraps
(Docker + swap → pull `.env` → clone → `docker compose up --build` → nginx →
**certbot auto-issues TLS**). Watch it:

```bash
gcloud compute ssh wheeldeal-vm --zone us-central1-a \
  --command 'sudo tail -n 40 -f /var/log/wd-startup.log'
```

## Step 3 — cut over + verify (~after 3-5 min)

Set the **Evolution dashboard webhook URL** to (the script prints the exact
domain):

```
https://<ip>.sslip.io/api/webhooks/evolution?token=<webhook-token>
```

The token is `sha256("wd-webhook:"+SESSION_SECRET)` truncated to the first 32
hex chars. Verify:

```bash
curl https://<ip>.sslip.io/readyz                          # {"ok":true,"redis":true}
curl -s -o /dev/null -w '%{http_code}\n' \
     "https://<ip>.sslip.io/api/webhooks/evolution?token=nope"   # 403
# on the VM:
gcloud compute ssh wheeldeal-vm --zone us-central1-a \
  --command 'cd /opt/wheeldeal/infra/docker && sudo docker compose ps'   # redis+gateway+workers healthy
```

## Using your own domain instead of sslip.io

Pass `API_DOMAIN=api.yourdomain.com` to `deploy.sh`. Then it is NOT zero-DNS:
point that host's **A-record → the printed static IP first**; certbot in the
startup script will fail the first time (logged, non-fatal — HTTP still serves),
so once DNS resolves, re-issue on the VM:

```bash
sudo certbot --nginx -d api.yourdomain.com --non-interactive --agree-tos -m you@example.com --redirect
```

## Operate

- Logs: `sudo docker compose logs -f gateway workers` in `/opt/wheeldeal/infra/docker`.
- Redeploy a new commit: re-run `sudo bash /opt/wheeldeal/infra/gcp/startup.sh`.
- Redis is AOF-persisted on the data volume; the scheduler logs a `dlq-sweep`
  line every 15m and a `gc` health line every 30m — the queue-depth signals.
