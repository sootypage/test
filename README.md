# Custom AMP Ubuntu Panel

This is a starter AMP-style game server panel for Ubuntu.

It has two parts:

- `panel/` - the web dashboard users and admins log into
- `agent/` - the Ubuntu node service that controls Docker game server containers

You can install:

- panel only
- agent / node only
- both panel and agent on the same Ubuntu server

## Features in this starter

- Login system
- Bootstrap admin account from `.env`
- Admin dashboard
- Add Ubuntu nodes
- Create users
- Create Minecraft Paper servers with Docker
- Start, stop, and restart servers
- View console logs
- Send console commands using `rcon-cli` when supported by the container
- Simple JSON database so it is easy to test
- Interactive Ubuntu installer
- Optional domain setup
- Optional Nginx reverse proxy and Let's Encrypt SSL
- Systemd services for auto-starting the panel and/or agent

## Put this on GitHub

From your computer or Ubuntu server:

```bash
git init
git add .
git commit -m "Initial custom AMP Ubuntu panel"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
git push -u origin main
```

If Git asks you to log in, use a GitHub personal access token instead of your password.

## Install from GitHub on Ubuntu

Replace the GitHub URL with your repo URL:

```bash
sudo apt update
sudo apt install -y git
cd /tmp
git clone https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git custom-amp-ubuntu-panel
cd custom-amp-ubuntu-panel
chmod +x install-ubuntu.sh
./install-ubuntu.sh
```

The installer asks:

1. Install panel only, agent/node only, or both
2. Whether you want to use a domain for the panel
3. If using a domain, whether to set up Nginx and Let's Encrypt SSL
4. Admin email and password for the panel
5. Agent token if you are installing an agent/node only

## Domain or IP mode

If you choose a domain, the installer sets:

```env
PUBLIC_BASE_URL=https://your-domain.com
```

If you choose no domain, it sets:

```env
PUBLIC_BASE_URL=http://YOUR_SERVER_IP:3000
```

For domain mode, make sure your DNS record points to the Ubuntu server first:

```text
A record
panel.yourdomain.com -> YOUR_SERVER_IP
```

Then run the installer and choose the Nginx + Let's Encrypt option.

## Panel-only install

Use this when the server is only going to host the website/dashboard.

The installer will only install and configure:

```text
panel/
custom-amp-panel systemd service
```

The panel will run on port `3000` by default.

## Agent/node-only install

Use this on extra Ubuntu machines that will run game servers.

The installer will only install and configure:

```text
agent/
Docker
/opt/custom-amp/servers
custom-amp-agent systemd service
```

The agent will run on port `4100` by default.

When it asks for the agent token, use the same value as `PANEL_TO_AGENT_TOKEN` from the panel server.

You can find the panel token with:

```bash
cat /opt/custom-amp/custom-amp-ubuntu-panel/panel/.env | grep PANEL_TO_AGENT_TOKEN
```

Then add the node inside the panel admin page with:

```text
http://NODE_SERVER_IP:4100
```

## Both install

Use this if your first Ubuntu server will run both the dashboard and game servers.

The installer will configure both services and use the same secret token for panel-to-agent communication.

## Service commands

Panel:

```bash
sudo systemctl status custom-amp-panel
sudo systemctl restart custom-amp-panel
sudo journalctl -u custom-amp-panel -f
```

Agent:

```bash
sudo systemctl status custom-amp-agent
sudo systemctl restart custom-amp-agent
sudo journalctl -u custom-amp-agent -f
```

## Config files

Panel config:

```bash
nano /opt/custom-amp/custom-amp-ubuntu-panel/panel/.env
```

Agent config:

```bash
nano /opt/custom-amp/custom-amp-ubuntu-panel/agent/.env
```

## Firewall ports

If you use UFW, open the needed ports.

For panel with direct IP access:

```bash
sudo ufw allow 3000/tcp
```

For panel with Nginx/domain:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

For agent/node access from your panel:

```bash
sudo ufw allow 4100/tcp
```

For Minecraft servers:

