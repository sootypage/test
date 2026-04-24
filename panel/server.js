require('dotenv').config();

const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const helmet = require('helmet');
const morgan = require('morgan');
const bcrypt = require('bcryptjs');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const FormData = require('form-data');
const { URL } = require('url');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BRAND_NAME = process.env.BRAND_NAME || 'Custom AMP Panel';
const AGENT_TOKEN = process.env.PANEL_TO_AGENT_TOKEN || 'change-this-agent-token';
const TIMEOUT = Number(process.env.NODE_API_TIMEOUT_MS || 10000);

const PLUGIN_CATALOG = [
  { type: 'plugin', name: 'LuckPerms', description: 'Permissions plugin for Minecraft servers.', url: 'https://download.luckperms.net/1565/bukkit/loader/LuckPerms-Bukkit-5.5.10.jar' },
  { type: 'plugin', name: 'ViaVersion', description: 'Allows newer versions to connect.', url: 'https://hangarcdn.papermc.io/plugins/ViaVersion/ViaVersion/versions/5.4.2/PAPER/ViaVersion-5.4.2.jar' },
  { type: 'plugin', name: 'ViaBackwards', description: 'Allows older versions to connect.', url: 'https://hangarcdn.papermc.io/plugins/ViaVersion/ViaBackwards/versions/5.4.2/PAPER/ViaBackwards-5.4.2.jar' },
  { type: 'plugin', name: 'SkinsRestorer', description: 'Restore and change skins on offline mode servers.', url: 'https://github.com/SkinsRestorer/SkinsRestorerX/releases/latest/download/SkinsRestorer.jar' },
  { type: 'plugin', name: 'EssentialsX', description: 'Modern essentials suite for Paper and Spigot.', url: 'https://github.com/EssentialsX/Essentials/releases/latest/download/EssentialsX.jar' },
  { type: 'plugin', name: 'Simple Tpa', description: 'Simple teleport request plugin.', url: 'https://github.com/May-2Beez/SimpleTpa/releases/latest/download/SimpleTpa.jar' },
  { type: 'mod', name: 'Fabric API', description: 'Core API dependency for Fabric mods.', url: 'https://cdn.modrinth.com/data/P7dR8mSH/versions/latest/Fabric-API.jar' },
  { type: 'mod', name: 'Sodium', description: 'Performance mod for Fabric.', url: 'https://cdn.modrinth.com/data/AANobbMI/versions/latest/Sodium.jar' }
];

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });
const upload = multer({ dest: TMP_DIR, limits: { fileSize: 1024 * 1024 * 1024 } });

