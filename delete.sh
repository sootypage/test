#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/custom-amp/custom-amp-ubuntu-panel}"
SERVERS_DIR="${SERVERS_DIR:-/opt/custom-amp/servers}"
BACKUPS_DIR="${BACKUPS_DIR:-/opt/custom-amp/backups}"
TMP_DIR="${TMP_DIR:-/opt/custom-amp/tmp}"

bold(){ printf '\033[1m%s\033[0m\n' "$*"; }
warn(){ printf '\033[1;33m[WARN]\033[0m %s\n' "$*"; }
ask_yes(){ local prompt="$1"; read -r -p "$prompt [y/N]: " ans || true; [[ "$ans" =~ ^[Yy]([Ee][Ss])?$ ]]; }

[[ "${EUID}" -eq 0 ]] || { echo "Run with sudo: sudo ./delete.sh"; exit 1; }

bold "Custom AMP uninstaller"
warn "This removes services and panel/agent code installed by install-ubuntu.sh."

systemctl stop custom-amp-panel 2>/dev/null || true
systemctl stop custom-amp-agent 2>/dev/null || true
systemctl disable custom-amp-panel 2>/dev/null || true
systemctl disable custom-amp-agent 2>/dev/null || true
rm -f /etc/systemd/system/custom-amp-panel.service /etc/systemd/system/custom-amp-agent.service
systemctl daemon-reload

if ask_yes "Remove Docker containers created by the panel?"; then
  docker ps -a --format '{{.Names}}' | grep '^amp-' | xargs -r docker rm -f || true
fi

if ask_yes "Remove panel/agent code at ${INSTALL_DIR}?"; then
  rm -rf "$INSTALL_DIR"
fi

if ask_yes "Remove server files at ${SERVERS_DIR}? THIS DELETES WORLDS."; then
  rm -rf "$SERVERS_DIR"
else
  warn "Keeping server files: ${SERVERS_DIR}"
fi

if ask_yes "Remove backups at ${BACKUPS_DIR}?"; then
  rm -rf "$BACKUPS_DIR"
else
  warn "Keeping backups: ${BACKUPS_DIR}"
fi

if ask_yes "Remove temp files at ${TMP_DIR}?"; then
  rm -rf "$TMP_DIR"
fi

if ask_yes "Remove PostgreSQL database/user custom_amp/custom_amp_panel?"; then
  sudo -u postgres psql -c "DROP DATABASE IF EXISTS custom_amp_panel;" || true
  sudo -u postgres psql -c "DROP USER IF EXISTS custom_amp;" || true
fi

bold "Delete complete."
