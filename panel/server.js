require('dotenv').config();

const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const helmet = require('helmet');
const morgan = require('morgan');
const bcrypt = require('bcryptjs');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const FormData = require('form-data');
const { URL } = require('url');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BRAND_NAME = process.env.BRAND_NAME || 'Custom AMP Panel';
const AGENT_TOKEN = process.env.PANEL_TO_AGENT_TOKEN || 'change-this-agent-token';
const TIMEOUT = Number(process.env.NODE_API_TIMEOUT_MS || 10000);

const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID || '';
const CLOUDFLARE_ROOT_DOMAIN = String(process.env.CLOUDFLARE_ROOT_DOMAIN || '').toLowerCase().replace(/^\.+|\.+$/g, '');
const CLOUDFLARE_PROXIED = String(process.env.CLOUDFLARE_PROXIED || 'false').toLowerCase() === 'true';

const API_PERMISSIONS = [
  { key: 'server:start', label: 'Start server' },
  { key: 'server:stop', label: 'Stop server' },
  { key: 'server:restart', label: 'Restart server' },
  { key: 'backup:create', label: 'Make a backup' },
  { key: 'backup:download', label: 'Download a backup' },
  { key: 'console:read', label: 'See console logs' },
  { key: 'console:command', label: 'Send server commands' },
  { key: 'servers:list', label: 'List servers for bots' },
  { key: 'provision:user', label: 'Website: create users' },
  { key: 'provision:server', label: 'Website: create servers' },
  { key: 'provision:plans', label: 'Website: use plan limits' },
  { key: 'server:split', label: 'Split Minecraft servers' }
];

function hashApiKey(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}
function makeApiKey() {
  return `cap_${crypto.randomBytes(32).toString('hex')}`;
}
function requireApiPermission(permission) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const raw = header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-api-key'] || req.query.apiKey || '');
    if (!raw) return res.status(401).json({ error: 'API key required.' });
    const db = readDb();
    const hash = hashApiKey(raw);
    const key = (db.apiKeys || []).find(k => k.hash === hash && !k.revokedAt);
    if (!key) return res.status(401).json({ error: 'Invalid API key.' });
    if (!key.permissions || !key.permissions.includes(permission)) return res.status(403).json({ error: `API key missing permission: ${permission}` });
    const user = db.users.find(u => u.id === key.userId);
    if (!user) return res.status(401).json({ error: 'API key user does not exist.' });
    key.lastUsedAt = new Date().toISOString();
    writeDb(db);
    req.apiUser = user;
    req.apiKey = key;
    next();
  };
}
function getApiServer(req, res) {
  const db = readDb();
  const server = db.servers.find(s => s.id === req.params.id || s.agentServerId === req.params.id);
  if (!server) { res.status(404).json({ error: 'Server not found.' }); return null; }
  if (req.apiUser.role !== 'admin' && server.ownerId !== req.apiUser.id) { res.status(403).json({ error: 'That server is not yours.' }); return null; }
  const node = db.nodes.find(n => n.id === server.nodeId);
  if (!node) { res.status(404).json({ error: 'Node missing.' }); return null; }
  return { db, server, node };
}

function isSplitEligibleMinecraft(server) {
  const game = String(server.game || '').toLowerCase();
  const type = String((server.env && server.env.TYPE) || '').toUpperCase();
  if (game === 'rust') return false;
  if (['VELOCITY','BUNGEECORD','WATERFALL'].includes(type)) return false;
  if (game.includes('velocity') || game.includes('bungee') || game.includes('waterfall')) return false;
  return game.startsWith('minecraft') || ['PAPER','PURPUR','FABRIC','FORGE','NEOFORGE','VANILLA','CUSTOM'].includes(type);
}
function normalizeProvisionLimits(body, plan) {
  const pick = (k, fallback) => Number(body[k] || (plan && plan[k]) || fallback);
  return {
    memoryMb: Math.max(1024, pick('memoryMb', 2048)),
    cpuLimit: Math.max(0.1, pick('cpuLimit', 1)),
    storageLimitMb: Math.max(1024, pick('storageLimitMb', 10240)),
    port: Number(body.port || 25565)
  };
}
async function searchModrinth(query, gameVersion) {
  const facets = JSON.stringify([["project_type:mod","project_type:plugin"]]);
  const url = `https://api.modrinth.com/v2/search?limit=8&query=${encodeURIComponent(query)}&facets=${encodeURIComponent(facets)}`;
  const r = await fetch(url, { headers: { 'User-Agent': `${BRAND_NAME}/1.0` } });
  if (!r.ok) throw new Error(`Modrinth search failed: HTTP ${r.status}`);
  const data = await r.json();
  const results = [];
  for (const hit of (data.hits || []).slice(0, 8)) {
    let installUrl = '';
    try {
      const loaders = encodeURIComponent(JSON.stringify(['paper','spigot','bukkit','purpur','fabric','forge','neoforge']));
      const versionsPart = gameVersion ? `&game_versions=${encodeURIComponent(JSON.stringify([gameVersion]))}` : '';
      const vr = await fetch(`https://api.modrinth.com/v2/project/${encodeURIComponent(hit.project_id)}/version?loaders=${loaders}${versionsPart}`, { headers: { 'User-Agent': `${BRAND_NAME}/1.0` } });
      if (vr.ok) {
        const versions = await vr.json();
        const primary = versions && versions[0] && ((versions[0].files || []).find(f => f.primary) || (versions[0].files || [])[0]);
        if (primary) installUrl = primary.url;
      }
    } catch {}
    results.push({
      source: 'Modrinth',
      type: hit.project_type === 'mod' ? 'mod' : 'plugin',
      name: hit.title,
      description: hit.description || '',
      iconUrl: hit.icon_url || '',
      projectUrl: `https://modrinth.com/${hit.project_type}/${hit.slug}`,
      installUrl
    });
  }
  return results;
}
async function searchSpiget(query) {
  const r = await fetch(`https://api.spiget.org/v2/search/resources/${encodeURIComponent(query)}?size=8&sort=-downloads`, { headers: { 'User-Agent': `${BRAND_NAME}/1.0` } });
  if (!r.ok) throw new Error(`Spiget search failed: HTTP ${r.status}`);
  const data = await r.json();
  return (Array.isArray(data) ? data : []).slice(0, 8).map(item => ({
    source: 'Spigot/Spiget',
    type: 'plugin',
    name: item.name,
    description: String(item.tag || item.description || '').replace(/<[^>]+>/g, '').slice(0, 180),
    iconUrl: item.icon && item.icon.url ? `https://www.spigotmc.org/${item.icon.url}` : '',
    projectUrl: `https://www.spigotmc.org/resources/${item.id}/`,
    installUrl: `https://api.spiget.org/v2/resources/${item.id}/download`
  }));
}
async function searchHangar(query) {
  const urls = [
    `https://hangar.papermc.io/api/v1/projects?query=${encodeURIComponent(query)}&limit=8&platform=PAPER`,
    `https://hangar.papermc.io/api/v1/projects?query=${encodeURIComponent(query)}&limit=8`
  ];
  let data = null;
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': `${BRAND_NAME}/1.0` } });
      if (r.ok) { data = await r.json(); break; }
    } catch {}
  }
  const items = data && (data.result || data.results || data.projects || data.items || []);
  return (Array.isArray(items) ? items : []).slice(0, 8).map(item => {
    const owner = item.owner || item.namespace?.owner || item.user || '';
    const slug = item.slug || item.name || item.namespace?.slug || item.namespace?.project;
    return {
      source: 'Hangar',
      type: 'plugin',
      name: item.name || slug,
      description: item.description || item.desc || '',
      iconUrl: item.avatarUrl || item.avatar || '',
      projectUrl: owner && slug ? `https://hangar.papermc.io/${owner}/${slug}` : 'https://hangar.papermc.io/',
      installUrl: ''
    };
  });
}


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