function defaultDb() { return { users: [], nodes: [], servers: [], audit: [], apiKeys: [] }; }
function readDb() {
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify(defaultDb(), null, 2));
  const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  data.apiKeys = data.apiKeys || [];
  return data;
}
function writeDb(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
function addAudit(action, details = {}) {
  const db = readDb();
  db.audit.unshift({ id: uuidv4(), action, details, createdAt: new Date().toISOString() });
  db.audit = db.audit.slice(0, 200);
  writeDb(db);
}
async function bootstrapAdmin() {
  const db = readDb();
  const email = process.env.ADMIN_EMAIL || 'admin@example.com';
  const password = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
  if (!db.users.some(u => u.email === email)) {
    db.users.push({ id: uuidv4(), email, name: 'Admin', role: 'admin', passwordHash: await bcrypt.hash(password, 10), createdAt: new Date().toISOString() });
    writeDb(db);
    console.log(`Created admin user: ${email}`);
  }
}
function requireLogin(req, res, next) { if (!req.session.userId) return res.redirect('/login'); next(); }
function requireAdmin(req, res, next) {
  const user = currentUser(req);
  if (!user || user.role !== 'admin') return res.status(403).render('error', { title: 'Forbidden', message: 'Admin access required.' });
  next();
}
function currentUser(req) { if (!req.session.userId) return null; return readDb().users.find(u => u.id === req.session.userId) || null; }
function agentUrl(node, route) { return `${node.url.replace(/\/$/, '')}${route}`; }
function agentToken(node) { return node.token || AGENT_TOKEN; }
function nodeHostFromUrl(url) { try { return new URL(url).hostname; } catch { return ''; } }
async function callAgent(node, route, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || TIMEOUT);
  try {
    const headers = Object.assign({}, options.headers || {});
    if (!headers.Authorization) headers.Authorization = `Bearer ${agentToken(node)}`;
    if (!headers['Content-Type'] && options.body && !(options.body instanceof Buffer)) headers['Content-Type'] = 'application/json';
    const response = await fetch(agentUrl(node, route), {
      method: options.method || 'GET',
      headers,
      body: options.body && headers['Content-Type'] === 'application/json' ? JSON.stringify(options.body) : options.body,
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Agent returned HTTP ${response.status}`);
    return data;
  } finally { clearTimeout(timeout); }
}
async function fetchAgent(node, route, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || TIMEOUT * 10);
  try {
    const headers = Object.assign({ Authorization: `Bearer ${agentToken(node)}` }, options.headers || {});
    return await fetch(agentUrl(node, route), Object.assign({}, options, { headers, signal: controller.signal }));
  } finally { clearTimeout(timeout); }
}
function getOwnedServer(req, res) {
  const db = readDb();
  const user = currentUser(req);
  const server = db.servers.find(s => s.id === req.params.id);
  if (!server) return { error: () => res.status(404).render('error', { title: 'Not Found', message: 'Server not found.' }) };
  if (user.role !== 'admin' && server.ownerId !== user.id) return { error: () => res.status(403).render('error', { title: 'Forbidden', message: 'That server is not yours.' }) };
  const node = db.nodes.find(n => n.id === server.nodeId);
  if (!node) return { error: () => res.status(404).render('error', { title: 'Node missing', message: 'The node for this server is missing.' }) };
  return { db, user, server, node };
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('dev'));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({ secret: process.env.SESSION_SECRET || 'dev-secret-change-me', resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax' } }));
app.use(flash());
app.use((req, res, next) => { res.locals.brand = BRAND_NAME; res.locals.user = currentUser(req); res.locals.flash = { error: req.flash('error'), success: req.flash('success') }; next(); });

app.get('/', (req, res) => req.session.userId ? res.redirect('/dashboard') : res.redirect('/login'));
app.get('/login', (req, res) => res.render('login', { title: 'Login' }));
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = readDb().users.find(u => u.email.toLowerCase() === String(email || '').toLowerCase());
  if (!user || !(await bcrypt.compare(password || '', user.passwordHash))) { req.flash('error', 'Invalid email or password.'); return res.redirect('/login'); }
  req.session.userId = user.id;
  res.redirect('/dashboard');
});
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

app.get('/dashboard', requireLogin, (req, res) => {
  const db = readDb();
  const user = currentUser(req);
  const servers = user.role === 'admin' ? db.servers : db.servers.filter(s => s.ownerId === user.id);
  res.render('dashboard', { title: 'Dashboard', servers, nodes: db.nodes });
});

app.get('/api-keys', requireLogin, (req, res) => {
  const db = readDb();
  const user = currentUser(req);
  const apiKeys = db.apiKeys.filter(k => user.role === 'admin' || k.userId === user.id);
  res.render('api-keys', { title: 'API Keys', apiKeys });
});

app.get('/servers/:id', requireLogin, async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  const filePath = req.query.path || '';
  let live = null, files = null, backups = null, plugins = null, mods = null, settings = null;
  try { live = await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}`); } catch (e) { live = { error: e.message }; }
  try { files = await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/files?path=${encodeURIComponent(filePath)}`); } catch (e) { files = { error: e.message, items: [], path: filePath, parent: '' }; }
  try { backups = await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/backups`); } catch (e) { backups = { error: e.message, backups: [] }; }
  try { plugins = await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/files?path=plugins`); } catch (e) { plugins = { error: e.message, items: [] }; }
  try { mods = await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/files?path=mods`); } catch (e) { mods = { error: e.message, items: [] }; }
  try { settings = await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/settings`); } catch (e) { settings = { error: e.message, settings: {} }; }
  res.render('server', { title: ctx.server.name, server: ctx.server, node: ctx.node, live, files, backups, plugins, mods, settings, filePath, pluginCatalog: PLUGIN_CATALOG });
});

app.post('/servers/:id/action', requireLogin, async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  const action = req.body.action;
  if (!['start', 'stop', 'restart'].includes(action)) { req.flash('error', 'Invalid action.'); return res.redirect(`/servers/${ctx.server.id}`); }
  try { await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/${action}`, { method: 'POST' }); req.flash('success', `${action} sent to agent.`); addAudit('server.action', { serverId: ctx.server.id, action, by: ctx.user.email }); }
  catch (e) { req.flash('error', e.message); }
  res.redirect(`/servers/${ctx.server.id}`);
});
app.post('/servers/:id/command', requireLogin, async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  try { await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/command`, { method: 'POST', body: { command: req.body.command } }); req.flash('success', 'Command sent.'); }
  catch (e) { req.flash('error', e.message); }
  res.redirect(`/servers/${ctx.server.id}#console`);
});
app.get('/servers/:id/logs.json', requireLogin, async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  try { res.json(await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/logs?lines=${encodeURIComponent(req.query.lines || '5000')}`)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/servers/:id/stats.json', requireLogin, async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  try { res.json(await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/stats`)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/servers/:id/files/download', requireLogin, async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  try {
    const response = await fetchAgent(ctx.node, `/servers/${ctx.server.agentServerId}/files/download?path=${encodeURIComponent(req.query.path || '')}`);
    if (!response.ok) throw new Error((await response.text()) || `Download failed: HTTP ${response.status}`);
    res.setHeader('Content-Disposition', response.headers.get('content-disposition') || 'attachment');
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/octet-stream');
    response.body.pipe(res);
  } catch (e) { req.flash('error', e.message); res.redirect(`/servers/${ctx.server.id}`); }
});
app.post('/servers/:id/files/upload', requireLogin, upload.single('file'), async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  try {
    const form = new FormData();
    form.append('path', req.body.path || '');
    form.append('file', fs.createReadStream(req.file.path), req.file.originalname);
    const response = await fetchAgent(ctx.node, `/servers/${ctx.server.agentServerId}/files/upload`, { method: 'POST', headers: form.getHeaders(), body: form, timeout: TIMEOUT * 30 });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Upload failed.');
    req.flash('success', 'File uploaded.');
  } catch (e) { req.flash('error', e.message); }
  finally { if (req.file) fs.rmSync(req.file.path, { force: true }); }
  res.redirect(`/servers/${ctx.server.id}${req.body.path ? `?path=${encodeURIComponent(req.body.path)}` : ''}#files`);
});
app.post('/servers/:id/files/mkdir', requireLogin, async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  try { await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/files/mkdir`, { method: 'POST', body: { path: req.body.path || '', name: req.body.name || 'new-folder' } }); req.flash('success', 'Folder created.'); }
  catch (e) { req.flash('error', e.message); }
  res.redirect(`/servers/${ctx.server.id}?path=${encodeURIComponent(req.body.path || '')}#files`);
});
app.post('/servers/:id/files/delete', requireLogin, async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  try { await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/files/delete`, { method: 'POST', body: { path: req.body.path } }); req.flash('success', 'Deleted.'); }
  catch (e) { req.flash('error', e.message); }
  res.redirect(`/servers/${ctx.server.id}?path=${encodeURIComponent(req.body.currentPath || '')}#files`);
});
app.get('/servers/:id/files/edit', requireLogin, async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  try { const file = await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/files/edit?path=${encodeURIComponent(req.query.path || '')}`); res.render('file-edit', { title: `Edit ${file.path}`, server: ctx.server, file }); }
  catch (e) { req.flash('error', e.message); res.redirect(`/servers/${ctx.server.id}#files`); }
});
app.post('/servers/:id/files/edit', requireLogin, async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  try { await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/files/edit`, { method: 'POST', body: { path: req.body.path, content: req.body.content } }); req.flash('success', 'File saved.'); }
  catch (e) { req.flash('error', e.message); }
  res.redirect(`/servers/${ctx.server.id}/files/edit?path=${encodeURIComponent(req.body.path || '')}`);
});

app.post('/servers/:id/backups/create', requireLogin, async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  try { await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/backups`, { method: 'POST', timeout: TIMEOUT * 60 }); req.flash('success', 'Backup created.'); }
  catch (e) { req.flash('error', e.message); }
  res.redirect(`/servers/${ctx.server.id}#backups`);
});
app.get('/servers/:id/backups/:name', requireLogin, async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  try {
    const response = await fetchAgent(ctx.node, `/servers/${ctx.server.agentServerId}/backups/${encodeURIComponent(req.params.name)}`, { timeout: TIMEOUT * 30 });
    if (!response.ok) throw new Error((await response.text()) || `Backup download failed: HTTP ${response.status}`);
    res.setHeader('Content-Disposition', response.headers.get('content-disposition') || `attachment; filename="${req.params.name}"`);
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/gzip');
    response.body.pipe(res);
  } catch (e) { req.flash('error', e.message); res.redirect(`/servers/${ctx.server.id}#backups`); }
});
app.post('/servers/:id/backups/delete', requireLogin, async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  try { await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/backups/delete`, { method: 'POST', body: { name: req.body.name } }); req.flash('success', 'Backup deleted.'); }
  catch (e) { req.flash('error', e.message); }
  res.redirect(`/servers/${ctx.server.id}#backups`);
});

