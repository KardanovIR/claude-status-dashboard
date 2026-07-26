#!/usr/bin/env bash
# One-time setup of the AgStatus production droplet (Ubuntu/Debian, run as root):
#
#   curl -fsSL https://raw.githubusercontent.com/KardanovIR/claude-status-dashboard/master/deploy/bootstrap-droplet.sh | bash
#
# What it does, in order:
#   1. Installs Docker (with the compose plugin) and git if missing.
#   2. Authorizes the GitHub Actions deploy key (public half below; the
#      private half lives in the repo's DEPLOY_SSH_KEY secret).
#   3. Clones the repo to /opt/agstatus (or updates an existing checkout).
#   4. Writes a production .env (only if none exists) with a random
#      Postgres password.
#   5. Starts the full stack: app + PostgreSQL + Caddy TLS.
#
# Afterwards every push to master redeploys automatically via
# .github/workflows/deploy.yml. Idempotent — safe to re-run.
set -euo pipefail

REPO="https://github.com/KardanovIR/claude-status-dashboard.git"
APP_DIR="/opt/agstatus"
DOMAIN="agstatus.online"
DEPLOY_PUBKEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINYlSN5o96TtkXViNlEDd2c2rBrHjKtCLntdy0q/rvgZ agstatus-deploy@github-actions"

[ "$(id -u)" -eq 0 ] || { echo "Run as root." >&2; exit 1; }

echo "==> Installing prerequisites"
if ! command -v docker > /dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
command -v git > /dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq git; }

echo "==> Authorizing the GitHub Actions deploy key"
mkdir -p /root/.ssh && chmod 700 /root/.ssh
touch /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys
grep -qF "$DEPLOY_PUBKEY" /root/.ssh/authorized_keys || echo "$DEPLOY_PUBKEY" >> /root/.ssh/authorized_keys

echo "==> Fetching the repo into $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch origin master
  git -C "$APP_DIR" reset --hard origin/master
else
  git clone "$REPO" "$APP_DIR"
fi

if [ ! -f "$APP_DIR/.env" ]; then
  echo "==> Writing production .env"
  cat > "$APP_DIR/.env" <<ENV
PUBLIC_URL=https://$DOMAIN
DOMAIN=$DOMAIN
MULTI_TENANT=true
TRUST_PROXY=1
POSTGRES_PASSWORD=$(openssl rand -hex 24)
# APNs push (optional): put the .p8 key in ./keys and uncomment.
#APNS_KEY_PATH=/app/keys/AuthKey.p8
#APNS_KEY_ID=
#APNS_TEAM_ID=
#APNS_TOPIC=com.kardanov.agstatus
#APNS_ENV=production
ENV
  chmod 600 "$APP_DIR/.env"
else
  echo "==> Keeping existing $APP_DIR/.env"
fi

echo "==> Starting the stack (app + postgres + caddy)"
cd "$APP_DIR"
mkdir -p keys
docker compose --profile tls up -d --build --remove-orphans

echo
echo "Done. Checks:"
echo "  - docker compose ps                      (all three services healthy?)"
echo "  - curl -s http://localhost:3000/healthz  (app alive?)"
echo
echo "Remember:"
echo "  - DNS: point an A record for $DOMAIN at this droplet's IP, or Caddy"
echo "    cannot obtain a TLS certificate."
echo "  - Migrating old SQLite data: copy the .db file here, then"
echo "    run scripts/migrate-sqlite-to-postgres.js (see docs/self-hosting.md)."
echo "  - APNs: copy your .p8 into $APP_DIR/keys and fill the APNS_* vars in .env."