function gameTypeConfig(type) {
  const key = String(type || 'PAPER').toUpperCase();
  const map = {
    PAPER: { game: 'minecraft-paper', image: 'itzg/minecraft-server:java21', envType: 'PAPER', defaultPort: 25565 },
    PURPUR: { game: 'minecraft-purpur', image: 'itzg/minecraft-server:java21', envType: 'PURPUR', defaultPort: 25565 },
    FABRIC: { game: 'minecraft-fabric', image: 'itzg/minecraft-server:java21', envType: 'FABRIC', defaultPort: 25565 },
    FORGE: { game: 'minecraft-forge', image: 'itzg/minecraft-server:java21', envType: 'FORGE', defaultPort: 25565 },
    NEOFORGE: { game: 'minecraft-neoforge', image: 'itzg/minecraft-server:java21', envType: 'NEOFORGE', defaultPort: 25565 },
    VANILLA: { game: 'minecraft-vanilla', image: 'itzg/minecraft-server:java21', envType: 'VANILLA', defaultPort: 25565 },
    VELOCITY: { game: 'minecraft-velocity', image: 'itzg/mc-proxy', envType: 'VELOCITY', defaultPort: 25577 },
    BUNGEECORD: { game: 'minecraft-bungeecord', image: 'itzg/mc-proxy', envType: 'BUNGEECORD', defaultPort: 25577 },
    WATERFALL: { game: 'minecraft-waterfall', image: 'itzg/mc-proxy', envType: 'WATERFALL', defaultPort: 25577 },
    RUST: { game: 'rust', image: 'didstopia/rust-server:latest', envType: 'RUST', defaultPort: 28015 },
    CUSTOM: { game: 'minecraft-custom-jar', image: 'itzg/minecraft-server:java21', envType: 'CUSTOM', defaultPort: 25565 }
  };
  return map[key] || map.PAPER;
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });
const upload = multer({ dest: TMP_DIR, limits: { fileSize: 1024 * 1024 * 1024 } });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
const writeLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });

function defaultDb() { return { users: [], nodes: [], servers: [], audit: [], apiKeys: [], plans: [], websiteApiKeys: [] }; }
function readDb() {
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify(defaultDb(), null, 2));
  const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  data.apiKeys = data.apiKeys || [];
  data.plans = data.plans || [];
  data.websiteApiKeys = data.websiteApiKeys || [];
  data.users = data.users || [];
  data.nodes = data.nodes || [];
  data.servers = data.servers || [];
  for (const srv of (data.servers || [])) {
    srv.subusers = srv.subusers || [];
    srv.networkPorts = srv.networkPorts || [];
    srv.databases = srv.databases || [];
    srv.subdomains = srv.subdomains || [];
  }
  return data;
}
function mirrorDbToPostgres(db) {
  const databaseUrl = process.env.DATABASE_URL || '';
  if (!databaseUrl || process.env.POSTGRES_MIRROR === 'false') return;
  try {
    execFileSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE TABLE IF NOT EXISTS panel_state (id text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());'], { stdio: 'ignore', timeout: 10000 });
    execFileSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-c', `INSERT INTO panel_state (id, data, updated_at) VALUES ('main', '${JSON.stringify(db).replace(/'/g, "''")}'::jsonb, now()) ON CONFLICT (id) DO UPDATE SET data = excluded.data, updated_at = now();`], { stdio: 'ignore', timeout: 10000 });
  } catch (e) {
    if (process.env.DEBUG_POSTGRES_MIRROR === 'true') console.warn('PostgreSQL mirror failed:', e.message);
  }
}
function writeDb(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); mirrorDbToPostgres(db); }
function addAudit(action, details = {}) {
  const db = readDb();
  db.audit.unshift({ id: uuidv4(), action, details, subusers: [], networkPorts: [], databases: [], subdomains: [], createdAt: new Date().toISOString() });
  db.audit = db.audit.slice(0, 200);
  writeDb(db);
}
async function bootstrapAdmin() {
  const db = readDb();
  const email = process.env.ADMIN_EMAIL || 'admin@example.com';
  const password = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
  if (!db.users.some(u => u.email === email)) {
    db.users.push({ id: uuidv4(), email, name: 'Admin', role: 'admin', subdomainSlots: 999, passwordHash: await bcrypt.hash(password, 10), subusers: [], networkPorts: [], databases: [], subdomains: [], createdAt: new Date().toISOString() });
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
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'same-origin' }
}));
app.use(morgan('dev'));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  name: 'cap.sid',
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', maxAge: 1000 * 60 * 60 * 12 }
}));
app.use(flash());
app.use((req, res, next) => { res.locals.brand = BRAND_NAME; res.locals.user = currentUser(req); res.locals.flash = { error: req.flash('error'), success: req.flash('success') }; next(); });

app.get('/', (req, res) => req.session.userId ? res.redirect('/dashboard') : res.redirect('/login'));
app.get('/login', (req, res) => res.render('login', { title: 'Login' }));
app.post('/login', loginLimiter, async (req, res) => {
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
  res.render('api-keys', { title: 'API Keys', apiKeys, users: db.users, permissions: API_PERMISSIONS });
});

app.get('/servers/:id', requireLogin, async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  const filePath = req.query.path || '';
  let live = null, files = null, backups = null, plugins = null, mods = null, settings = null, ftp = null;
  try { live = await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}`); } catch (e) { live = { error: e.message }; }
  try { files = await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/files?path=${encodeURIComponent(filePath)}`); } catch (e) { files = { error: e.message, items: [], path: filePath, parent: '' }; }
  try { backups = await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/backups`); } catch (e) { backups = { error: e.message, backups: [] }; }
  try { plugins = await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/files?path=plugins`); } catch (e) { plugins = { error: e.message, items: [] }; }
  try { mods = await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/files?path=mods`); } catch (e) { mods = { error: e.message, items: [] }; }
  try { settings = await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/settings`); } catch (e) { settings = { error: e.message, settings: {} }; }
  try { ftp = await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/ftp`); } catch (e) { ftp = { error: e.message, enabled: false }; }
  res.render('server', { title: ctx.server.name, server: ctx.server, node: ctx.node, live, files, backups, plugins, mods, settings, filePath, pluginCatalog: PLUGIN_CATALOG, allUsers: ctx.db.users, ftp });
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
app.post('/servers/:id/files/upload', requireLogin, upload.array('files', 50), async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  const uploaded = req.files || [];
  try {
    if (!uploaded.length) throw new Error('Pick at least one file to upload.');
    const form = new FormData();
    form.append('path', req.body.path || '');
    if (req.body.extractZip) form.append('extractZip', 'true');
    if (req.body.deleteZipAfterExtract) form.append('deleteZipAfterExtract', 'true');
    for (const file of uploaded) form.append('files', fs.createReadStream(file.path), file.originalname);
    const response = await fetchAgent(ctx.node, `/servers/${ctx.server.agentServerId}/files/upload`, { method: 'POST', headers: form.getHeaders(), body: form, timeout: TIMEOUT * 60 });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Upload failed.');
    req.flash('success', `${uploaded.length} file(s) uploaded${req.body.extractZip ? ' and ZIPs extracted' : ''}.`);
  } catch (e) { req.flash('error', e.message); }
  finally { for (const file of uploaded) fs.rmSync(file.path, { force: true }); }
  res.redirect(`/servers/${ctx.server.id}${req.body.path ? `?path=${encodeURIComponent(req.body.path)}` : ''}#files`);
});

