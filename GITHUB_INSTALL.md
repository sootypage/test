# GitHub install guide

## 1. Create the GitHub repo

Create a new empty GitHub repository, then run this inside the project folder:

```bash
git init
git add .
git commit -m "Initial custom AMP Ubuntu panel"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
git push -u origin main
```

## 2. Install on Ubuntu from the repo

```bash
sudo apt update
sudo apt install -y git
cd /tmp
git clone https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git custom-amp-ubuntu-panel
cd custom-amp-ubuntu-panel
chmod +x install-ubuntu.sh
./install-ubuntu.sh
```

## 3. Installer choices

Choose one of these:

```text
1) Panel only
2) Agent / node only
3) Both panel and agent
```

Domain choices:

```text
Use domain: PUBLIC_BASE_URL=https://your-domain.com
No domain:  PUBLIC_BASE_URL=http://server-ip:3000
```

Agent/node-only installs ask for the agent token. Use the same token from the panel `.env`.
