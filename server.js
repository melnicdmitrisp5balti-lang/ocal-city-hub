const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT DEFAULT 'user',
    created_at    TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS invite_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code       TEXT UNIQUE NOT NULL,
    used       INTEGER DEFAULT 0,
    used_by    TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS topics (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    blocks     TEXT NOT NULL,
    author     TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS comments (
    id         TEXT PRIMARY KEY,
    topic_id   TEXT NOT NULL,
    author     TEXT NOT NULL,
    content    TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    actor      TEXT NOT NULL,
    action     TEXT NOT NULL,
    target     TEXT,
    detail     TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// ── Settings ──────────────────────────────────────────────────────────────────
function getSetting(key) {
  return db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value || null;
}
function setSetting(key, val) {
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, val);
}
if (!getSetting('panel_password')) setSetting('panel_password', hashPw('panel123'));
if (!getSetting('site_password'))  setSetting('site_password',  hashPw('admin123'));

// Create default admin
if (!db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get()) {
  db.prepare("INSERT OR IGNORE INTO users (username,password_hash,role) VALUES ('admin',?,'admin')").run(getSetting('site_password'));
  console.log('Admin created: admin / admin123');
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function hashPw(pw) {
  return crypto.createHash('sha256').update(pw + 'lch_v2_salt').digest('hex');
}
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function addHistory(actor, action, target, detail) {
  db.prepare('INSERT INTO history (actor,action,target,detail) VALUES (?,?,?,?)').run(actor, action, target || null, detail || null);
}

// Roles that can create/edit topics
const EDITOR_ROLES = ['admin', 'editor'];

// ── Sessions ──────────────────────────────────────────────────────────────────
const sessions = new Map();
function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId: user.id, username: user.username, role: user.role });
  return token;
}
function getSession(token) { return token ? sessions.get(token) : null; }

// ── Middleware ────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const sess = getSession(req.headers['x-token']);
  if (!sess) return res.status(401).json({ error: 'Не авторизован' });
  req.user = sess; next();
}
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Только для администратора' });
    next();
  });
}
function requireEditor(req, res, next) {
  requireAuth(req, res, () => {
    if (!EDITOR_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Нет прав для этого действия' });
    next();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  AUTH ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// Panel password check
app.post('/api/panel/auth', requireAdmin, (req, res) => {
  const { password } = req.body;
  if (hashPw(password) !== getSetting('panel_password'))
    return res.status(401).json({ error: 'Неверный пароль панели' });
  res.json({ ok: true });
});

// Guest login — creates temporary session, no DB entry
app.post('/api/guest', (req, res) => {
  const guestName = 'Гость_' + Math.random().toString(36).slice(2, 6).toUpperCase();
  const fakeUser = { id: null, username: guestName, role: 'guest' };
  const token = createSession(fakeUser);
  addHistory(guestName, 'guest_login', null, null);
  res.json({ token, username: guestName, role: 'guest' });
});

// Register
app.post('/api/register', (req, res) => {
  const { username, password, code } = req.body;
  if (!username || !password || !code)
    return res.status(400).json({ error: 'Заполните все поля' });
  if (username.trim().length < 3)
    return res.status(400).json({ error: 'Имя минимум 3 символа' });
  if (password.length < 4)
    return res.status(400).json({ error: 'Пароль минимум 4 символа' });

  const invite = db.prepare("SELECT * FROM invite_codes WHERE code=? AND used=0").get(code.trim().toUpperCase());
  if (!invite) return res.status(400).json({ error: 'Неверный или использованный код' });

  if (db.prepare("SELECT id FROM users WHERE username=?").get(username.trim()))
    return res.status(400).json({ error: 'Имя пользователя занято' });

  const insertId = db.prepare("INSERT INTO users (username,password_hash) VALUES (?,?)").run(username.trim(), hashPw(password)).lastInsertRowid;
  db.prepare("UPDATE invite_codes SET used=1, used_by=? WHERE code=?").run(username.trim(), code.trim().toUpperCase());

  const user = db.prepare("SELECT * FROM users WHERE id=?").get(insertId);
  const token = createSession(user);
  addHistory(username.trim(), 'register', null, `Код: ${code.toUpperCase()}`);
  res.json({ token, username: user.username, role: user.role });
});

// Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE username=?").get(username?.trim());
  if (!user || user.password_hash !== hashPw(password))
    return res.status(401).json({ error: 'Неверный логин или пароль' });
  const token = createSession(user);
  addHistory(user.username, 'login', null, null);
  res.json({ token, username: user.username, role: user.role });
});

// Logout
app.post('/api/logout', requireAuth, (req, res) => {
  sessions.delete(req.headers['x-token']); res.json({ ok: true });
});

// Me
app.get('/api/me', requireAuth, (req, res) => {
  res.json({ username: req.user.username, role: req.user.role });
});

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// Change site password
app.post('/api/admin/change-site-password', requireAdmin, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 4)
    return res.status(400).json({ error: 'Пароль минимум 4 символа' });
  const h = hashPw(newPassword);
  setSetting('site_password', h);
  db.prepare("UPDATE users SET password_hash=? WHERE role='admin'").run(h);
  addHistory(req.user.username, 'change_site_password', null, null);
  res.json({ ok: true });
});

// Change panel password
app.post('/api/admin/change-panel-password', requireAdmin, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 4)
    return res.status(400).json({ error: 'Пароль минимум 4 символа' });
  setSetting('panel_password', hashPw(newPassword));
  addHistory(req.user.username, 'change_panel_password', null, null);
  res.json({ ok: true });
});