app.post('/servers/:id/files/unzip', requireLogin, async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  try {
    await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/files/unzip`, { method: 'POST', body: { path: req.body.path, destination: req.body.destination || '' }, timeout: TIMEOUT * 30 });
    req.flash('success', 'ZIP extracted.');
  } catch (e) { req.flash('error', e.message); }
  res.redirect(`/servers/${ctx.server.id}?path=${encodeURIComponent(req.body.currentPath || '')}#files`);
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


app.post('/servers/:id/saves/upload', requireLogin, writeLimiter, upload.single('save'), async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  try {
    const form = new FormData();
    form.append('worldName', req.body.worldName || 'world');
    form.append('mode', req.body.mode || 'new');
    form.append('save', fs.createReadStream(req.file.path), req.file.originalname);
    const response = await fetchAgent(ctx.node, `/servers/${ctx.server.agentServerId}/saves/upload`, { method: 'POST', headers: form.getHeaders(), body: form, timeout: TIMEOUT * 120 });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Save upload failed.');
    req.flash('success', `Save uploaded to ${data.path || data.world}. Restart the server if needed.`);
  } catch (e) { req.flash('error', e.message); }
  finally { if (req.file) fs.rmSync(req.file.path, { force: true }); }
  res.redirect(`/servers/${ctx.server.id}#saves`);
});


app.get('/servers/:id/saves/world/download', requireLogin, async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  const worldName = req.query.worldName || 'world';
  try {
    const response = await fetchAgent(ctx.node, `/servers/${ctx.server.agentServerId}/files/download?path=${encodeURIComponent(worldName)}`, { timeout: TIMEOUT * 60 });
    if (!response.ok) throw new Error((await response.text()) || `World download failed: HTTP ${response.status}`);
    res.setHeader('Content-Disposition', response.headers.get('content-disposition') || `attachment; filename="${worldName}.tar.gz"`);
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/gzip');
    response.body.pipe(res);
  } catch (e) { req.flash('error', e.message); res.redirect(`/servers/${ctx.server.id}#saves`); }
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
      serverType: req.body.serverType,
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
      simulationDistance: req.body.simulationDistance,
      customServerJar: req.body.customServerJar
    };
    await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/settings`, { method: 'POST', body: payload, timeout: TIMEOUT * 30 });
    req.flash('success', 'Server settings updated. Version changes recreate the container.');
  } catch (e) { req.flash('error', e.message); }
  res.redirect(`/servers/${ctx.server.id}#settings`);
});


app.get('/servers/:id/addons/search', requireLogin, async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  const query = String(req.query.q || '').trim();
  const source = String(req.query.source || 'all').toLowerCase();
  if (!query) return res.json({ results: [] });
  const gameVersion = String(req.query.version || '').trim();
  const tasks = [];
  if (source === 'all' || source === 'modrinth') tasks.push(searchModrinth(query, gameVersion).catch(e => [{ source: 'Modrinth', error: e.message }]));
  if (source === 'all' || source === 'hangar') tasks.push(searchHangar(query).catch(e => [{ source: 'Hangar', error: e.message }]));
  if (source === 'all' || source === 'spigot' || source === 'spiget') tasks.push(searchSpiget(query).catch(e => [{ source: 'Spigot/Spiget', error: e.message }]));
  const chunks = await Promise.all(tasks);
  res.json({ results: chunks.flat().slice(0, 24) });
});

app.post('/servers/:id/backups/restore', requireLogin, async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  try {
    await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/backups/restore`, { method: 'POST', body: { name: req.body.name }, timeout: TIMEOUT * 120 });
    req.flash('success', 'Backup restored. Server was restarted if it was online.');
  } catch (e) { req.flash('error', e.message); }
  res.redirect(`/servers/${ctx.server.id}#backups`);
});

app.get('/servers/:id/properties', requireLogin, async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  try {
    const data = await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/properties`);
    res.render('properties-edit', { title: `Edit server.properties`, server: ctx.server, content: data.content || '' });
  } catch (e) { req.flash('error', e.message); res.redirect(`/servers/${ctx.server.id}#settings`); }
});

