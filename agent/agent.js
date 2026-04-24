require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const app = express();
const PORT = Number(process.env.PORT || 4100);
const AGENT_NAME = process.env.AGENT_NAME || 'Ubuntu Node';
const AGENT_LOCATION = process.env.AGENT_LOCATION || 'Unknown';
const AGENT_TOKEN = process.env.AGENT_TOKEN || 'change-this-agent-token';
const SERVERS_DIR = process.env.SERVERS_DIR || '/opt/custom-amp/servers';
const BACKUPS_DIR = process.env.BACKUPS_DIR || '/opt/custom-amp/backups';
const TMP_DIR = process.env.TMP_DIR || '/opt/custom-amp/tmp';
const DB_FILE = path.join(SERVERS_DIR, 'agent-db.json');
const MAX_CONSOLE_LINES = Number(process.env.MAX_CONSOLE_LINES || 5000);

for (const dir of [SERVERS_DIR, BACKUPS_DIR, TMP_DIR]) fs.mkdirSync(dir, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ servers: [] }, null, 2));

const upload = multer({ dest: TMP_DIR, limits: { fileSize: 1024 * 1024 * 1024 } });

function readDb() { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
function writeDb(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
function safeName(name) { return String(name || 'server').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 40); }
function id() { return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'); }
function getServer(serverId) { return readDb().servers.find(s => s.id === serverId); }
function serverBackupDir(server) { const dir = path.join(BACKUPS_DIR, server.id); fs.mkdirSync(dir, { recursive: true }); return dir; }
function safePath(base, requested = '') {
  const resolved = path.resolve(base, requested || '.');
  const root = path.resolve(base);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error('Invalid path.');
  return resolved;
}
function relPath(base, target) { return path.relative(base, target).replace(/\\/g, '/'); }

function docker(args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout, maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr || stdout || error.message));
      resolve({ stdout, stderr });
    });
  });
}
function run(cmd, args, timeout = 300000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
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

async function containerStats(containerName) {
  try {
    const out = await docker(['stats', '--no-stream', '--format', '{{json .}}', containerName], 30000);
    const raw = JSON.parse(out.stdout.trim());
    return {
      cpuPercent: raw.CPUPerc || '0%',
      memoryUsage: raw.MemUsage || '0B / 0B',
      memoryPercent: raw.MemPerc || '0%',
      netIO: raw.NetIO || '0B / 0B',
      blockIO: raw.BlockIO || '0B / 0B',
      pids: raw.PIDs || '0'
    };
  } catch (e) {
    return { error: e.message, cpuPercent: '0%', memoryUsage: '0B / 0B', memoryPercent: '0%' };
  }
}
async function folderUsageBytes(folder) {
  try {
    const out = await run('du', ['-sb', folder], 60000);
    return Number((out.stdout || '0').split(/\s+/)[0]) || 0;
  } catch {
    return 0;
  }
}
async function diskInfo(folder) {
  try {
    const out = await run('df', ['-PB1', folder], 60000);
    const lines = out.stdout.trim().split('\n');
    const parts = lines[1].split(/\s+/);
    return { filesystem: parts[0], sizeBytes: Number(parts[1]), usedBytes: Number(parts[2]), availableBytes: Number(parts[3]), usedPercent: parts[4] };
  } catch (e) {
    return { error: e.message };
  }
}
async function serverStats(server) {
  const usageBytes = await folderUsageBytes(server.folder);
  return {
    docker: await containerStats(server.containerName),
    storage: {
      usedBytes: usageBytes,
      limitMb: Number(server.storageLimitMb || 0),
      limitBytes: Number(server.storageLimitMb || 0) * 1024 * 1024,
      disk: await diskInfo(server.folder)
    }
  };
}
async function ensureStorageAvailable(server, extraBytes = 0) {
  const limitMb = Number(server.storageLimitMb || 0);
  if (!limitMb) return;
  const used = await folderUsageBytes(server.folder);
  const limit = limitMb * 1024 * 1024;
  if (used + extraBytes > limit) throw new Error(`Storage limit exceeded. Used ${Math.ceil(used / 1024 / 1024)}MB of ${limitMb}MB.`);
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        return downloadFile(new URL(response.headers.location, url).toString(), dest).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) return reject(new Error(`Download failed with HTTP ${response.statusCode}`));
      const file = fs.createWriteStream(dest);
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    });
    request.on('error', reject);
  });
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('dev'));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/health', auth, async (req, res) => {
  let dockerOk = true;
  let dockerVersion = 'unknown';
  try { dockerVersion = (await docker(['--version'])).stdout.trim(); } catch (e) { dockerOk = false; }
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
  const cpuLimit = Number(req.body.cpuLimit || 1);
  const storageLimitMb = Number(req.body.storageLimitMb || 10240);
  const ipAddress = req.body.ipAddress || '';
  const containerName = `amp-${safeName(name)}-${serverId.slice(0, 8)}`;
  const env = Object.assign({ EULA: 'TRUE', ENABLE_RCON: 'true', RCON_PASSWORD: 'minecraft' }, req.body.env || {});

  const args = ['run', '-d', '--name', containerName, '--restart', 'unless-stopped', '-m', `${memoryMb}m`, '--cpus', String(cpuLimit), '-p', `${port}:25565`, '-v', `${folder}:/data`];
  for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`);
  args.push(image);

  try {
    await docker(args);
    const server = { id: serverId, name, image, port, ipAddress, memoryMb, cpuLimit, storageLimitMb, containerName, folder, game: req.body.game || 'minecraft-paper', createdAt: new Date().toISOString() };
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
  for (const server of db.servers) servers.push(Object.assign({}, server, { state: await inspectContainer(server.containerName), stats: await serverStats(server) }));
  res.json({ servers });
});

app.get('/servers/:id', auth, async (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found.' });
  const state = await inspectContainer(server.containerName);
  let logs = '';
  try {
    const out = await docker(['logs', '--tail', String(MAX_CONSOLE_LINES), server.containerName]);
    logs = `${out.stdout || ''}${out.stderr || ''}`;
  } catch (e) { logs = e.message; }
  res.json({ server, state, stats: await serverStats(server), logs });
});

app.get('/servers/:id/logs', auth, async (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found.' });
  const lines = Math.min(Number(req.query.lines || MAX_CONSOLE_LINES), 50000);
  try {
    const out = await docker(['logs', '--tail', String(lines), server.containerName]);
    res.json({ logs: `${out.stdout || ''}${out.stderr || ''}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/servers/:id/stats', auth, async (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found.' });
  try { res.json({ stats: await serverStats(server), state: await inspectContainer(server.containerName), server }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/servers/:id/start', auth, async (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found.' });
  try { await docker(['start', server.containerName]); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/servers/:id/stop', auth, async (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found.' });
  try { await docker(['stop', server.containerName]); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/servers/:id/restart', auth, async (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found.' });
  try { await docker(['restart', server.containerName]); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/servers/:id/command', auth, async (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found.' });
  const command = String(req.body.command || '').trim();
  if (!command) return res.status(400).json({ error: 'Command is required.' });
  try { await docker(['exec', server.containerName, 'rcon-cli', command]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message + ' Make sure RCON is enabled.' }); }
});

