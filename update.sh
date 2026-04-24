#!/usr/bin/env bash
set -euo pipefail
INSTALL_DIR="${INSTALL_DIR:-/opt/custom-amp/custom-amp-ubuntu-panel}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

info(){ printf '\033[1;34m[INFO]\033[0m %s\n' "$*"; }
fail(){ printf '\033[1;31m[ERROR]\033[0m %s\n' "$*"; exit 1; }
[[ "${EUID}" -ne 0 ]] || fail "Do not run this script as root. Run it as your normal sudo user."
if ! command -v rsync >/dev/null 2>&1; then sudo apt update; sudo apt install -y rsync; fi

info "Updating files in $INSTALL_DIR without changing config or panel data..."
sudo mkdir -p "$INSTALL_DIR"
sudo rsync -a --delete \
  --exclude '.git' \
  --exclude 'panel/.env' \
  --exclude 'agent/.env' \
  --exclude 'panel/data' \
  --exclude 'node_modules' \
  "$SRC_DIR/" "$INSTALL_DIR/"
sudo chown -R "$USER:$USER" "$INSTALL_DIR"

if [[ -d "$INSTALL_DIR/panel" ]]; then
  info "Updating panel dependencies..."
  cd "$INSTALL_DIR/panel"
  npm install
fi
if [[ -d "$INSTALL_DIR/agent" ]]; then
  info "Updating agent dependencies..."
  cd "$INSTALL_DIR/agent"
  npm install
fi

sudo systemctl daemon-reload || true
sudo systemctl restart custom-amp-panel || true
sudo systemctl restart custom-amp-agent || true
info "Update complete. Config, tokens, users, nodes, and servers were preserved."