app.post('/servers/:id/properties', requireLogin, async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  try {
    await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/properties`, { method: 'POST', body: { content: req.body.content || '' } });
    req.flash('success', 'server.properties saved. Restart the server if needed.');
  } catch (e) { req.flash('error', e.message); }
  res.redirect(`/servers/${ctx.server.id}/properties`);
});

app.post('/api-keys', requireLogin, (req, res) => {
  const db = readDb();
  const user = currentUser(req);
  const targetUserId = user.role === 'admin' && req.body.userId ? req.body.userId : user.id;
  const targetUser = db.users.find(u => u.id === targetUserId);
  if (!targetUser) { req.flash('error', 'User not found.'); return res.redirect('/api-keys'); }
  const permissions = Array.isArray(req.body.permissions) ? req.body.permissions : (req.body.permissions ? [req.body.permissions] : []);
  const allowed = API_PERMISSIONS.map(p => p.key);
  const cleanPermissions = permissions.filter(p => allowed.includes(p));
  const token = makeApiKey();
  db.apiKeys = db.apiKeys || [];
  db.apiKeys.push({
    id: uuidv4(),
    userId: targetUser.id,
    name: req.body.name || 'API Key',
    prefix: token.slice(0, 12),
    hash: hashApiKey(token),
    permissions: cleanPermissions,
    createdAt: new Date().toISOString(),
    lastUsedAt: null
  });
  writeDb(db);
  req.flash('success', `API key created. Copy it now: ${token}`);
  res.redirect('/api-keys');
});

app.post('/api-keys/:keyId/delete', requireLogin, (req, res) => {
  const db = readDb();
  const user = currentUser(req);
  const key = (db.apiKeys || []).find(k => k.id === req.params.keyId);
  if (!key) { req.flash('error', 'API key not found.'); return res.redirect('/api-keys'); }
  if (user.role !== 'admin' && key.userId !== user.id) { req.flash('error', 'You cannot delete that key.'); return res.redirect('/api-keys'); }
  key.revokedAt = new Date().toISOString();
  writeDb(db);
  req.flash('success', 'API key revoked.');
  res.redirect('/api-keys');
});

app.get('/api/v1/servers/:id/logs', requireApiPermission('console:read'), async (req, res) => {
  const ctx = getApiServer(req, res); if (!ctx) return;
  try { res.json(await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/logs?lines=${encodeURIComponent(req.query.lines || '5000')}`)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/v1/servers/:id/command', requireApiPermission('console:command'), async (req, res) => {
  const ctx = getApiServer(req, res); if (!ctx) return;
  try { res.json(await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/command`, { method: 'POST', body: { command: req.body.command } })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/v1/servers/:id/start', requireApiPermission('server:start'), async (req, res) => {
  const ctx = getApiServer(req, res); if (!ctx) return;
  try { res.json(await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/start`, { method: 'POST' })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/v1/servers/:id/stop', requireApiPermission('server:stop'), async (req, res) => {
  const ctx = getApiServer(req, res); if (!ctx) return;
  try { res.json(await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/stop`, { method: 'POST' })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/v1/servers/:id/restart', requireApiPermission('server:restart'), async (req, res) => {
  const ctx = getApiServer(req, res); if (!ctx) return;
  try { res.json(await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/restart`, { method: 'POST' })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/v1/servers/:id/backups', requireApiPermission('backup:create'), async (req, res) => {
  const ctx = getApiServer(req, res); if (!ctx) return;
  try { res.json(await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/backups`, { method: 'POST', timeout: TIMEOUT * 60 })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/v1/servers/:id/backups/:name', requireApiPermission('backup:download'), async (req, res) => {
  const ctx = getApiServer(req, res); if (!ctx) return;
  try {
    const response = await fetchAgent(ctx.node, `/servers/${ctx.server.agentServerId}/backups/${encodeURIComponent(req.params.name)}`, { timeout: TIMEOUT * 30 });
    if (!response.ok) throw new Error((await response.text()) || `Backup download failed: HTTP ${response.status}`);
    res.setHeader('Content-Disposition', response.headers.get('content-disposition') || `attachment; filename="${req.params.name}"`);
    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/gzip');
    response.body.pipe(res);
  } catch (e) { res.status(500).json({ error: e.message }); }
});



app.post('/servers/:id/subusers', requireLogin, async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  if (ctx.user.role !== 'admin' && ctx.server.ownerId !== ctx.user.id) { req.flash('error', 'Only the owner or admin can manage subusers.'); return res.redirect(`/servers/${ctx.server.id}#subusers`); }
  const target = ctx.db.users.find(u => u.id === req.body.userId || u.email === req.body.email);
  if (!target) { req.flash('error', 'User not found. Create the user first.'); return res.redirect(`/servers/${ctx.server.id}#subusers`); }
  ctx.server.subusers = ctx.server.subusers || [];
  if (!ctx.server.subusers.some(su => su.userId === target.id)) {
    ctx.server.subusers.push({ userId: target.id, permissions: Array.isArray(req.body.permissions) ? req.body.permissions : (req.body.permissions ? [req.body.permissions] : []), subusers: [], networkPorts: [], databases: [], subdomains: [], createdAt: new Date().toISOString() });
    writeDb(ctx.db);
  }
  req.flash('success', 'Subuser added.');
  res.redirect(`/servers/${ctx.server.id}#subusers`);
});
app.post('/servers/:id/subusers/remove', requireLogin, async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  ctx.server.subusers = (ctx.server.subusers || []).filter(su => su.userId !== req.body.userId);
  writeDb(ctx.db);
  req.flash('success', 'Subuser removed.');
  res.redirect(`/servers/${ctx.server.id}#subusers`);
});
app.post('/servers/:id/network/ports', requireLogin, async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  ctx.server.networkPorts = ctx.server.networkPorts || [];
  const port = Number(req.body.port);
  if (!port || port < 1 || port > 65535) { req.flash('error', 'Invalid port.'); return res.redirect(`/servers/${ctx.server.id}#network`); }
  if (!ctx.server.networkPorts.some(p => Number(p.port) === port)) ctx.server.networkPorts.push({ port, type: req.body.type || 'tcp', notes: req.body.notes || '', subusers: [], networkPorts: [], databases: [], subdomains: [], createdAt: new Date().toISOString() });
  writeDb(ctx.db);
  req.flash('success', 'Network port added to the server record. Add Docker port binding support before using it live.');
  res.redirect(`/servers/${ctx.server.id}#network`);
});
app.post('/servers/:id/network/ports/remove', requireLogin, async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  ctx.server.networkPorts = (ctx.server.networkPorts || []).filter(p => String(p.port) !== String(req.body.port));
  writeDb(ctx.db);
  req.flash('success', 'Network port removed.');
  res.redirect(`/servers/${ctx.server.id}#network`);
});
app.post('/servers/:id/databases', requireLogin, async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  ctx.server.databases = ctx.server.databases || [];
  const name = String(req.body.name || `${ctx.server.name}_db`).replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 48);
  ctx.server.databases.push({ id: uuidv4(), name, engine: req.body.engine || 'mysql', username: req.body.username || name, host: req.body.host || 'localhost', port: req.body.port || '3306', subusers: [], networkPorts: [], databases: [], subdomains: [], createdAt: new Date().toISOString() });
  writeDb(ctx.db);
  req.flash('success', 'Database record added. This stores DB details now; automatic DB server creation can be wired next.');
  res.redirect(`/servers/${ctx.server.id}#database`);
});
app.post('/servers/:id/databases/remove', requireLogin, async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  ctx.server.databases = (ctx.server.databases || []).filter(d => d.id !== req.body.databaseId);
  writeDb(ctx.db);
  req.flash('success', 'Database removed.');
  res.redirect(`/servers/${ctx.server.id}#database`);
});





