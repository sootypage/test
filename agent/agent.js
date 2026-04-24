require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 4100);
const AGENT_NAME = process.env.AGENT_NAME || 'Ubuntu Node';
const AGENT_LOCATION = process.env.AGENT_LOCATION || 'Unknown';
const AGENT_TOKEN = process.env.AGENT_TOKEN || 'change-this-agent-token';
const SERVERS_DIR = process.env.SERVERS_DIR || '/opt/custom-amp/servers';
const DB_FILE = path.join(SERVERS_DIR, 'agent-db.json');
const MAX_CONSOLE_LINES = Number(process.env.MAX_CONSOLE_LINES || 300);

fs.mkdirSync(SERVERS_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ servers: [] }, null, 2));

function readDb() { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
function writeDb(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
function safeName(name) { return String(name || 'server').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 40); }
function id() { return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'); }

function docker(args) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout: 60000 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr || stdout || error.message));
      resolve({ stdout, stderr });
    });
  });
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token !== AGENT_TOKEN) return res.status(401).json({ error: 'Unauthorized agent token.' });
  next();
}

async function inspectContainer(containerName) {
  try {
    const out = await docker(['inspect', containerName, '--format', '{{json .State}}']);
    return JSON.parse(out.stdout.trim());
  } catch (e) {
    return { Status: 'missing', Running: false, error: e.message };
  }
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('dev'));
app.use(express.json({ limit: '2mb' }));

app.get('/health', auth, async (req, res) => {
  let dockerOk = true;
  let dockerVersion = 'unknown';
  try {
    dockerVersion = (await docker(['--version'])).stdout.trim();
  } catch (e) {
    dockerOk = false;
  }
  res.json({ ok: true, name: AGENT_NAME, location: AGENT_LOCATION, dockerOk, dockerVersion, time: new Date().toISOString() });
});

app.post('/servers', auth, async (req, res) => {
  const db = readDb();
  const serverId = id();
  const name = req.body.name || `server-${serverId.slice(0, 8)}`;
  const folder = path.join(SERVERS_DIR, `${safeName(name)}-${serverId.slice(0, 8)}`);
  fs.mkdirSync(folder, { recursive: true });

  const image = req.body.image || 'itzg/minecraft-server:java21';
  const port = Number(req.body.port || 25565);
  const memoryMb = Number(req.body.memoryMb || 2048);
  const containerName = `amp-${safeName(name)}-${serverId.slice(0, 8)}`;
  const env = Object.assign({ EULA: 'TRUE' }, req.body.env || {});

  const args = ['run', '-d', '--name', containerName, '--restart', 'unless-stopped', '-m', `${memoryMb}m`, '-p', `${port}:25565`, '-v', `${folder}:/data`];
  for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`);
  args.push(image);

  try {
    await docker(args);
    const server = { id: serverId, name, image, port, memoryMb, containerName, folder, game: req.body.game || 'minecraft-paper', createdAt: new Date().toISOString() };
    db.servers.push(server);
    writeDb(db);
    res.json({ ok: true, server });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/servers', auth, async (req, res) => {
  const db = readDb();
  const servers = [];
  for (const server of db.servers) {
    servers.push(Object.assign({}, server, { state: await inspectContainer(server.containerName) }));
  }
  res.json({ servers });
});

app.get('/servers/:id', auth, async (req, res) => {
  const db = readDb();
  const server = db.servers.find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found.' });
  const state = await inspectContainer(server.containerName);
  let logs = '';
  try { logs = (await docker(['logs', '--tail', String(MAX_CONSOLE_LINES), server.containerName])).stdout; } catch (e) { logs = e.message; }
  res.json({ server, state, logs });
});

app.post('/servers/:id/start', auth, async (req, res) => {
  const server = readDb().servers.find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found.' });
  try { await docker(['start', server.containerName]); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/servers/:id/stop', auth, async (req, res) => {
  const server = readDb().servers.find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found.' });
  try { await docker(['stop', server.containerName]); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/servers/:id/restart', auth, async (req, res) => {
  const server = readDb().servers.find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found.' });
  try { await docker(['restart', server.containerName]); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/servers/:id/command', auth, async (req, res) => {
  const server = readDb().servers.find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found.' });
  const command = String(req.body.command || '').trim();
  if (!command) return res.status(400).json({ error: 'Command is required.' });
  try {
    await docker(['exec', server.containerName, 'rcon-cli', command]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message + ' Make sure the container supports rcon-cli and RCON is enabled.' });
  }
});

app.listen(PORT, () => console.log(`${AGENT_NAME} agent running on port ${PORT}`));