app.post('/servers/:id/installer', requireLogin, async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  try { await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/installer`, { method: 'POST', body: { type: req.body.type, url: req.body.url }, timeout: TIMEOUT * 30 }); req.flash('success', 'Plugin/mod installed. Restart the server if needed.'); }
  catch (e) { req.flash('error', e.message); }
  res.redirect(`/servers/${ctx.server.id}#addons`);
});

app.post('/servers/:id/settings', requireLogin, async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  try {
    const payload = {
      version: req.body.version,
      motd: req.body.motd,
      seed: req.body.seed,
      levelType: req.body.levelType,
      difficulty: req.body.difficulty,
      gameMode: req.body.gameMode,
      maxPlayers: req.body.maxPlayers,
      onlineMode: req.body.onlineMode === 'true',
      pvp: req.body.pvp === 'true',
      allowFlight: req.body.allowFlight === 'true',
      spawnProtection: req.body.spawnProtection,
      viewDistance: req.body.viewDistance,
      simulationDistance: req.body.simulationDistance
    };
    await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/settings`, { method: 'POST', body: payload, timeout: TIMEOUT * 30 });
    req.flash('success', 'Server settings updated. Version changes recreate the container.');
  } catch (e) { req.flash('error', e.message); }
  res.redirect(`/servers/${ctx.server.id}#settings`);
});