function cloudflareEnabled() {
  return Boolean(CLOUDFLARE_API_TOKEN && CLOUDFLARE_ZONE_ID && CLOUDFLARE_ROOT_DOMAIN);
}
function isIpAddress(value) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(String(value || '').trim());
}
function normalizeSubdomain(hostname) {
  const clean = String(hostname || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/^\.+|\.+$/g, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(clean)) throw new Error('Enter a valid domain or subdomain.');
  if (CLOUDFLARE_ROOT_DOMAIN && !clean.endsWith(`.${CLOUDFLARE_ROOT_DOMAIN}`) && clean !== CLOUDFLARE_ROOT_DOMAIN) {
    throw new Error(`Subdomain must be inside ${CLOUDFLARE_ROOT_DOMAIN}.`);
  }
  return clean;
}
async function cloudflareApi(method, endpoint, body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    const message = data.errors && data.errors[0] ? data.errors[0].message : `Cloudflare HTTP ${response.status}`;
    throw new Error(message);
  }
  return data.result;
}
async function createCloudflareRecords({ hostname, target, port, serviceType }) {
  if (!cloudflareEnabled()) return { status: 'manual-dns-required', cloudflareEnabled: false };
  const dnsType = isIpAddress(target) ? 'A' : 'CNAME';
  const main = await cloudflareApi('POST', `/zones/${CLOUDFLARE_ZONE_ID}/dns_records`, {
    type: dnsType,
    name: hostname,
    content: target,
    ttl: 1,
    proxied: CLOUDFLARE_PROXIED
  });
  let srv = null;
  const svc = String(serviceType || 'java').toLowerCase();
  const makeSrv = async (service, proto, defaultPort) => cloudflareApi('POST', `/zones/${CLOUDFLARE_ZONE_ID}/dns_records`, {
    type: 'SRV',
    name: `${service}.${proto}.${hostname}`,
    data: { service, proto, name: hostname, priority: 0, weight: 5, port: Number(port), target: hostname },
    ttl: 1,
    proxied: false
  });
  if (svc === 'java' && Number(port) && Number(port) !== 25565) srv = await makeSrv('_minecraft', '_tcp', 25565);
  if (svc === 'bedrock' && Number(port) && Number(port) !== 19132) srv = await makeSrv('_minecraft', '_udp', 19132);
  // Rust generally uses A/CNAME plus visible port; no widely supported SRV fallback is created here.
  return { status: 'cloudflare-created', cloudflareEnabled: true, cloudflareRecordId: main.id, cloudflareSrvRecordId: srv ? srv.id : null, dnsType };
}
async function deleteCloudflareRecord(recordId) {
  if (!cloudflareEnabled() || !recordId) return;
  await cloudflareApi('DELETE', `/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${recordId}`);
}

app.post('/servers/:id/subdomains', requireLogin, async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  try {
    const hostname = normalizeSubdomain(req.body.hostname);
    const target = String(req.body.target || ctx.server.ipAddress || '').trim();
    const port = Number(req.body.port || ctx.server.port || 25565);
    if (!target) throw new Error('Target IP or hostname is required.');

    ctx.server.subdomains = ctx.server.subdomains || [];
    const owner = ctx.db.users.find(u => u.id === ctx.server.ownerId) || ctx.user;
    const slotLimit = Number(owner.subdomainSlots || 1);
    const usedSlots = ctx.db.servers.filter(s => s.ownerId === owner.id).reduce((total, srv) => total + ((srv.subdomains || []).length), 0);
    if (owner.role !== 'admin' && usedSlots >= slotLimit) throw new Error(`No subdomain slots left. Used ${usedSlots}/${slotLimit}. Ask an admin for more slots.`);

    const takenBy = ctx.db.servers.find(s => (s.subdomains || []).some(d => d.hostname === hostname));
    if (takenBy) throw new Error('That subdomain is taken by another server.');

    const serviceType = String(req.body.serviceType || (String(ctx.server.game || '').includes('rust') ? 'rust' : String(ctx.server.game || '').includes('bedrock') ? 'bedrock' : 'java')).toLowerCase();
    const cloudflare = await createCloudflareRecords({ hostname, target, port, serviceType });
    ctx.server.subdomains.push({
      id: uuidv4(),
      hostname,
      target,
      port,
      status: cloudflare.status,
      dnsType: cloudflare.dnsType || (isIpAddress(target) ? 'A' : 'CNAME'),
      serviceType,
      cloudflareRecordId: cloudflare.cloudflareRecordId || null,
      cloudflareSrvRecordId: cloudflare.cloudflareSrvRecordId || null,
      createdAt: new Date().toISOString()
    });
    writeDb(ctx.db);
    req.flash('success', cloudflare.cloudflareEnabled ? 'Subdomain created in Cloudflare.' : 'Subdomain saved. Add the DNS record manually or configure Cloudflare in panel/.env.');
  } catch (e) {
    req.flash('error', e.message);
  }
  res.redirect(`/servers/${ctx.server.id}#subdomains`);
});
app.post('/servers/:id/subdomains/remove', requireLogin, async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  const existing = (ctx.server.subdomains || []).find(d => d.id === req.body.subdomainId);
  try {
    if (existing) {
      await deleteCloudflareRecord(existing.cloudflareSrvRecordId);
      await deleteCloudflareRecord(existing.cloudflareRecordId);
    }
    ctx.server.subdomains = (ctx.server.subdomains || []).filter(d => d.id !== req.body.subdomainId);
    writeDb(ctx.db);
    req.flash('success', existing && existing.cloudflareRecordId ? 'Subdomain removed and Cloudflare DNS deleted.' : 'Subdomain removed from panel.');
  } catch (e) {
    req.flash('error', `Subdomain removed failed: ${e.message}`);
  }
  res.redirect(`/servers/${ctx.server.id}#subdomains`);
});

