#!/usr/bin/env bash
# WheelDeal GCE startup script (metadata `startup-script`). Self-bootstraps the
# VM with NO interactive SSH: installs Docker + compose, adds swap (1GB VM),
# pulls secrets from Secret Manager into infra/docker/.env, clones the deploy
# branch, brings the stack up (redis + gateway + workers), and installs nginx.
# SSL (certbot) is a SEPARATE post-DNS step - see infra/gcp/README.md.
#
# Required VM metadata / instance attributes (set at create time):
#   wd-repo         github owner/repo             (e.g. KaspiDoron/Rental-App)
#   wd-branch       deploy branch                 (e.g. claude/rental-negotiation-app-pc33ux)
#   wd-secret-name  Secret Manager secret id      (holds the full .env contents)
#   wd-repo-secret  Secret Manager secret id      (a GitHub token for the private clone; optional if public)
#
# The .env secret's payload is the literal infra/docker/.env (SUPABASE_URL,
# SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL pooled:6543, SESSION_SECRET,
# ADMIN_EMAILS, EVOLUTION_API_URL/KEY, APP_DOMAIN, ...). SESSION_SECRET MUST
# equal the Vercel value or webhook tokens + app_config decryption break.
set -euo pipefail
exec > >(tee /var/log/wd-startup.log) 2>&1
echo "[wd] startup begin $(date -u)"

meta() { curl -s -H "Metadata-Flavor: Google" \
  "http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1" || true; }

REPO="$(meta wd-repo)";           REPO="${REPO:-KaspiDoron/Rental-App}"
BRANCH="$(meta wd-branch)";       BRANCH="${BRANCH:-claude/rental-negotiation-app-pc33ux}"
SECRET_NAME="$(meta wd-secret-name)"; SECRET_NAME="${SECRET_NAME:-wheeldeal-env}"
REPO_SECRET="$(meta wd-repo-secret)"
APP_DIR=/opt/wheeldeal

# --- Docker + compose plugin (Debian 12) ------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg git nginx
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
systemctl enable --now docker

# --- Swap (the 1GB e2-micro needs headroom for docker build) ----------------
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile; mkswap /swapfile; swapon /swapfile
  echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi

# --- Fetch source + secrets --------------------------------------------------
rm -rf "$APP_DIR"
if [ -n "$REPO_SECRET" ]; then
  TOKEN="$(gcloud secrets versions access latest --secret="$REPO_SECRET" 2>/dev/null || true)"
  git clone --depth 1 --branch "$BRANCH" "https://x-access-token:${TOKEN}@github.com/${REPO}.git" "$APP_DIR"
else
  git clone --depth 1 --branch "$BRANCH" "https://github.com/${REPO}.git" "$APP_DIR"
fi

# The .env secret payload IS the infra/docker/.env file.
gcloud secrets versions access latest --secret="$SECRET_NAME" > "$APP_DIR/infra/docker/.env"
chmod 600 "$APP_DIR/infra/docker/.env"

# --- Bring the stack up (redis + gateway + workers; NO web - stays on Vercel)-
cd "$APP_DIR/infra/docker"
docker compose --env-file .env up -d --build

# --- nginx reverse proxy (HTTP only here; certbot adds TLS post-DNS) ---------
cp "$APP_DIR/infra/gcp/nginx.conf" /etc/nginx/sites-available/wheeldeal
ln -sf /etc/nginx/sites-available/wheeldeal /etc/nginx/sites-enabled/wheeldeal
rm -f /etc/nginx/sites-enabled/default
# Substitute the server_name from APP_DOMAIN in the .env (bare host).
DOMAIN="$(grep -E '^APP_DOMAIN=' "$APP_DIR/infra/docker/.env" | cut -d= -f2- | sed 's#https\?://##;s#/.*##' | tr -d ' \r')"
if [ -n "$DOMAIN" ]; then sed -i "s/__API_DOMAIN__/$DOMAIN/g" /etc/nginx/sites-available/wheeldeal; fi
nginx -t && systemctl reload nginx

echo "[wd] startup complete $(date -u). gateway :8080 behind nginx :80."
echo "[wd] NEXT (manual): point $DOMAIN A-record at this VM's static IP, then:"
echo "[wd]   certbot --nginx -d $DOMAIN --non-interactive --agree-tos -m <owner-email> --redirect"
