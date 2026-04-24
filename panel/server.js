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

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BRAND_NAME = process.env.BRAND_NAME || 'Custom AMP Panel';
const AGENT_TOKEN = process.env.PANEL_TO_AGENT_TOKEN || 'change-this-agent-token';
const TIMEOUT = Number(process.env.NODE_API_TIMEOUT_MS || 10000);

fs.mkdirSync(DATA_DIR, { recursive: true });

function defaultDb() {
  return {
    users: [],
    nodes: [],
    servers: [],
    audit: []
  };
}

function readDb() {
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify(defaultDb(), null, 2));
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

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
    db.users.push({
      id: uuidv4(),
      email,
      name: 'Admin',
      role: 'admin',
      passwordHash: await bcrypt.hash(password, 10),
      createdAt: new Date().toISOString()
    });
    writeDb(db);
    console.log(`Created admin user: ${email}`);
  }
}

function requireLogin(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  const db = readDb();
  const user = db.users.find(u => u.id === req.session.userId);
  if (!user || user.role !== 'admin') return res.status(403).render('error', { title: 'Forbidden', message: 'Admin access required.' });
  next();
}

function currentUser(req) {
  if (!req.session.userId) return null;
  return readDb().users.find(u => u.id === req.session.userId) || null;
}

async function callAgent(node, route, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const url = `${node.url.replace(/\/$/, '')}${route}`;
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AGENT_TOKEN}`
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Agent returned HTTP ${response.status}`);
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('dev'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax' }
}));
app.use(flash());
app.use((req, res, next) => {
  res.locals.brand = BRAND_NAME;
  res.locals.user = currentUser(req);
  res.locals.flash = { error: req.flash('error'), success: req.flash('success') };
  next();
});

app.get('/', (req, res) => req.session.userId ? res.redirect('/dashboard') : res.redirect('/login'));

app.get('/login', (req, res) => res.render('login', { title: 'Login' }));
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const db = readDb();
  const user = db.users.find(u => u.email.toLowerCase() === String(email || '').toLowerCase());
  if (!user || !(await bcrypt.compare(password || '', user.passwordHash))) {
    req.flash('error', 'Invalid email or password.');
    return res.redirect('/login');
  }
  req.session.userId = user.id;
  res.redirect('/dashboard');
});

app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

app.get('/dashboard', requireLogin, async (req, res) => {
  const db = readDb();
  const user = currentUser(req);
  const servers = user.role === 'admin' ? db.servers : db.servers.filter(s => s.ownerId === user.id);
  res.render('dashboard', { title: 'Dashboard', servers, nodes: db.nodes });
});

app.get('/servers/:id', requireLogin, async (req, res) => {
  const db = readDb();
  const user = currentUser(req);
  const server = db.servers.find(s => s.id === req.params.id);
  if (!server) return res.status(404).render('error', { title: 'Not Found', message: 'Server not found.' });
  if (user.role !== 'admin' && server.ownerId !== user.id) return res.status(403).render('error', { title: 'Forbidden', message: 'That server is not yours.' });
  const node = db.nodes.find(n => n.id === server.nodeId);
  let live = null;
  try { live = await callAgent(node, `/servers/${server.agentServerId}`); } catch (e) { live = { error: e.message }; }
  res.render('server', { title: server.name, server, node, live });
});

app.post('/servers/:id/action', requireLogin, async (req, res) => {
  const db = readDb();
  const user = currentUser(req);
  const server = db.servers.find(s => s.id === req.params.id);
  if (!server) return res.status(404).render('error', { title: 'Not Found', message: 'Server not found.' });
  if (user.role !== 'admin' && server.ownerId !== user.id) return res.status(403).render('error', { title: 'Forbidden', message: 'That server is not yours.' });
  const node = db.nodes.find(n => n.id === server.nodeId);
  const action = req.body.action;
  if (!['start', 'stop', 'restart'].includes(action)) {
    req.flash('error', 'Invalid action.');
    return res.redirect(`/servers/${server.id}`);
  }
  try {
    await callAgent(node, `/servers/${server.agentServerId}/${action}`, { method: 'POST' });
    req.flash('success', `${action} sent to agent.`);
    addAudit('server.action', { serverId: server.id, action, by: user.email });
  } catch (e) {
    req.flash('error', e.message);
  }
  res.redirect(`/servers/${server.id}`);
});