app.get('/servers/:id/files', auth, (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found.' });
  try {
    const dir = safePath(server.folder, req.query.path || '');
    const items = fs.readdirSync(dir, { withFileTypes: true }).map(d => {
      const full = path.join(dir, d.name);
      const stat = fs.statSync(full);
      return { name: d.name, path: relPath(server.folder, full), type: d.isDirectory() ? 'dir' : 'file', size: stat.size, modifiedAt: stat.mtime.toISOString() };
    }).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    res.json({ path: relPath(server.folder, dir), parent: relPath(server.folder, path.dirname(dir)), items });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/servers/:id/files/download', auth, (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found.' });
  try {
    const file = safePath(server.folder, req.query.path || '');
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.status(400).json({ error: 'File not found.' });
    res.download(file);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/servers/:id/files/upload', auth, upload.single('file'), async (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found.' });
  try {
    await ensureStorageAvailable(server, req.file ? req.file.size : 0);
    const dir = safePath(server.folder, req.body.path || '');
    fs.mkdirSync(dir, { recursive: true });
    const dest = safePath(dir, req.file.originalname);
    fs.renameSync(req.file.path, dest);
    res.json({ ok: true, path: relPath(server.folder, dest) });
  } catch (e) { if (req.file) fs.rmSync(req.file.path, { force: true }); res.status(400).json({ error: e.message }); }
});

app.post('/servers/:id/files/mkdir', auth, (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found.' });
  try { fs.mkdirSync(safePath(server.folder, path.join(req.body.path || '', req.body.name || 'new-folder')), { recursive: true }); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/servers/:id/files/delete', auth, (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found.' });
  try { fs.rmSync(safePath(server.folder, req.body.path || ''), { recursive: true, force: true }); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/servers/:id/files/edit', auth, (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found.' });
  try {
    const file = safePath(server.folder, req.query.path || '');
    if (fs.statSync(file).size > 1024 * 1024 * 2) return res.status(400).json({ error: 'File is too large to edit in browser.' });
    res.json({ path: relPath(server.folder, file), content: fs.readFileSync(file, 'utf8') });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/servers/:id/files/edit', auth, (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found.' });
  try { fs.writeFileSync(safePath(server.folder, req.body.path || ''), String(req.body.content || '')); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/servers/:id/backups', auth, (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found.' });
  const dir = serverBackupDir(server);
  const backups = fs.readdirSync(dir).filter(f => f.endsWith('.tar.gz')).map(name => {
    const stat = fs.statSync(path.join(dir, name));
    return { name, size: stat.size, createdAt: stat.mtime.toISOString() };
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ backups });
});
app.post('/servers/:id/backups', auth, async (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found.' });
  const name = `${safeName(server.name)}-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`;
  const backupPath = path.join(serverBackupDir(server), name);
  try { await run('tar', ['-czf', backupPath, '-C', server.folder, '.']); res.json({ ok: true, backup: { name } }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/servers/:id/backups/:name', auth, (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found.' });
  const file = safePath(serverBackupDir(server), req.params.name);
  if (!file.endsWith('.tar.gz')) return res.status(400).json({ error: 'Invalid backup.' });
  res.download(file);
});
app.post('/servers/:id/backups/delete', auth, (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found.' });
  try { fs.rmSync(safePath(serverBackupDir(server), req.body.name || ''), { force: true }); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/servers/:id/installer', auth, async (req, res) => {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found.' });
  const type = req.body.type === 'mod' ? 'mods' : 'plugins';
  const url = String(req.body.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Plugin/mod URL must start with http:// or https://.' });
  try {
    const parsed = new URL(url);
    const filename = path.basename(parsed.pathname) || `download-${Date.now()}.jar`;
    await ensureStorageAvailable(server, 1024 * 1024 * 200);
    const dir = safePath(server.folder, type);
    fs.mkdirSync(dir, { recursive: true });
    const dest = safePath(dir, filename);
    await downloadFile(url, dest);
    res.json({ ok: true, installedTo: relPath(server.folder, dest) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`${AGENT_NAME} agent running on port ${PORT}`));
