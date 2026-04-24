#!/usr/bin/env bash
set -euo pipefail

APP_NAME="custom-amp"
INSTALL_DIR="${INSTALL_DIR:-/opt/custom-amp/custom-amp-ubuntu-panel}"
SERVERS_DIR="${SERVERS_DIR:-/opt/custom-amp/servers}"
PANEL_PORT="${PANEL_PORT:-3000}"
AGENT_PORT="${AGENT_PORT:-4100}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '\033[1;34m[INFO]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[WARN]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*"; exit 1; }
ask() {
  local prompt="$1" default="${2:-}"
  local reply
  if [[ -n "$default" ]]; then
    read -r -p "$prompt [$default]: " reply || true
    echo "${reply:-$default}"
  else
    read -r -p "$prompt: " reply || true
    echo "$reply"
  fi
}
yes_no() {
  local prompt="$1" default="${2:-n}" reply
  read -r -p "$prompt [$default]: " reply || true
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy]([Ee][Ss])?$ ]]
}
random_secret() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32; else date +%s%N | sha256sum | awk '{print $1}'; fi
}
server_ip() {
  hostname -I 2>/dev/null | awk '{print $1}'
}
write_env_value() {
  local file="$1" key="$2" value="$3"
  mkdir -p "$(dirname "$file")"
  touch "$file"
  if grep -q "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

[[ "${EUID}" -ne 0 ]] || fail "Do not run this script as root. Run it as your normal sudo user."
command -v sudo >/dev/null 2>&1 || fail "sudo is required."

bold "Custom AMP Ubuntu installer"
echo "What do you want to install?"
echo "  1) Panel only"
echo "  2) Agent / node only"
echo "  3) Both panel and agent"
INSTALL_CHOICE="$(ask "Choose 1, 2, or 3" "3")"
case "$INSTALL_CHOICE" in
  1) INSTALL_PANEL=true; INSTALL_AGENT=false ;;
  2) INSTALL_PANEL=false; INSTALL_AGENT=true ;;
  3) INSTALL_PANEL=true; INSTALL_AGENT=true ;;
  *) fail "Invalid choice. Use 1, 2, or 3." ;;
esac

USE_DOMAIN=false
DOMAIN_NAME=""
PUBLIC_BASE_URL=""
SETUP_NGINX=false
if [[ "$INSTALL_PANEL" == true ]]; then
  if yes_no "Will you use a domain for the panel?" "y"; then
    USE_DOMAIN=true
    DOMAIN_NAME="$(ask "Enter panel domain, without http:// or https://" "panel.example.com")"
    PUBLIC_BASE_URL="https://${DOMAIN_NAME}"
    if yes_no "Install Nginx reverse proxy and free Let's Encrypt SSL for this domain?" "y"; then
      SETUP_NGINX=true
    fi
  else
    IP_ADDR="$(server_ip)"
    IP_ADDR="$(ask "Enter the IP users will open for the panel" "${IP_ADDR:-127.0.0.1}")"
    PUBLIC_BASE_URL="http://${IP_ADDR}:${PANEL_PORT}"
  fi
fi

ADMIN_EMAIL=""
ADMIN_PASSWORD=""
if [[ "$INSTALL_PANEL" == true ]]; then
  ADMIN_EMAIL="$(ask "Admin email" "admin@example.com")"
  ADMIN_PASSWORD="$(ask "Admin password" "ChangeMe123!")"
fi

SHARED_TOKEN="$(random_secret)"
if [[ "$INSTALL_AGENT" == true && "$INSTALL_PANEL" == false ]]; then
  SHARED_TOKEN="$(ask "Agent token. This must match PANEL_TO_AGENT_TOKEN on your panel" "change-this-agent-token")"
fi

info "Installing system packages..."
sudo apt update
PACKAGES=(curl ca-certificates gnupg build-essential)
if [[ "$INSTALL_PANEL" == true ]]; then PACKAGES+=(nodejs npm); fi
if [[ "$INSTALL_AGENT" == true ]]; then PACKAGES+=(nodejs npm docker.io); fi
if [[ "$SETUP_NGINX" == true ]]; then PACKAGES+=(nginx certbot python3-certbot-nginx); fi
sudo apt install -y "${PACKAGES[@]}"

