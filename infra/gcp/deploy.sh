#!/usr/bin/env bash
# WheelDeal one-shot GCE provisioning. Creates a static IP, an e2-micro VM
# (free-tier) running the startup script, and firewall rules for 80/443. Run
# from a machine with gcloud authed to the target project.
#
# Usage:
#   PROJECT=my-proj REGION=us-central1 ZONE=us-central1-a \
#   APP_DOMAIN=api.example.com OWNER_EMAIL=you@example.com \
#   REPO=KaspiDoron/Rental-App BRANCH=claude/rental-negotiation-app-pc33ux \
#   ENV_SECRET=wheeldeal-env REPO_SECRET=wheeldeal-gh-token \
#   ./infra/gcp/deploy.sh
#
# Prereqs the owner does ONCE (see README.md): create the Secret Manager
# secrets (the .env payload + optional GitHub token), enable compute + secret
# manager APIs, and (after this runs) point APP_DOMAIN's A-record at the printed
# static IP, then certbot.
set -euo pipefail

: "${PROJECT:?set PROJECT}"; : "${APP_DOMAIN:?set APP_DOMAIN}"
REGION="${REGION:-us-central1}"; ZONE="${ZONE:-us-central1-a}"
NAME="${NAME:-wheeldeal-vm}"; IP_NAME="${IP_NAME:-wheeldeal-ip}"
REPO="${REPO:-KaspiDoron/Rental-App}"
BRANCH="${BRANCH:-claude/rental-negotiation-app-pc33ux}"
ENV_SECRET="${ENV_SECRET:-wheeldeal-env}"; REPO_SECRET="${REPO_SECRET:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"

gcloud config set project "$PROJECT"
gcloud services enable compute.googleapis.com secretmanager.googleapis.com

# Static external IP (so DNS never has to change again).
gcloud compute addresses create "$IP_NAME" --region "$REGION" 2>/dev/null || true
IP="$(gcloud compute addresses describe "$IP_NAME" --region "$REGION" --format='value(address)')"

# Firewall: 80/443 to the tagged VM (8080 stays internal, behind nginx).
gcloud compute firewall-rules create wheeldeal-web \
  --allow tcp:80,tcp:443 --target-tags wheeldeal --direction INGRESS 2>/dev/null || true

# The VM: e2-micro free-tier, Debian 12, our startup script + metadata.
gcloud compute instances create "$NAME" \
  --zone "$ZONE" --machine-type e2-micro \
  --image-family debian-12 --image-project debian-cloud \
  --boot-disk-size 30GB --boot-disk-type pd-standard \
  --tags wheeldeal,http-server,https-server \
  --address "$IP" \
  --scopes cloud-platform \
  --metadata-from-file startup-script="$HERE/startup.sh" \
  --metadata wd-repo="$REPO",wd-branch="$BRANCH",wd-secret-name="$ENV_SECRET",wd-repo-secret="$REPO_SECRET"

echo
echo "=== VM created. Static IP: $IP ==="
echo "1) Point ${APP_DOMAIN} A-record -> ${IP} (your DNS provider)."
echo "2) Wait for DNS to resolve, then SSH via the GCP console and run:"
echo "   sudo certbot --nginx -d ${APP_DOMAIN} --non-interactive --agree-tos -m ${OWNER_EMAIL:-you@example.com} --redirect"
echo "3) Set the Evolution dashboard webhook to:"
echo "   https://${APP_DOMAIN}/api/webhooks/evolution?token=<sha256('wd-webhook:'+SESSION_SECRET).slice(0,32)>"
echo "Health: curl http://${IP}:8080/healthz  (pre-DNS)  ->  curl https://${APP_DOMAIN}/healthz (post-certbot)"