// Invite codes
app.post('/api/admin/invite', requireAdmin, (req, res) => {
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  db.prepare("INSERT INTO invite_codes (code) VALUES (?)").run(code);
  addHistory(req.user.username, 'create_invite', code, null);
  res.json({ code });
});
app.get('/api/admin/invites', requireAdmin, (req, res) => {
  res.json(db.prepare("SELECT * FROM invite_codes ORDER BY created_at DESC LIMIT 100").all());
});

// Users
app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json(db.prepare("SELECT id,username,role,created_at FROM users ORDER BY created_at DESC").all());
});
app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Не найден' });
  if (u.role === 'admin') return res.status(400).json({ error: 'Нельзя удалить администратора' });
  db.prepare("DELETE FROM users WHERE id=?").run(req.params.id);
  addHistory(req.user.username, 'delete_user', u.username, null);
  res.json({ ok: true });
});

// Change user role
app.post('/api/admin/users/:id/role', requireAdmin, (req, res) => {
  const { role } = req.body;
  const allowed = ['admin', 'editor', 'user'];
  if (!allowed.includes(role)) return res.status(400).json({ error: 'Недопустимая роль' });
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id);
  if (!u) return res.status(404).json({ error: 'Не найден' });
  db.prepare("UPDATE users SET role=? WHERE id=?").run(role, req.params.id);
  addHistory(req.user.username, 'change_role', u.username, `${u.role} → ${role}`);
  res.json({ ok: true });
});

// History
app.get('/api/admin/history', requireAdmin, (req, res) => {
  res.json(db.prepare("SELECT * FROM history ORDER BY created_at DESC LIMIT 300").all());
});

// ─────────────────────────────────────────────────────────────────────────────
//  TOPICS
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/topics', (req, res) => {
  const rows = db.prepare("SELECT * FROM topics ORDER BY created_at DESC").all();
  res.json(rows.map(t => ({ ...t, blocks: JSON.parse(t.blocks) })));
});

app.post('/api/topics', requireEditor, (req, res) => {
  const { title, blocks } = req.body;
  if (!title || !blocks?.length) return res.status(400).json({ error: 'Нет данных' });
  const id = genId();
  const now = new Date().toLocaleString('ru-RU');
  db.prepare("INSERT INTO topics (id,title,blocks,author,created_at,updated_at) VALUES (?,?,?,?,?,?)")
    .run(id, title, JSON.stringify(blocks), req.user.username, now, now);
  const topic = { id, title, blocks, author: req.user.username, created_at: now, updated_at: now };
  addHistory(req.user.username, 'create_topic', title, null);
  io.emit('topic_created', topic);
  res.json(topic);
});

app.put('/api/topics/:id', requireEditor, (req, res) => {
  const { title, blocks } = req.body;
  const old = db.prepare("SELECT * FROM topics WHERE id=?").get(req.params.id);
  if (!old) return res.status(404).json({ error: 'Не найдено' });
  const now = new Date().toLocaleString('ru-RU');
  db.prepare("UPDATE topics SET title=?,blocks=?,updated_at=? WHERE id=?")
    .run(title, JSON.stringify(blocks), now, req.params.id);
  const topic = { ...old, title, blocks, updated_at: now };
  addHistory(req.user.username, 'edit_topic', title, `Было: "${old.title}"`);
  io.emit('topic_updated', topic);
  res.json(topic);
});

app.delete('/api/topics/:id', requireEditor, (req, res) => {
  const t = db.prepare("SELECT * FROM topics WHERE id=?").get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Не найдено' });
  // Only admin can delete, editor can only edit
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Удалять может только администратор' });
  db.prepare("DELETE FROM topics WHERE id=?").run(req.params.id);
  db.prepare("DELETE FROM comments WHERE topic_id=?").run(req.params.id);
  addHistory(req.user.username, 'delete_topic', t.title, null);
  io.emit('topic_deleted', req.params.id);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
//  COMMENTS
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/topics/:id/comments', (req, res) => {
  res.json(db.prepare("SELECT * FROM comments WHERE topic_id=? ORDER BY created_at ASC").all(req.params.id));
});

app.post('/api/topics/:id/comments', requireAuth, (req, res) => {
  // Guests cannot comment
  if (req.user.role === 'guest') return res.status(403).json({ error: 'Гости не могут комментировать. Зарегистрируйтесь.' });
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'Пустой комментарий' });
  const topic = db.prepare("SELECT id,title FROM topics WHERE id=?").get(req.params.id);
  if (!topic) return res.status(404).json({ error: 'Тема не найдена' });
  const id = genId();
  const now = new Date().toLocaleString('ru-RU');
  const comment = { id, topic_id: req.params.id, author: req.user.username, content: content.trim(), created_at: now };
  db.prepare("INSERT INTO comments (id,topic_id,author,content,created_at) VALUES (?,?,?,?,?)").run(id, req.params.id, req.user.username, content.trim(), now);
  addHistory(req.user.username, 'comment', topic.title, content.trim().slice(0, 80));
  io.emit('comment_added', comment);
  res.json(comment);
});

app.delete('/api/comments/:id', requireAdmin, (req, res) => {
  const c = db.prepare("SELECT * FROM comments WHERE id=?").get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Не найдено' });
  db.prepare("DELETE FROM comments WHERE id=?").run(req.params.id);
  addHistory(req.user.username, 'delete_comment', c.author, c.content.slice(0, 60));
  io.emit('comment_deleted', req.params.id);
  res.json({ ok: true });
});

// ── Main page ─────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'intex.html')));

// ── Socket ────────────────────────────────────────────────────────────────────
io.on('connection', socket => console.log('connected:', socket.id));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