if [[ "$INSTALL_AGENT" == true ]]; then
  info "Enabling Docker..."
  sudo systemctl enable --now docker
  sudo usermod -aG docker "$USER" || true
  sudo mkdir -p "$SERVERS_DIR"
  sudo chown -R "$USER:$USER" /opt/custom-amp || true
fi

# Make sure files live in /opt so systemd paths work. If already running from there, skip copy.
CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$CURRENT_DIR" != "$INSTALL_DIR" ]]; then
  info "Copying project to $INSTALL_DIR..."
  sudo mkdir -p "$(dirname "$INSTALL_DIR")"
  sudo rm -rf "$INSTALL_DIR"
  sudo cp -a "$CURRENT_DIR" "$INSTALL_DIR"
  sudo chown -R "$USER:$USER" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

if [[ "$INSTALL_PANEL" == true ]]; then
  info "Installing panel dependencies..."
  cd panel
  npm install
  cp -n .env.example .env || true
  write_env_value .env PORT "$PANEL_PORT"
  write_env_value .env SESSION_SECRET "$(random_secret)"
  write_env_value .env BRAND_NAME "Custom AMP Panel"
  write_env_value .env PUBLIC_BASE_URL "$PUBLIC_BASE_URL"
  write_env_value .env ADMIN_EMAIL "$ADMIN_EMAIL"
  write_env_value .env ADMIN_PASSWORD "$ADMIN_PASSWORD"
  write_env_value .env DATA_DIR "./data"
  write_env_value .env PANEL_TO_AGENT_TOKEN "$SHARED_TOKEN"
  write_env_value .env NODE_API_TIMEOUT_MS "10000"
  cd ..
  info "Installing panel systemd service..."
  sudo cp docs/systemd-panel.service /etc/systemd/system/custom-amp-panel.service
  sudo systemctl daemon-reload
  sudo systemctl enable --now custom-amp-panel
fi

if [[ "$INSTALL_AGENT" == true ]]; then
  info "Installing agent dependencies..."
  cd agent
  npm install
  cp -n .env.example .env || true
  write_env_value .env PORT "$AGENT_PORT"
  write_env_value .env AGENT_NAME "Ubuntu Node 1"
  write_env_value .env AGENT_LOCATION "Unknown"
  write_env_value .env AGENT_TOKEN "$SHARED_TOKEN"
  write_env_value .env SERVERS_DIR "$SERVERS_DIR"
  write_env_value .env MAX_CONSOLE_LINES "300"
  cd ..
  info "Installing agent systemd service..."
  sudo cp docs/systemd-agent.service /etc/systemd/system/custom-amp-agent.service
  sudo systemctl daemon-reload
  sudo systemctl enable --now custom-amp-agent
fi

if [[ "$SETUP_NGINX" == true ]]; then
  info "Configuring Nginx for ${DOMAIN_NAME}..."
  sudo tee "/etc/nginx/sites-available/custom-amp-panel" >/dev/null <<NGINX
server {
    listen 80;
    server_name ${DOMAIN_NAME};

    location / {
        proxy_pass http://127.0.0.1:${PANEL_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }
}
NGINX
  sudo ln -sf /etc/nginx/sites-available/custom-amp-panel /etc/nginx/sites-enabled/custom-amp-panel
  sudo nginx -t
  sudo systemctl reload nginx
  if yes_no "Run Certbot now for HTTPS? Make sure the domain points to this server first" "y"; then
    sudo certbot --nginx -d "$DOMAIN_NAME"
  else
    warn "Skipping Certbot. Panel may be available at http://${DOMAIN_NAME} until SSL is set up."
  fi
fi

bold "Install complete"
if [[ "$INSTALL_PANEL" == true ]]; then
  echo "Panel URL: ${PUBLIC_BASE_URL}"
  echo "Admin email: ${ADMIN_EMAIL}"
  echo "Panel service: sudo systemctl status custom-amp-panel"
fi
if [[ "$INSTALL_AGENT" == true ]]; then
  echo "Agent URL for the panel admin page: http://$(server_ip):${AGENT_PORT}"
  echo "Agent token: ${SHARED_TOKEN}"
  echo "Agent service: sudo systemctl status custom-amp-agent"
  warn "You may need to log out and back in for Docker group permissions."
fi
