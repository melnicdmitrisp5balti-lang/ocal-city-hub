const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@libsql/client');
const https = require('https');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname)));

// ── Database (Turso) ──────────────────────────────────────────────────────────
const db = createClient({
  url: process.env.TURSO_URL,
  authToken: process.env.TURSO_TOKEN,
});

// ── Cloudinary config ─────────────────────────────────────────────────────────
const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const API_KEY    = process.env.CLOUDINARY_API_KEY;
const API_SECRET = process.env.CLOUDINARY_API_SECRET;

// ── Helpers ───────────────────────────────────────────────────────────────────
function hashPw(pw) {
  return crypto.createHash('sha256').update(pw + 'lch_v2_salt').digest('hex');
}
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
async function q(sql, args = []) {
  const r = await db.execute({ sql, args });
  return r.rows;
}
async function q1(sql, args = []) {
  const rows = await q(sql, args);
  return rows[0] || null;
}
async function run(sql, args = []) {
  return await db.execute({ sql, args });
}
async function addHistory(actor, action, target, detail) {
  await run("INSERT INTO history (actor,action,target,detail) VALUES (?,?,?,?)",
    [actor, action, target || null, detail || null]);
}

const EDITOR_ROLES = ['admin', 'editor'];

// ── Init DB ───────────────────────────────────────────────────────────────────
async function initDB() {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT DEFAULT 'user',
      created_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS invite_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code       TEXT UNIQUE NOT NULL,
      used       INTEGER DEFAULT 0,
      used_by    TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS topics (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL,
      blocks     TEXT NOT NULL,
      author     TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS comments (
      id         TEXT PRIMARY KEY,
      topic_id   TEXT NOT NULL,
      author     TEXT NOT NULL,
      content    TEXT NOT NULL,
      file_url   TEXT,
      file_type  TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      actor      TEXT NOT NULL,
      action     TEXT NOT NULL,
      target     TEXT,
      detail     TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER,
      username   TEXT NOT NULL,
      role       TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  await run("DELETE FROM sessions WHERE created_at < datetime('now','-30 days')");

  // Добавляем колонки если их нет (для существующих БД)
  try { await run("ALTER TABLE comments ADD COLUMN file_url TEXT"); } catch(e) {}
  try { await run("ALTER TABLE comments ADD COLUMN file_type TEXT"); } catch(e) {}

  const pp = await q1("SELECT value FROM settings WHERE key='panel_password'");
  if (!pp) await run("INSERT INTO settings (key,value) VALUES ('panel_password',?)", [hashPw('panel123')]);
  const sp = await q1("SELECT value FROM settings WHERE key='site_password'");
  if (!sp) await run("INSERT INTO settings (key,value) VALUES ('site_password',?)", [hashPw('admin123')]);

  const admin = await q1("SELECT id FROM users WHERE role='admin' LIMIT 1");
  if (!admin) {
    const spVal = await q1("SELECT value FROM settings WHERE key='site_password'");
    await run("INSERT OR IGNORE INTO users (username,password_hash,role) VALUES ('admin',?,'admin')", [spVal.value]);
    console.log('Admin created: admin / admin123');
  }

  console.log('Turso DB connected and ready');
}

// ── Settings ──────────────────────────────────────────────────────────────────
async function getSetting(key) {
  const row = await q1("SELECT value FROM settings WHERE key=?", [key]);
  return row?.value || null;
}
async function setSetting(key, val) {
  await run("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, val]);
}

// ── Sessions ──────────────────────────────────────────────────────────────────
async function createSession(user) {
  const token = crypto.randomBytes(32).toString('hex');
  await run("INSERT OR REPLACE INTO sessions (token,user_id,username,role) VALUES (?,?,?,?)",
    [token, user.id || null, user.username, user.role]);
  return token;
}
async function getSession(token) {
  if (!token) return null;
  const row = await q1("SELECT * FROM sessions WHERE token=?", [token]);
  if (!row) return null;
  return { userId: row.user_id, username: row.username, role: row.role };
}
async function deleteSession(token) {
  await run("DELETE FROM sessions WHERE token=?", [token]);
}

// ── Middleware ────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  getSession(req.headers['x-token']).then(sess => {
    if (!sess) return res.status(401).json({ error: 'Не авторизован' });
    req.user = sess; next();
  }).catch(() => res.status(500).json({ error: 'Ошибка сервера' }));
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

// ── Cloudinary Upload ─────────────────────────────────────────────────────────
async function uploadToCloudinary(base64Data, resourceType = 'auto') {
  return new Promise((resolve, reject) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const folder = 'local-city-hub';
    // Подпись: параметры строго в алфавитном порядке (без file, api_key, resource_type)
    const signString = `folder=${folder}&timestamp=${timestamp}${API_SECRET}`;
    const signature = crypto.createHash('sha256').update(signString).digest('hex');

    const body = JSON.stringify({
      file: base64Data,
      timestamp,
      api_key: API_KEY,
      signature,
      folder,
    });

    const options = {
      hostname: 'api.cloudinary.com',
      path: `/v1_1/${CLOUD_NAME}/${resourceType}/upload`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.secure_url) resolve(parsed);
          else reject(new Error(parsed.error?.message || 'Cloudinary error'));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Upload endpoint ───────────────────────────────────────────────────────────
app.post('/api/upload', requireAuth, async (req, res) => {
  try {
    const { data, type } = req.body; // data = base64, type = mime type
    if (!data) return res.status(400).json({ error: 'Нет файла' });

    // Проверяем размер (макс 10MB)
    const sizeBytes = Buffer.byteLength(data, 'base64');
    if (sizeBytes > 10 * 1024 * 1024) return res.status(400).json({ error: 'Файл слишком большой (макс 10MB)' });

    const isImage = type?.startsWith('image/');
    const resourceType = isImage ? 'image' : 'raw';

    const result = await uploadToCloudinary(
      `data:${type};base64,${data}`,
      resourceType
    );

    res.json({ url: result.secure_url, type: isImage ? 'image' : 'file', original_type: type });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  AUTH ROUTES
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/panel/auth', requireAdmin, async (req, res) => {
  try {
    const { password } = req.body;
    const pp = await getSetting('panel_password');
    if (hashPw(password) !== pp) return res.status(401).json({ error: 'Неверный пароль панели' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/guest', async (req, res) => {
  try {
    const guestName = 'Гость_' + Math.random().toString(36).slice(2, 6).toUpperCase();
    const token = await createSession({ id: null, username: guestName, role: 'guest' });
    await addHistory(guestName, 'guest_login', null, null);
    res.json({ token, username: guestName, role: 'guest' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/register', async (req, res) => {
  try {
    const { username, password, code } = req.body;
    if (!username || !password || !code) return res.status(400).json({ error: 'Заполните все поля' });
    if (username.trim().length < 3) return res.status(400).json({ error: 'Имя минимум 3 символа' });
    if (password.length < 4) return res.status(400).json({ error: 'Пароль минимум 4 символа' });
    const invite = await q1("SELECT * FROM invite_codes WHERE code=? AND used=0", [code.trim().toUpperCase()]);
    if (!invite) return res.status(400).json({ error: 'Неверный или использованный код' });
    const existing = await q1("SELECT id FROM users WHERE username=?", [username.trim()]);
    if (existing) return res.status(400).json({ error: 'Имя пользователя занято' });
    const result = await run("INSERT INTO users (username,password_hash) VALUES (?,?)", [username.trim(), hashPw(password)]);
    const insertId = Number(result.lastInsertRowid);
    await run("UPDATE invite_codes SET used=1, used_by=? WHERE code=?", [username.trim(), code.trim().toUpperCase()]);
    const user = await q1("SELECT * FROM users WHERE id=?", [insertId]);
    const token = await createSession(user);
    await addHistory(username.trim(), 'register', null, `Код: ${code.toUpperCase()}`);
    res.json({ token, username: user.username, role: user.role });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await q1("SELECT * FROM users WHERE username=?", [username?.trim()]);
    if (!user || user.password_hash !== hashPw(password))
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    const token = await createSession(user);
    await addHistory(user.username, 'login', null, null);
    res.json({ token, username: user.username, role: user.role });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/logout', requireAuth, async (req, res) => {
  try { await deleteSession(req.headers['x-token']); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ username: req.user.username, role: req.user.role });
});

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN ROUTES
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/admin/change-site-password', requireAdmin, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Пароль минимум 4 символа' });
    const h = hashPw(newPassword);
    await setSetting('site_password', h);
    await run("UPDATE users SET password_hash=? WHERE role='admin'", [h]);
    await addHistory(req.user.username, 'change_site_password', null, null);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/change-panel-password', requireAdmin, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Пароль минимум 4 символа' });
    await setSetting('panel_password', hashPw(newPassword));
    await addHistory(req.user.username, 'change_panel_password', null, null);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/invite', requireAdmin, async (req, res) => {
  try {
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();
    await run("INSERT INTO invite_codes (code) VALUES (?)", [code]);
    await addHistory(req.user.username, 'create_invite', code, null);
    res.json({ code });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/invites', requireAdmin, async (req, res) => {
  try { res.json(await q("SELECT * FROM invite_codes ORDER BY created_at DESC LIMIT 100")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try { res.json(await q("SELECT id,username,role,created_at FROM users ORDER BY created_at DESC")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const u = await q1("SELECT * FROM users WHERE id=?", [req.params.id]);
    if (!u) return res.status(404).json({ error: 'Не найден' });
    if (u.role === 'admin') return res.status(400).json({ error: 'Нельзя удалить администратора' });
    await run("DELETE FROM users WHERE id=?", [req.params.id]);
    await run("DELETE FROM sessions WHERE username=?", [u.username]);
    await addHistory(req.user.username, 'delete_user', u.username, null);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/users/:id/role', requireAdmin, async (req, res) => {
  try {
    const { role } = req.body;
    const allowed = ['admin', 'editor', 'user'];
    if (!allowed.includes(role)) return res.status(400).json({ error: 'Недопустимая роль' });
    const u = await q1("SELECT * FROM users WHERE id=?", [req.params.id]);
    if (!u) return res.status(404).json({ error: 'Не найден' });
    await run("UPDATE users SET role=? WHERE id=?", [role, req.params.id]);
    await run("UPDATE sessions SET role=? WHERE username=?", [role, u.username]);
    await addHistory(req.user.username, 'change_role', u.username, `${u.role} → ${role}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/history', requireAdmin, async (req, res) => {
  try { res.json(await q("SELECT * FROM history ORDER BY created_at DESC LIMIT 300")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
//  TOPICS
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/topics', async (req, res) => {
  try {
    const rows = await q("SELECT * FROM topics ORDER BY created_at DESC");
    res.json(rows.map(t => ({ ...t, blocks: JSON.parse(t.blocks) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/topics', requireEditor, async (req, res) => {
  try {
    const { title, blocks } = req.body;
    if (!title || !blocks?.length) return res.status(400).json({ error: 'Нет данных' });
    const id = genId();
    const now = new Date().toLocaleString('ru-RU');
    await run("INSERT INTO topics (id,title,blocks,author,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      [id, title, JSON.stringify(blocks), req.user.username, now, now]);
    const topic = { id, title, blocks, author: req.user.username, created_at: now, updated_at: now };
    await addHistory(req.user.username, 'create_topic', title, null);
    io.emit('topic_created', topic);
    res.json(topic);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/topics/:id', requireEditor, async (req, res) => {
  try {
    const { title, blocks } = req.body;
    const old = await q1("SELECT * FROM topics WHERE id=?", [req.params.id]);
    if (!old) return res.status(404).json({ error: 'Не найдено' });
    const now = new Date().toLocaleString('ru-RU');
    await run("UPDATE topics SET title=?,blocks=?,updated_at=? WHERE id=?",
      [title, JSON.stringify(blocks), now, req.params.id]);
    const topic = { ...old, title, blocks, updated_at: now };
    await addHistory(req.user.username, 'edit_topic', title, `Было: "${old.title}"`);
    io.emit('topic_updated', topic);
    res.json(topic);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/topics/:id', requireEditor, async (req, res) => {
  try {
    const t = await q1("SELECT * FROM topics WHERE id=?", [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Не найдено' });
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Удалять может только администратор' });
    await run("DELETE FROM topics WHERE id=?", [req.params.id]);
    await run("DELETE FROM comments WHERE topic_id=?", [req.params.id]);
    await addHistory(req.user.username, 'delete_topic', t.title, null);
    io.emit('topic_deleted', req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
//  COMMENTS
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/topics/:id/comments', async (req, res) => {
  try {
    res.json(await q("SELECT * FROM comments WHERE topic_id=? ORDER BY created_at ASC", [req.params.id]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/topics/:id/comments', requireAuth, async (req, res) => {
  try {
    if (req.user.role === 'guest') return res.status(403).json({ error: 'Гости не могут комментировать. Зарегистрируйтесь.' });
    const { content, file_url, file_type } = req.body;
    if (!content?.trim() && !file_url) return res.status(400).json({ error: 'Пустой комментарий' });
    const topic = await q1("SELECT id,title FROM topics WHERE id=?", [req.params.id]);
    if (!topic) return res.status(404).json({ error: 'Тема не найдена' });
    const id = genId();
    const now = new Date().toLocaleString('ru-RU');
    const comment = { id, topic_id: req.params.id, author: req.user.username, content: content?.trim() || '', file_url: file_url || null, file_type: file_type || null, created_at: now };
    await run("INSERT INTO comments (id,topic_id,author,content,file_url,file_type,created_at) VALUES (?,?,?,?,?,?,?)",
      [id, req.params.id, req.user.username, content?.trim() || '', file_url || null, file_type || null, now]);
    await addHistory(req.user.username, 'comment', topic.title, (content?.trim() || '[файл]').slice(0, 80));
    io.emit('comment_added', comment);
    res.json(comment);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/comments/:id', requireAdmin, async (req, res) => {
  try {
    const c = await q1("SELECT * FROM comments WHERE id=?", [req.params.id]);
    if (!c) return res.status(404).json({ error: 'Не найдено' });
    await run("DELETE FROM comments WHERE id=?", [req.params.id]);
    await addHistory(req.user.username, 'delete_comment', c.author, c.content.slice(0, 60));
    io.emit('comment_deleted', req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Main page ─────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── Socket ────────────────────────────────────────────────────────────────────
io.on('connection', socket => console.log('connected:', socket.id));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB().then(() => {
  server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