app.get('/admin', requireLogin, requireAdmin, (req, res) => { const db = readDb(); res.render('admin', { title: 'Admin', db }); });
app.post('/admin/nodes', requireLogin, requireAdmin, (req, res) => {
  const db = readDb();
  db.nodes.push({
    id: uuidv4(),
    name: req.body.name,
    url: req.body.url,
    publicIp: req.body.publicIp || nodeHostFromUrl(req.body.url || ''),
    token: req.body.token || '',
    location: req.body.location || 'Unknown',
    createdAt: new Date().toISOString()
  });
  writeDb(db);
  req.flash('success', 'Node added.');
  res.redirect('/admin');
});
app.post('/admin/users', requireLogin, requireAdmin, async (req, res) => {
  const db = readDb();
  if (db.users.some(u => u.email.toLowerCase() === String(req.body.email).toLowerCase())) { req.flash('error', 'User already exists.'); return res.redirect('/admin'); }
  db.users.push({ id: uuidv4(), email: req.body.email, name: req.body.name || req.body.email, role: req.body.role || 'user', passwordHash: await bcrypt.hash(req.body.password || 'ChangeMe123!', 10), createdAt: new Date().toISOString() });
  writeDb(db); req.flash('success', 'User created.'); res.redirect('/admin');
});
app.post('/admin/servers', requireLogin, requireAdmin, async (req, res) => {
  const db = readDb();
  const node = db.nodes.find(n => n.id === req.body.nodeId);
  const owner = db.users.find(u => u.id === req.body.ownerId);
  if (!node || !owner) { req.flash('error', 'Pick a valid node and owner.'); return res.redirect('/admin'); }
  try {
    const memoryMb = Number(req.body.memoryMb || 2048);
    const cpuLimit = Number(req.body.cpuLimit || 1);
    const storageLimitMb = Number(req.body.storageLimitMb || 10240);
    const port = Number(req.body.port || 25565);
    const ipAddress = req.body.ipAddress || node.publicIp || nodeHostFromUrl(node.url);
    const version = req.body.version || 'LATEST';
    const created = await callAgent(node, '/servers', { method: 'POST', body: {
      name: req.body.name,
      game: req.body.game || 'minecraft-paper',
      image: req.body.image || 'itzg/minecraft-server:java21',
      memoryMb,
      cpuLimit,
      storageLimitMb,
      ipAddress,
      port,
      env: {
        EULA: 'TRUE',
        TYPE: 'PAPER',
        VERSION: version,
        MEMORY: `${Math.floor(memoryMb * 0.85)}M`,
        ENABLE_RCON: 'true',
        RCON_PASSWORD: 'minecraft',
        MOTD: req.body.name || 'Minecraft Server'
      }
    }});
    db.servers.push({ id: uuidv4(), agentServerId: created.server.id, name: req.body.name, game: req.body.game || 'minecraft-paper', ownerId: owner.id, nodeId: node.id, memoryMb, cpuLimit, storageLimitMb, ipAddress, port, createdAt: new Date().toISOString() });
    writeDb(db); req.flash('success', 'Server created on node.');
  } catch (e) { req.flash('error', e.message); }
  res.redirect('/admin');
});

app.get('/api/health', (req, res) => res.json({ ok: true, brand: BRAND_NAME, time: new Date().toISOString() }));
app.use((req, res) => res.status(404).render('error', { title: 'Not Found', message: 'Page not found.' }));
bootstrapAdmin().then(() => app.listen(PORT, () => console.log(`${BRAND_NAME} running on http://localhost:${PORT}`)));
