#!/usr/bin/env bash
set -euo pipefail

PANEL_DIR="${PANEL_DIR:-/opt/custom-amp/custom-amp-ubuntu-panel/panel}"
EMAIL="${1:-${ADMIN_EMAIL:-dylanpage081@gmail.com}}"
PASSWORD="${2:-${ADMIN_PASSWORD:-dylanpage21}}"

if [[ ! -d "$PANEL_DIR" ]]; then
  echo "ERROR: Panel folder not found: $PANEL_DIR"
  echo "Usage: PANEL_DIR=/path/to/panel ./reset-admin.sh email password"
  exit 1
fi

cd "$PANEL_DIR"
if [[ ! -d node_modules/bcryptjs ]]; then
  npm install bcryptjs pg
fi

sudo node - "$PANEL_DIR" "$EMAIL" "$PASSWORD" <<'NODE'
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const panelDir = process.argv[2];
const email = process.argv[3];
const password = process.argv[4];
const bcrypt = require(path.join(panelDir, 'node_modules/bcryptjs'));
const envFile = path.join(panelDir, '.env');
const dbFile = path.join(panelDir, 'data/db.json');

function readEnv(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}
function updateState(state) {
  state = state || { users: [], nodes: [], servers: [], apiKeys: [], audit: [], plans: [] };
  state.users = state.users || [];
  let user = state.users.find(u => String(u.email || '').toLowerCase() === String(email).toLowerCase());
  if (!user) {
    user = { id: crypto.randomUUID(), email, name: 'Admin', role: 'admin', subdomainSlots: 999, createdAt: new Date().toISOString() };
    state.users.push(user);
  }
  user.email = email;
  user.name = 'Admin';
  user.role = 'admin';
  user.subdomainSlots = Number(user.subdomainSlots || 999);
  user.passwordHash = bcrypt.hashSync(password, 10);
  return state;
}
(async () => {
  let jsonUpdated = false;
  if (fs.existsSync(dbFile)) {
    let state = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    state = updateState(state);
    fs.writeFileSync(dbFile, JSON.stringify(state, null, 2));
    jsonUpdated = true;
  }
  const env = readEnv(envFile);
  if (env.DATABASE_URL) {
    const { Client } = require(path.join(panelDir, 'node_modules/pg'));
    const client = new Client({ connectionString: env.DATABASE_URL });
    await client.connect();
    await client.query("CREATE TABLE IF NOT EXISTS panel_state (id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1), state JSONB NOT NULL DEFAULT '{}'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
    const result = await client.query('SELECT state FROM panel_state WHERE id = 1');
    let state = result.rows[0] ? result.rows[0].state : { users: [], nodes: [], servers: [], apiKeys: [], audit: [], plans: [] };
    state = updateState(state);
    await client.query('INSERT INTO panel_state (id, state, updated_at) VALUES (1, $1, NOW()) ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()', [state]);
    await client.end();
    console.log('Updated PostgreSQL panel_state.');
  } else if (jsonUpdated) {
    console.log('Updated JSON db.json.');
  } else {
    console.log('No DATABASE_URL and no db.json found. Creating JSON db.json.');
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    fs.writeFileSync(dbFile, JSON.stringify(updateState({ users: [], nodes: [], servers: [], apiKeys: [], audit: [], plans: [] }), null, 2));
  }
  console.log('Admin login reset:');
  console.log('Email:', email);
  console.log('Password:', password);
})().catch(err => { console.error(err); process.exit(1); });
NODE

sudo systemctl restart custom-amp-panel 2>/dev/null || true
