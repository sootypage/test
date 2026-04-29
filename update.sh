#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/custom-amp/custom-amp-ubuntu-panel"
REPO_URL=""
BRANCH="main"

PANEL_SERVICE="custom-amp-panel"
AGENT_SERVICE="custom-amp-agent"

if [ -f "$APP_DIR/.env.update" ]; then
  # shellcheck disable=SC1090
  source "$APP_DIR/.env.update"
fi

if [ -z "${REPO_URL}" ]; then
  if [ -d "$APP_DIR/.git" ]; then
    REPO_URL="$(git -C "$APP_DIR" config --get remote.origin.url || true)"
  fi
fi

if [ -z "${REPO_URL}" ]; then
  echo "ERROR: REPO_URL is not set and no git remote was found."
  echo "Put this in $APP_DIR/.env.update:"
  echo "REPO_URL=https://github.com/YOUR_USERNAME/YOUR_REPO.git"
  echo "BRANCH=main"
  exit 1
fi

echo "[INFO] Updating from: $REPO_URL"
echo "[INFO] Branch: $BRANCH"

sudo apt update
sudo apt install -y git rsync
sudo mkdir -p /opt/custom-amp

if [ ! -d "$APP_DIR/.git" ]; then
  echo "[INFO] App folder is not a git checkout yet. Converting it safely..."
  TMP_CLONE="/tmp/custom-amp-update-$(date +%s)"
  git clone --branch "$BRANCH" "$REPO_URL" "$TMP_CLONE"

  echo "[INFO] Preserving configs and data..."
  [ -f "$APP_DIR/panel/.env" ] && cp "$APP_DIR/panel/.env" /tmp/custom-amp-panel.env
  [ -f "$APP_DIR/agent/.env" ] && cp "$APP_DIR/agent/.env" /tmp/custom-amp-agent.env
  [ -f "$APP_DIR/.env.update" ] && cp "$APP_DIR/.env.update" /tmp/custom-amp-update.env

  sudo rsync -a --delete \
    --exclude 'panel/.env' \
    --exclude 'agent/.env' \
    --exclude 'panel/data/' \
    --exclude 'panel/node_modules/' \
    --exclude 'agent/node_modules/' \
    --exclude '.env.update' \
    "$TMP_CLONE/" "$APP_DIR/"

  [ -f /tmp/custom-amp-panel.env ] && sudo mv /tmp/custom-amp-panel.env "$APP_DIR/panel/.env"
  [ -f /tmp/custom-amp-agent.env ] && sudo mv /tmp/custom-amp-agent.env "$APP_DIR/agent/.env"
  [ -f /tmp/custom-amp-update.env ] && sudo mv /tmp/custom-amp-update.env "$APP_DIR/.env.update"

  rm -rf "$TMP_CLONE"
else
  echo "[INFO] Resetting code to match GitHub, while preserving configs/data..."
  cd "$APP_DIR"

  git remote set-url origin "$REPO_URL"
  git fetch origin "$BRANCH"

  [ -f panel/.env ] && cp panel/.env /tmp/custom-amp-panel.env
  [ -f agent/.env ] && cp agent/.env /tmp/custom-amp-agent.env
  [ -f .env.update ] && cp .env.update /tmp/custom-amp-update.env

  git reset --hard "origin/$BRANCH"

  [ -f /tmp/custom-amp-panel.env ] && mv /tmp/custom-amp-panel.env panel/.env
  [ -f /tmp/custom-amp-agent.env ] && mv /tmp/custom-amp-agent.env agent/.env
  [ -f /tmp/custom-amp-update.env ] && mv /tmp/custom-amp-update.env .env.update
fi

cd "$APP_DIR"
chmod +x install-ubuntu.sh update.sh 2>/dev/null || true

if [ -d panel ]; then
  echo "[INFO] Installing panel dependencies..."
  cd "$APP_DIR/panel"
  npm install --omit=dev
fi

if [ -d agent ]; then
  echo "[INFO] Installing agent dependencies..."
  cd "$APP_DIR/agent"
  npm install --omit=dev
fi

echo "[INFO] Restarting services if they exist..."
if systemctl list-unit-files | grep -q "^${PANEL_SERVICE}.service"; then
  sudo systemctl restart "$PANEL_SERVICE"
fi
if systemctl list-unit-files | grep -q "^${AGENT_SERVICE}.service"; then
  sudo systemctl restart "$AGENT_SERVICE"
fi

echo "[DONE] Updated code from GitHub without deleting servers, backups, node config, or panel data."