```bash
sudo ufw allow 25565/tcp
```

## Important notes

This is a starter project. Before using it with real customers, add stronger security, PostgreSQL, backups, per-server file permissions, billing, and production hardening.

## New server management features

This version includes extra AMP-style tools:

- File manager for each server
- Upload files through the browser
- Download server files through the browser
- Edit small text files in the browser
- Delete files/folders
- Create folders
- Create and download `.tar.gz` backups
- Delete backups
- Plugin installer: downloads direct `.jar` URLs into `/plugins`
- Mod installer: downloads direct `.jar` URLs into `/mods`
- Better live console logs with auto-refresh every 5 seconds

### After updating from an older ZIP

If you already installed the old version, copy the new files over your old project folder, then run:

```bash
cd /opt/custom-amp/panel
npm install
cd /opt/custom-amp/agent
npm install
sudo systemctl restart custom-amp-panel
sudo systemctl restart custom-amp-agent
```

### Plugin/mod installer note

Use direct download links to `.jar` files. Some sites use buttons that do not directly point to the file, so the download may fail. Modrinth/GitHub release direct asset links usually work well.

## v4 additions

This version adds:

- RAM, CPU, and storage usage on each server page
- RAM limit per server using Docker memory limits
- CPU limit per server using Docker `--cpus`
- Storage limit per server for panel/agent managed uploads and plugin/mod installs
- Server IP + public port fields
- Agent token field on each node, so different nodes can use different tokens
- Installer asks for the panel name
- `update.sh` updates code while preserving `.env`, panel data, users, nodes, and servers

### Fixing `Unauthorized agent token`

The panel and agent must use the same token.

Check panel token:

```bash
cat /opt/custom-amp/custom-amp-ubuntu-panel/panel/.env | grep PANEL_TO_AGENT_TOKEN
```

Check agent token:

```bash
cat /opt/custom-amp/custom-amp-ubuntu-panel/agent/.env | grep AGENT_TOKEN
```

They must match. Restart both services after changing either file:

```bash
sudo systemctl restart custom-amp-panel
sudo systemctl restart custom-amp-agent
```

When adding a node in the admin page, paste the agent token into the **Agent token** field if it is different from the panel default token.

### Updating later

From a newly downloaded/cloned version:

```bash
chmod +x update.sh
./update.sh
```

The updater does not replace:

- `panel/.env`
- `agent/.env`
- `panel/data`


## Cloudflare subdomain automation

Add these to `panel/.env` to let the panel create DNS records automatically:

```env
CLOUDFLARE_API_TOKEN=your_cloudflare_api_token
CLOUDFLARE_ZONE_ID=your_zone_id
CLOUDFLARE_ROOT_DOMAIN=example.com
CLOUDFLARE_PROXIED=false
```

Security notes:
- Use a Cloudflare API token, not your global API key.
- Limit the token to one zone only.
- Give it `Zone:DNS Edit` permission only.
- Keep `CLOUDFLARE_PROXIED=false` for Minecraft Java unless you use Cloudflare Spectrum.
- The token is stored only in `panel/.env` and is never displayed in the panel UI.

The panel allows one subdomain per server and checks all existing server records before saving. If a hostname is already used, it will reject it as taken.

## Update notes - server delete, resources, and server type

This build adds:

- Owner/admin server deletion from the server Settings tab. It removes the Docker container, server files, backups, and the panel record.
- Admin server resource editing from Admin -> Server resources. Changing RAM/CPU/storage recreates the Docker container safely while keeping the same `/data` folder.
- Server type selection in the server Settings tab. You can switch between Paper, Purpur, Fabric, Forge, NeoForge, and Vanilla. Changing type or version recreates the container while keeping server files.
- Network port changes recreate the Docker container with the new port bindings while keeping the same server files.

After updating, run:

```bash
cd /opt/custom-amp/custom-amp-ubuntu-panel/panel && npm install
cd /opt/custom-amp/custom-amp-ubuntu-panel/agent && npm install
sudo systemctl restart custom-amp-panel custom-amp-agent
```
