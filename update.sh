#!/usr/bin/env bash
set -euo pipefail
APP_DIR="/opt/custom-amp/custom-amp-ubuntu-panel"
REPO_ZIP_URL="${REPO_ZIP_URL:-https://github.com/sootypage/test/archive/refs/heads/main.zip}"
TMP_DIR="/tmp/custom-amp-safe-update"
TMP_ZIP="/tmp/custom-amp-main.zip"
echo "[1/8] Installing needed tools..."
sudo apt update
sudo apt install -y curl unzip rsync
echo "[2/8] Downloading latest files from GitHub ZIP..."
rm -rf "$TMP_DIR" "$TMP_ZIP"
curl -L "$REPO_ZIP_URL" -o "$TMP_ZIP"
echo "[3/8] Unzipping..."
mkdir -p "$TMP_DIR"
unzip -q "$TMP_ZIP" -d "$TMP_DIR"
SRC_DIR="$(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
[ -d "$SRC_DIR" ] || { echo "ERROR: Could not find extracted GitHub folder."; exit 1; }
echo "[4/8] Saving configs..."
cp "$APP_DIR/panel/.env" /tmp/custom-amp-panel.env 2>/dev/null || true
cp "$APP_DIR/agent/.env" /tmp/custom-amp-agent.env 2>/dev/null || true
cp "$APP_DIR/.env.update" /tmp/custom-amp-update.env 2>/dev/null || true
echo "[5/8] Updating panel and agent code without deleting local-only files..."
sudo rsync -a \
  --exclude "panel/.env" \
  --exclude "agent/.env" \
  --exclude "panel/data/" \
  --exclude "panel/node_modules/" \
  --exclude "agent/node_modules/" \
  --exclude ".env.update" \
  "$SRC_DIR/" "$APP_DIR/"
echo "[6/8] Restoring configs..."
sudo cp /tmp/custom-amp-panel.env "$APP_DIR/panel/.env" 2>/dev/null || true
sudo cp /tmp/custom-amp-agent.env "$APP_DIR/agent/.env" 2>/dev/null || true
sudo cp /tmp/custom-amp-update.env "$APP_DIR/.env.update" 2>/dev/null || true
sudo chmod +x "$APP_DIR/install-ubuntu.sh" "$APP_DIR/update.sh" 2>/dev/null || true
echo "[7/8] Installing packages..."
(cd "$APP_DIR/panel" && npm install --omit=dev)
(cd "$APP_DIR/agent" && npm install --omit=dev)
echo "[8/8] Restarting services..."
sudo systemctl restart custom-amp-panel || true
sudo systemctl restart custom-amp-agent || true
rm -rf "$TMP_DIR" "$TMP_ZIP"
echo "[DONE] Updated without deleting servers, backups, panel data, or .env files."
