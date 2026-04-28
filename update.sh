#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/custom-amp/custom-amp-ubuntu-panel"
REPO_URL="https://github.com/sootypage/test.git"
BRANCH="main"
TMP_DIR="/tmp/custom-amp-safe-update"
PANEL_SERVICE="custom-amp-panel"
AGENT_SERVICE="custom-amp-agent"

if [ -f "$APP_DIR/.env.update" ]; then
  # shellcheck disable=SC1090
  source "$APP_DIR/.env.update"
fi

if [ -z "${REPO_URL:-}" ]; then
  echo "ERROR: REPO_URL is empty. Put REPO_URL=https://github.com/your/repo.git in $APP_DIR/.env.update"
  exit 1
fi

command -v git >/dev/null || { echo "ERROR: git is not installed. Run: sudo apt install -y git"; exit 1; }
command -v rsync >/dev/null || { echo "ERROR: rsync is not installed. Run: sudo apt install -y rsync"; exit 1; }
command -v npm >/dev/null || { echo "ERROR: npm is not installed. Install NodeSource Node.js 20."; exit 1; }

echo "[INFO] Updating from $REPO_URL branch $BRANCH"
echo "[INFO] This preserves: panel/.env, agent/.env, .env.update, panel/data, node_modules, /opt/custom-amp/servers, /opt/custom-amp/backups"

rm -rf "$TMP_DIR"
git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$TMP_DIR"

mkdir -p "$APP_DIR"

cp "$APP_DIR/panel/.env" /tmp/custom-amp-panel.env 2>/dev/null || true
cp "$APP_DIR/agent/.env" /tmp/custom-amp-agent.env 2>/dev/null || true
cp "$APP_DIR/.env.update" /tmp/custom-amp-update.env 2>/dev/null || true

rsync -a --delete \
  --exclude "panel/.env" \
  --exclude "agent/.env" \
  --exclude "panel/data/" \
  --exclude "panel/node_modules/" \
  --exclude "agent/node_modules/" \
  --exclude ".env.update" \
  "$TMP_DIR/" "$APP_DIR/"

cp /tmp/custom-amp-panel.env "$APP_DIR/panel/.env" 2>/dev/null || true
cp /tmp/custom-amp-agent.env "$APP_DIR/agent/.env" 2>/dev/null || true
cp /tmp/custom-amp-update.env "$APP_DIR/.env.update" 2>/dev/null || true

chmod +x "$APP_DIR/install-ubuntu.sh" "$APP_DIR/update.sh" 2>/dev/null || true

if [ -d "$APP_DIR/panel" ]; then
  echo "[INFO] Installing panel packages..."
  (cd "$APP_DIR/panel" && npm install --omit=dev)
fi

if [ -d "$APP_DIR/agent" ]; then
  echo "[INFO] Installing agent packages..."
  (cd "$APP_DIR/agent" && npm install --omit=dev)
fi

if systemctl list-unit-files | grep -q "^${PANEL_SERVICE}.service"; then
  systemctl restart "$PANEL_SERVICE"
fi
if systemctl list-unit-files | grep -q "^${AGENT_SERVICE}.service"; then
  systemctl restart "$AGENT_SERVICE"
fi

rm -rf "$TMP_DIR"
echo "[DONE] Updated panel/agent code without deleting servers, backups, panel data, or .env files."