app.post('/servers/:id/command', requireLogin, async (req, res) => {
  const db = readDb();
  const user = currentUser(req);
  const server = db.servers.find(s => s.id === req.params.id);
  if (!server) return res.status(404).render('error', { title: 'Not Found', message: 'Server not found.' });
  if (user.role !== 'admin' && server.ownerId !== user.id) return res.status(403).render('error', { title: 'Forbidden', message: 'That server is not yours.' });
  const node = db.nodes.find(n => n.id === server.nodeId);
  try {
    await callAgent(node, `/servers/${server.agentServerId}/command`, { method: 'POST', body: { command: req.body.command } });
    req.flash('success', 'Command sent.');
  } catch (e) {
    req.flash('error', e.message);
  }
  res.redirect(`/servers/${server.id}`);
});

app.get('/admin', requireLogin, requireAdmin, (req, res) => {
  const db = readDb();
  res.render('admin', { title: 'Admin', db });
});

app.post('/admin/nodes', requireLogin, requireAdmin, (req, res) => {
  const db = readDb();
  db.nodes.push({ id: uuidv4(), name: req.body.name, url: req.body.url, location: req.body.location || 'Unknown', createdAt: new Date().toISOString() });
  writeDb(db);
  req.flash('success', 'Node added.');
  res.redirect('/admin');
});

app.post('/admin/users', requireLogin, requireAdmin, async (req, res) => {
  const db = readDb();
  if (db.users.some(u => u.email.toLowerCase() === String(req.body.email).toLowerCase())) {
    req.flash('error', 'User already exists.');
    return res.redirect('/admin');
  }
  db.users.push({ id: uuidv4(), email: req.body.email, name: req.body.name || req.body.email, role: req.body.role || 'user', passwordHash: await bcrypt.hash(req.body.password || 'ChangeMe123!', 10), createdAt: new Date().toISOString() });
  writeDb(db);
  req.flash('success', 'User created.');
  res.redirect('/admin');
});

app.post('/admin/servers', requireLogin, requireAdmin, async (req, res) => {
  const db = readDb();
  const node = db.nodes.find(n => n.id === req.body.nodeId);
  const owner = db.users.find(u => u.id === req.body.ownerId);
  if (!node || !owner) {
    req.flash('error', 'Pick a valid node and owner.');
    return res.redirect('/admin');
  }
  try {
    const created = await callAgent(node, '/servers', {
      method: 'POST',
      body: {
        name: req.body.name,
        game: req.body.game || 'minecraft-paper',
        image: req.body.image || 'itzg/minecraft-server:java21',
        memoryMb: Number(req.body.memoryMb || 2048),
        port: Number(req.body.port || 25565),
        env: {
          EULA: 'TRUE',
          TYPE: 'PAPER',
          VERSION: req.body.version || 'LATEST',
          MEMORY: `${Math.floor(Number(req.body.memoryMb || 2048) * 0.85)}M`
        }
      }
    });
    db.servers.push({
      id: uuidv4(),
      agentServerId: created.server.id,
      name: req.body.name,
      game: req.body.game || 'minecraft-paper',
      ownerId: owner.id,
      nodeId: node.id,
      memoryMb: Number(req.body.memoryMb || 2048),
      port: Number(req.body.port || 25565),
      createdAt: new Date().toISOString()
    });
    writeDb(db);
    req.flash('success', 'Server created on node.');
  } catch (e) {
    req.flash('error', e.message);
  }
  res.redirect('/admin');
});

app.get('/api/health', (req, res) => res.json({ ok: true, brand: BRAND_NAME, time: new Date().toISOString() }));

app.use((req, res) => res.status(404).render('error', { title: 'Not Found', message: 'Page not found.' }));

bootstrapAdmin().then(() => {
  app.listen(PORT, () => console.log(`${BRAND_NAME} running on http://localhost:${PORT}`));
});