app.use('/api/', apiLimiter);
app.get('/api/servers', requireApiPermission('servers:list'), (req, res) => {
  const db = readDb();
  const servers = req.apiUser.role === 'admin' ? db.servers : db.servers.filter(s => s.ownerId === req.apiUser.id);
  res.json({ ok: true, servers: servers.map(s => ({ id: s.id, agentServerId: s.agentServerId, name: s.name, game: s.game, ipAddress: s.ipAddress, port: s.port, memoryMb: s.memoryMb, cpuLimit: s.cpuLimit, storageLimitMb: s.storageLimitMb })) });
});
app.get('/api/v1/servers', requireApiPermission('servers:list'), (req, res) => {
  const db = readDb();
  const servers = req.apiUser.role === 'admin' ? db.servers : db.servers.filter(s => s.ownerId === req.apiUser.id);
  res.json({ ok: true, servers: servers.map(s => ({ id: s.id, agentServerId: s.agentServerId, name: s.name, game: s.game, ipAddress: s.ipAddress, port: s.port, memoryMb: s.memoryMb, cpuLimit: s.cpuLimit, storageLimitMb: s.storageLimitMb })) });
});
app.post('/api/servers/:id/start', requireApiPermission('server:start'), async (req, res) => { const ctx = getApiServer(req, res); if (!ctx) return; try { res.json(await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/start`, { method: 'POST' })); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/servers/:id/stop', requireApiPermission('server:stop'), async (req, res) => { const ctx = getApiServer(req, res); if (!ctx) return; try { res.json(await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/stop`, { method: 'POST' })); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/servers/:id/restart', requireApiPermission('server:restart'), async (req, res) => { const ctx = getApiServer(req, res); if (!ctx) return; try { res.json(await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/restart`, { method: 'POST' })); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/servers/:id/logs', requireApiPermission('console:read'), async (req, res) => { const ctx = getApiServer(req, res); if (!ctx) return; try { res.json(await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/logs?lines=${encodeURIComponent(req.query.lines || '5000')}`)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/servers/:id/command', requireApiPermission('console:command'), async (req, res) => { const ctx = getApiServer(req, res); if (!ctx) return; try { res.json(await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/command`, { method: 'POST', body: { command: req.body.command } })); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/servers/:id/backups', requireApiPermission('backup:create'), async (req, res) => { const ctx = getApiServer(req, res); if (!ctx) return; try { res.json(await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/backups`, { method: 'POST', timeout: TIMEOUT * 60 })); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/servers/:id/backups', requireApiPermission('backup:download'), async (req, res) => { const ctx = getApiServer(req, res); if (!ctx) return; try { res.json(await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/backups`)); } catch (e) { res.status(500).json({ error: e.message }); } });

app.post('/api/v1/provision/order', requireApiPermission('provision:server'), async (req, res) => {
  const db = readDb();
  try {
    let user = db.users.find(u => u.email.toLowerCase() === String(req.body.email || '').toLowerCase());
    let plainPassword = null;
    if (!user) {
      if (!req.apiKey.permissions.includes('provision:user')) return res.status(403).json({ error: 'API key missing permission: provision:user' });
      plainPassword = req.body.password || crypto.randomBytes(8).toString('hex');
      user = { id: uuidv4(), email: req.body.email, name: req.body.name || req.body.email, role: 'user', passwordHash: await bcrypt.hash(plainPassword, 10), createdAt: new Date().toISOString() };
      db.users.push(user);
      writeDb(db);
    }
    const node = db.nodes.find(n => n.id === (req.body.nodeId || '')) || db.nodes[0];
    if (!node) return res.status(400).json({ error: 'No node exists. Add a node first.' });
    const plan = (db.plans || []).find(p => p.id === req.body.planId || p.name === req.body.planName) || null;
    const limits = normalizeProvisionLimits(req.body, plan);
    const memoryMb = limits.memoryMb;
    const cpuLimit = limits.cpuLimit;
    const storageLimitMb = limits.storageLimitMb;
    const port = limits.port;
    const ipAddress = req.body.ipAddress || node.publicIp || nodeHostFromUrl(node.url);
    const name = req.body.serverName || `${user.name || 'server'}-${Date.now()}`;
    const cfg = gameTypeConfig(req.body.gameType || req.body.serverType || req.body.type || 'PAPER');
    const created = await callAgent(node, '/servers', { method: 'POST', body: { name, game: cfg.game, image: req.body.image || cfg.image, memoryMb, cpuLimit, storageLimitMb, ipAddress, port, env: { EULA: 'TRUE', TYPE: cfg.envType, VERSION: req.body.gameVersion || req.body.version || 'LATEST', MEMORY: `${Math.floor(memoryMb * 0.85)}M`, ENABLE_RCON: 'true', RCON_PASSWORD: 'minecraft', MOTD: name, CUSTOM_SERVER: req.body.customServerJar ? (String(req.body.customServerJar).startsWith('/') ? req.body.customServerJar : `/data/${req.body.customServerJar}`) : undefined } }, timeout: TIMEOUT * 60 });
    const panelServer = { id: uuidv4(), agentServerId: created.server.id, name, game: cfg.game, ownerId: user.id, nodeId: node.id, memoryMb, cpuLimit, storageLimitMb, ipAddress, port, subusers: [], networkPorts: [], databases: [], subdomains: [], createdAt: new Date().toISOString(), orderId: req.body.orderId || null, planId: req.body.planId || null };
    db.servers.push(panelServer);
    writeDb(db);
    res.json({ ok: true, user: { id: user.id, email: user.email, created: !!plainPassword, password: plainPassword }, server: panelServer });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


app.get('/api/v1/plans', requireApiPermission('provision:plans'), (req, res) => { const db = readDb(); res.json({ ok: true, plans: db.plans || [] }); });
app.get('/api/v1/provision/health', requireApiPermission('provision:server'), (req, res) => {
  res.json({ ok: true, user: { id: req.apiUser.id, email: req.apiUser.email, role: req.apiUser.role }, permissions: req.apiKey.permissions || [] });
});
app.post('/api/v1/website/create-server', requireApiPermission('provision:server'), (req, res, next) => {
  req.url = '/api/v1/provision/order';
  next();
});




app.post('/servers/:id/split', requireLogin, writeLimiter, async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  const db = ctx.db; const server = ctx.server; const node = ctx.node;
  try {
    if (!isSplitEligibleMinecraft(server)) throw new Error('Only normal Minecraft servers can be split. Proxies and Rust cannot be split.');
    const splitMemoryMb = Number(req.body.memoryMb || 0);
    const splitCpu = Number(req.body.cpuLimit || 0);
    const splitStorageMb = Number(req.body.storageLimitMb || 0);
    if (splitMemoryMb < 1024) throw new Error('Split server must have at least 1024MB RAM.');
    if ((Number(server.memoryMb || 0) - splitMemoryMb) < 1024) throw new Error('The main server must keep at least 1024MB RAM.');
    if (splitCpu <= 0 || splitStorageMb < 1024) throw new Error('CPU must be over 0 and storage must be at least 1024MB.');
    if ((Number(server.cpuLimit || 0) - splitCpu) < 0.1) throw new Error('The main server does not have enough CPU to split.');
    if ((Number(server.storageLimitMb || 0) - splitStorageMb) < 1024) throw new Error('The main server must keep at least 1024MB storage.');
    const newName = String(req.body.name || `${server.name}-split`).trim();
    const port = Number(req.body.port || 0);
    if (!port) throw new Error('Pick a public port for the split server.');
    const cfg = gameTypeConfig(req.body.serverType || (server.env && server.env.TYPE) || 'PAPER');
    const created = await callAgent(node, '/servers', { method: 'POST', timeout: TIMEOUT * 60, body: {
      name: newName, game: cfg.game, image: cfg.image, memoryMb: splitMemoryMb, cpuLimit: splitCpu, storageLimitMb: splitStorageMb,
      ipAddress: node.publicIp || server.ipAddress || nodeHostFromUrl(node.url), port,
      env: { EULA: 'TRUE', TYPE: cfg.envType, VERSION: req.body.version || (server.env && server.env.VERSION) || 'LATEST', MEMORY: `${Math.floor(splitMemoryMb * 0.85)}M`, ENABLE_RCON: 'true', RCON_PASSWORD: 'minecraft', MOTD: newName }
    }});
    server.memoryMb = Number(server.memoryMb) - splitMemoryMb;
    server.cpuLimit = Number(server.cpuLimit) - splitCpu;
    server.storageLimitMb = Number(server.storageLimitMb) - splitStorageMb;
    try { await callAgent(node, `/servers/${server.agentServerId}/resources`, { method: 'POST', timeout: TIMEOUT * 10, body: { memoryMb: server.memoryMb, cpuLimit: server.cpuLimit, storageLimitMb: server.storageLimitMb, port: server.port } }); } catch (e) { req.flash('error', `Split server created, but resizing main server failed: ${e.message}`); }
    db.servers.push({ id: uuidv4(), agentServerId: created.server.id, name: newName, game: cfg.game, ownerId: server.ownerId, nodeId: node.id, memoryMb: splitMemoryMb, cpuLimit: splitCpu, storageLimitMb: splitStorageMb, ipAddress: node.publicIp || server.ipAddress || nodeHostFromUrl(node.url), port, subusers: [], networkPorts: [], databases: [], subdomains: [], parentServerId: server.id, createdAt: new Date().toISOString() });
    writeDb(db);
    req.flash('success', `Split server ${newName} created and resources removed from ${server.name}.`);
  } catch (e) { req.flash('error', e.message); }
  res.redirect(`/servers/${server.id}#split`);
});

app.post('/servers/:id/delete', requireLogin, async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  const confirmName = String(req.body.confirmName || '').trim();
  if (confirmName !== ctx.server.name) { req.flash('error', 'Server name confirmation did not match.'); return res.redirect(`/servers/${ctx.server.id}#settings`); }
  try {
    await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/delete`, { method: 'POST', timeout: TIMEOUT * 60 });
    ctx.db.servers = ctx.db.servers.filter(s => s.id !== ctx.server.id);
    writeDb(ctx.db);
    req.flash('success', 'Server deleted. Docker container, files, and backups were removed.');
    return res.redirect('/dashboard');
  } catch (e) { req.flash('error', e.message); return res.redirect(`/servers/${ctx.server.id}#settings`); }
});


app.get('/admin/import-docker/containers', requireLogin, requireAdmin, async (req, res) => {
  const db = readDb();
  const node = db.nodes.find(n => n.id === req.query.nodeId) || db.nodes[0];
  if (!node) return res.status(400).json({ error: 'Add a node first.' });
  try { res.json(await callAgent(node, '/docker/containers', { timeout: TIMEOUT * 3 })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/import-docker', requireLogin, requireAdmin, async (req, res) => {
  const db = readDb();
  const node = db.nodes.find(n => n.id === req.body.nodeId) || db.nodes[0];
  const owner = db.users.find(u => u.id === req.body.ownerId);
  if (!node || !owner) { req.flash('error', 'Pick a valid node and owner.'); return res.redirect('/admin#import'); }
  try {
    const imported = await callAgent(node, '/docker/import', { method: 'POST', timeout: TIMEOUT * 5, body: {
      container: req.body.container,
      name: req.body.name,
      serverType: req.body.serverType,
      memoryMb: req.body.memoryMb,
      cpuLimit: req.body.cpuLimit,
      storageLimitMb: req.body.storageLimitMb,
      port: req.body.port,
      ipAddress: req.body.ipAddress || node.publicIp || nodeHostFromUrl(node.url)
    }});
    const agentServer = imported.server;
    const existing = db.servers.find(s => s.agentServerId === agentServer.id || s.name === req.body.name);
    const panelRecord = {
      id: existing ? existing.id : uuidv4(),
      agentServerId: agentServer.id,
      name: req.body.name || agentServer.name,
      game: agentServer.game || `minecraft-${String(req.body.serverType || 'paper').toLowerCase()}`,
      ownerId: owner.id,
      nodeId: node.id,
      memoryMb: Number(req.body.memoryMb || agentServer.memoryMb || 2048),
      cpuLimit: Number(req.body.cpuLimit || agentServer.cpuLimit || 1),
      storageLimitMb: Number(req.body.storageLimitMb || agentServer.storageLimitMb || 10240),
      ipAddress: req.body.ipAddress || node.publicIp || nodeHostFromUrl(node.url),
      port: Number(req.body.port || agentServer.port || 25565),
      networkPorts: agentServer.networkPorts || [],
      subusers: [], databases: [], subdomains: [], imported: true,
      createdAt: existing ? existing.createdAt : new Date().toISOString()
    };
    if (existing) Object.assign(existing, panelRecord); else db.servers.push(panelRecord);
    writeDb(db);
    req.flash('success', 'Docker container imported into the panel.');
  } catch (e) { req.flash('error', e.message); }
  res.redirect('/admin#import');
});

app.post('/admin/servers/:id/resources', requireLogin, requireAdmin, async (req, res) => {
  const db = readDb();
  const server = db.servers.find(s => s.id === req.params.id);
  if (!server) { req.flash('error', 'Server not found.'); return res.redirect('/admin#resources'); }
  const node = db.nodes.find(n => n.id === server.nodeId);
  if (!node) { req.flash('error', 'Node not found.'); return res.redirect('/admin#resources'); }
  server.memoryMb = Number(req.body.memoryMb || server.memoryMb || 2048);
  server.cpuLimit = Number(req.body.cpuLimit || server.cpuLimit || 1);
  server.storageLimitMb = Number(req.body.storageLimitMb || server.storageLimitMb || 10240);
  if (req.body.port) server.port = Number(req.body.port);
  try { await callAgent(node, `/servers/${server.agentServerId}/resources`, { method: 'POST', timeout: TIMEOUT * 10, body: { memoryMb: server.memoryMb, cpuLimit: server.cpuLimit, storageLimitMb: server.storageLimitMb, port: server.port } }); }
  catch (e) { req.flash('error', `Saved in panel but agent failed to recreate container: ${e.message}`); }
  writeDb(db);
  req.flash('success', 'Server resources updated.');
  res.redirect('/admin#resources');
});


app.post('/servers/:id/ftp/reset', requireLogin, async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  try {
    const data = await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/ftp/reset`, { method: 'POST', timeout: TIMEOUT * 30 });
    req.flash('success', `SFTP user created. Username: ${data.ftp.username} Password: ${data.ftp.password}`);
  } catch (e) { req.flash('error', e.message); }
  res.redirect(`/servers/${ctx.server.id}#ftp`);
});

app.post('/servers/:id/ftp/disable', requireLogin, async (req, res) => {
  const ctx = getOwnedServer(req, res); if (ctx.error) return ctx.error();
  try { await callAgent(ctx.node, `/servers/${ctx.server.agentServerId}/ftp/disable`, { method: 'POST', timeout: TIMEOUT * 30 }); req.flash('success', 'SFTP access disabled.'); }
  catch (e) { req.flash('error', e.message); }
  res.redirect(`/servers/${ctx.server.id}#ftp`);
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
  db.users.push({ id: uuidv4(), email: req.body.email, name: req.body.name || req.body.email, role: req.body.role || 'user', subdomainSlots: Number(req.body.subdomainSlots || 1), passwordHash: await bcrypt.hash(req.body.password || 'ChangeMe123!', 10), subusers: [], networkPorts: [], databases: [], subdomains: [], createdAt: new Date().toISOString() });
  writeDb(db); req.flash('success', 'User created.'); res.redirect('/admin');
});

app.post('/admin/users/:id/resources', requireLogin, requireAdmin, (req, res) => {
  const db = readDb();
  const user = db.users.find(u => u.id === req.params.id);
  if (!user) { req.flash('error', 'User not found.'); return res.redirect('/admin#users'); }
  user.subdomainSlots = Math.max(0, Number(req.body.subdomainSlots || 0));
  writeDb(db);
  req.flash('success', 'User resource slots updated.');
  res.redirect('/admin#users');
});

app.post('/admin/servers', requireLogin, requireAdmin, async (req, res) => {
  const db = readDb();
  const node = db.nodes.find(n => n.id === req.body.nodeId);
  const owner = db.users.find(u => u.id === req.body.ownerId);
  if (!node || !owner) { req.flash('error', 'Pick a valid node and owner.'); return res.redirect('/admin'); }
  try {
    const plan = (db.plans || []).find(p => p.id === req.body.planId || p.name === req.body.planName) || null;
    const limits = normalizeProvisionLimits(req.body, plan);
    const memoryMb = limits.memoryMb;
    const cpuLimit = limits.cpuLimit;
    const storageLimitMb = limits.storageLimitMb;
    const port = limits.port;
    const ipAddress = req.body.ipAddress || node.publicIp || nodeHostFromUrl(node.url);
    const version = req.body.version || 'LATEST';
    const cfg = gameTypeConfig(req.body.serverType || req.body.type || 'PAPER');
    const image = req.body.image || cfg.image;
    const game = req.body.game || cfg.game;
    const created = await callAgent(node, '/servers', { method: 'POST', body: {
      name: req.body.name,
      game,
      image,
      memoryMb,
      cpuLimit,
      storageLimitMb,
      ipAddress,
      port,
      env: {
        EULA: 'TRUE',
        TYPE: cfg.envType,
        VERSION: version,
        MEMORY: `${Math.floor(memoryMb * 0.85)}M`,
        ENABLE_RCON: 'true',
        RCON_PASSWORD: 'minecraft',
        MOTD: req.body.name || 'Minecraft Server',
        CUSTOM_SERVER: req.body.customServerJar ? (String(req.body.customServerJar).startsWith('/') ? req.body.customServerJar : `/data/${req.body.customServerJar}`) : undefined
      }
    }});
    db.servers.push({ id: uuidv4(), agentServerId: created.server.id, name: req.body.name, game, ownerId: owner.id, nodeId: node.id, memoryMb, cpuLimit, storageLimitMb, ipAddress, port, subusers: [], networkPorts: [], databases: [], subdomains: [], createdAt: new Date().toISOString() });
    writeDb(db); req.flash('success', 'Server created on node.');
  } catch (e) { req.flash('error', e.message); }
  res.redirect('/admin');
});


app.post('/admin/plans', requireLogin, requireAdmin, (req, res) => {
  const db = readDb();
  db.plans = db.plans || [];
  db.plans.push({
    id: uuidv4(),
    name: req.body.name || 'New Plan',
    memoryMb: Number(req.body.memoryMb || 2048),
    cpuLimit: Number(req.body.cpuLimit || 1),
    storageLimitMb: Number(req.body.storageLimitMb || 10240),
    extraPorts: Number(req.body.extraPorts || 0),
    databases: Number(req.body.databases || 0),
    createdAt: new Date().toISOString()
  });
  writeDb(db);
  req.flash('success', 'Plan saved.');
  res.redirect('/admin#plans');
});

app.get('/api/health', (req, res) => res.json({ ok: true, brand: BRAND_NAME, time: new Date().toISOString() }));
app.use((req, res) => res.status(404).render('error', { title: 'Not Found', message: 'Page not found.' }));
bootstrapAdmin().then(() => app.listen(PORT, () => console.log(`${BRAND_NAME} running on http://localhost:${PORT}`)));
