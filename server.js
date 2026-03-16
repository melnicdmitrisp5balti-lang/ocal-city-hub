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
      prefix        TEXT DEFAULT '',
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
    CREATE TABLE IF NOT EXISTS chat_messages (
      id         TEXT PRIMARY KEY,
      author     TEXT NOT NULL,
      text       TEXT DEFAULT '',
      file_url   TEXT,
      file_type  TEXT,
      voice_url  TEXT,
      voice_duration INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER,
      username   TEXT NOT NULL,
      role       TEXT NOT NULL,
      prefix     TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  await run("DELETE FROM sessions WHERE created_at < datetime('now','-30 days')");

  // Добавляем колонки если их нет (для существующих БД)
  try { await run("ALTER TABLE comments ADD COLUMN file_url TEXT"); } catch(e) {}
  try { await run("ALTER TABLE comments ADD COLUMN file_type TEXT"); } catch(e) {}
  try { await run("ALTER TABLE users ADD COLUMN prefix TEXT DEFAULT ''"); } catch(e) {}
  try { await run("ALTER TABLE users ADD COLUMN password_plain TEXT DEFAULT ''"); } catch(e) {}
  try { await run("ALTER TABLE topics ADD COLUMN pinned INTEGER DEFAULT 0"); } catch(e) {}
  try { await run("ALTER TABLE topics ADD COLUMN sort_order INTEGER DEFAULT 0"); } catch(e) {}
  // Init sort_order for existing topics
  try {
    const tops = await q("SELECT id FROM topics ORDER BY created_at ASC");
    for (let i = 0; i < tops.length; i++) {
      await run("UPDATE topics SET sort_order=? WHERE id=? AND sort_order=0", [i+1, tops[i].id]);
    }
  } catch(e) {}
  try { await run("ALTER TABLE users ADD COLUMN prefix_color TEXT DEFAULT ''"); } catch(e) {}
  try { await run("ALTER TABLE sessions ADD COLUMN prefix_color TEXT DEFAULT ''"); } catch(e) {}
  try { await run("ALTER TABLE users ADD COLUMN prefix_style TEXT DEFAULT 'solid'"); } catch(e) {}
  try { await run("UPDATE users SET prefix_style='solid' WHERE prefix_style IS NULL OR prefix_style=''"); } catch(e) {}
  try { await run("ALTER TABLE sessions ADD COLUMN prefix_style TEXT DEFAULT 'solid'"); } catch(e) {}
  try { await run("ALTER TABLE users ADD COLUMN prefix_color2 TEXT DEFAULT ''"); } catch(e) {}
  try { await run("ALTER TABLE sessions ADD COLUMN prefix TEXT DEFAULT ''"); } catch(e) {}
  const guestSetting = await q1("SELECT value FROM settings WHERE key='guests_allowed'");
  if (!guestSetting) await run("INSERT INTO settings (key,value) VALUES ('guests_allowed','1')");
  try { await run("ALTER TABLE users ADD COLUMN prefix TEXT DEFAULT ''"); } catch(e) {}
  try { await run("ALTER TABLE users ADD COLUMN password_plain TEXT DEFAULT ''"); } catch(e) {}
  try { await run("ALTER TABLE topics ADD COLUMN pinned INTEGER DEFAULT 0"); } catch(e) {}
  try { await run("ALTER TABLE topics ADD COLUMN sort_order INTEGER DEFAULT 0"); } catch(e) {}
  // Init sort_order for existing topics
  try {
    const tops = await q("SELECT id FROM topics ORDER BY created_at ASC");
    for (let i = 0; i < tops.length; i++) {
      await run("UPDATE topics SET sort_order=? WHERE id=? AND sort_order=0", [i+1, tops[i].id]);
    }
  } catch(e) {}
  try { await run("ALTER TABLE users ADD COLUMN prefix_color TEXT DEFAULT ''"); } catch(e) {}
  try { await run("ALTER TABLE sessions ADD COLUMN prefix_color TEXT DEFAULT ''"); } catch(e) {}
  try { await run("ALTER TABLE users ADD COLUMN prefix_style TEXT DEFAULT 'solid'"); } catch(e) {}
  try { await run("UPDATE users SET prefix_style='solid' WHERE prefix_style IS NULL OR prefix_style=''"); } catch(e) {}
  try { await run("ALTER TABLE sessions ADD COLUMN prefix_style TEXT DEFAULT 'solid'"); } catch(e) {}
  try { await run("ALTER TABLE users ADD COLUMN prefix_color2 TEXT DEFAULT ''"); } catch(e) {}
  try { await run("ALTER TABLE sessions ADD COLUMN prefix TEXT DEFAULT ''"); } catch(e) {}
  // Default settings
  try { const gs = await q1("SELECT value FROM settings WHERE key='guests_allowed'"); if(!gs) await run("INSERT INTO settings(key,value) VALUES('guests_allowed','1')"); } catch(e) {}

  const pp = await q1("SELECT value FROM settings WHERE key='panel_password'");
  if (!pp) await run("INSERT INTO settings (key,value) VALUES ('panel_password',?)", [hashPw('panel123')]);
  const sp = await q1("SELECT value FROM settings WHERE key='site_password'");
  if (!sp) await run("INSERT INTO settings (key,value) VALUES ('site_password',?)", [hashPw('admin123')]);
  const dp = await q1("SELECT value FROM settings WHERE key='db_password'");
  if (!dp) await run("INSERT INTO settings (key,value) VALUES ('db_password',?)", [hashPw('db1234')]);

  const admin = await q1("SELECT id FROM users WHERE role='admin' LIMIT 1");
  if (!admin) {
    const spVal = await q1("SELECT value FROM settings WHERE key='site_password'");
    await run("INSERT OR IGNORE INTO users (username,password_hash,password_plain,role) VALUES ('admin',?,?,'admin')", [spVal.value, 'admin123']);
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
  await run("INSERT OR REPLACE INTO sessions (token,user_id,username,role,prefix) VALUES (?,?,?,?,?)",
    [token, user.id || null, user.username, user.role, user.prefix || '']);
  return token;
}
async function getSession(token) {
  if (!token) return null;
  const row = await q1("SELECT * FROM sessions WHERE token=?", [token]);
  if (!row) return null;
  return { userId: row.user_id, username: row.username, role: row.role, prefix: row.prefix || '' };
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

// DB password auth
app.post('/api/admin/db/auth', requireAdmin, async (req, res) => {
  try {
    const { password } = req.body;
    const dp = await getSetting('db_password');
    if (hashPw(password) !== dp) return res.status(401).json({ error: 'Неверный пароль БД' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Change DB password
app.post('/api/admin/db/change-password', requireAdmin, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Минимум 4 символа' });
    await setSetting('db_password', hashPw(newPassword));
    await addHistory(req.user.username, 'change_db_password', null, null);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/guest', async (req, res) => {
  try {
    const allowed = await getSetting('guests_allowed');
    if (allowed === '0') return res.status(403).json({ error: 'Вход для гостей отключён администратором' });
    const guestName = 'Гость_' + Math.random().toString(36).slice(2, 6).toUpperCase();
    const token = await createSession({ id: null, username: guestName, role: 'guest', prefix: '' });
    await addHistory(guestName, 'guest_login', null, null);
    res.json({ token, username: guestName, role: 'guest', prefix: '' });
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
    const result = await run("INSERT INTO users (username,password_hash,password_plain) VALUES (?,?,?)", [username.trim(), hashPw(password), password]);
    const insertId = Number(result.lastInsertRowid);
    await run("UPDATE invite_codes SET used=1, used_by=? WHERE code=?", [username.trim(), code.trim().toUpperCase()]);
    const user = await q1("SELECT * FROM users WHERE id=?", [insertId]);
    const token = await createSession(user);
    await addHistory(username.trim(), 'register', null, `Код: ${code.toUpperCase()}`);
    res.json({ token, username: user.username, role: user.role, prefix: user.prefix || '' });
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
    res.json({ token, username: user.username, role: user.role, prefix: user.prefix || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/logout', requireAuth, async (req, res) => {
  try { await deleteSession(req.headers['x-token']); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ username: req.user.username, role: req.user.role, prefix: req.user.prefix || '' });
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
    await run("UPDATE users SET password_hash=?, password_plain=? WHERE role='admin'", [h, newPassword]);
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

// Delete single invite
app.delete('/api/admin/invites/:id', requireAdmin, async (req, res) => {
  try {
    await run("DELETE FROM invite_codes WHERE id=?", [req.params.id]);
    await addHistory(req.user.username, 'delete_invite', null, null);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Clear all used invites
app.delete('/api/admin/invites/used', requireAdmin, async (req, res) => {
  try {
    const r = await run("DELETE FROM invite_codes WHERE used=1");
    await addHistory(req.user.username, 'clear_used_invites', null, null);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Clear ALL invites
app.delete('/api/admin/invites', requireAdmin, async (req, res) => {
  try {
    await run("DELETE FROM invite_codes");
    await addHistory(req.user.username, 'clear_all_invites', null, null);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try { res.json(await q("SELECT id,username,role,prefix,created_at FROM users ORDER BY created_at DESC")); }
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
    // Force logout the deleted user on all their connected clients
    io.emit('force_logout', { username: u.username });
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
    const rows = await q("SELECT * FROM topics ORDER BY pinned DESC, sort_order ASC, created_at DESC");
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


// ── Pin / Unpin topic ─────────────────────────────────────────────────────────
app.post('/api/topics/:id/pin', requireEditor, async (req, res) => {
  try {
    const t = await q1("SELECT * FROM topics WHERE id=?", [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Не найдено' });
    const newPinned = t.pinned ? 0 : 1;
    await run("UPDATE topics SET pinned=? WHERE id=?", [newPinned, req.params.id]);
    await addHistory(req.user.username, newPinned ? 'pin_topic' : 'unpin_topic', t.title, null);
    io.emit('topic_pinned', { id: req.params.id, pinned: newPinned });
    res.json({ ok: true, pinned: newPinned });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Move topic up / down ──────────────────────────────────────────────────────
app.post('/api/topics/:id/move', requireEditor, async (req, res) => {
  try {
    const { direction } = req.body; // 'up' or 'down'
    const all = await q("SELECT id, sort_order, pinned FROM topics ORDER BY pinned DESC, sort_order ASC, created_at DESC");
    const idx = all.findIndex(t => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Не найдено' });

    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= all.length) return res.json({ ok: true }); // already at edge

    const a = all[idx];
    const b = all[swapIdx];

    // Assign numeric sort_order if missing
    const orderA = Number(a.sort_order) || idx + 1;
    const orderB = Number(b.sort_order) || swapIdx + 1;

    await run("UPDATE topics SET sort_order=? WHERE id=?", [orderB, a.id]);
    await run("UPDATE topics SET sort_order=? WHERE id=?", [orderA, b.id]);

    const rows = await q("SELECT * FROM topics ORDER BY pinned DESC, sort_order ASC, created_at DESC");
    io.emit('topics_reordered', rows.map(t => ({ ...t, blocks: JSON.parse(t.blocks) })));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
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


// ─────────────────────────────────────────────────────────────────────────────
//  EXTRA ADMIN ROUTES
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/admin/guests-allowed', requireAdmin, async (req, res) => {
  try {
    const { allowed } = req.body;
    await setSetting('guests_allowed', allowed ? '1' : '0');
    await addHistory(req.user.username, 'guests_toggle', null, allowed ? 'Разрешены' : 'Запрещены');
    io.emit('settings_update', { guests_allowed: allowed ? '1' : '0' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  try {
    const ga = await getSetting('guests_allowed');
    res.json({ guests_allowed: ga !== '0' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/users/:id/prefix', requireAdmin, async (req, res) => {
  try {
    const { prefix, color, color2, style } = req.body;
    const clean      = (prefix || '').slice(0, 20);
    const cleanColor = (color  || '').slice(0, 30);
    const cleanColor2= (color2 || '').slice(0, 30);
    const validStyles = ['solid','glow','rgb','pulse','neon','fire','rainbow'];
    const cleanStyle = validStyles.includes(style) ? style : 'solid';
    const u = await q1("SELECT * FROM users WHERE id=?", [req.params.id]);
    if (!u) return res.status(404).json({ error: 'Не найден' });
    await run(
      "UPDATE users SET prefix=?, prefix_color=?, prefix_color2=?, prefix_style=? WHERE id=?",
      [clean, cleanColor, cleanColor2, cleanStyle, req.params.id]
    );
    await run(
      "UPDATE sessions SET prefix=?, prefix_color=?, prefix_style=? WHERE username=?",
      [clean, cleanColor, cleanStyle, u.username]
    );
    io.emit('user_prefix_updated', {
      username: u.username,
      prefix:   clean,
      color:    cleanColor,
      color2:   cleanColor2,
      style:    cleanStyle
    });
    await addHistory(req.user.username, 'set_prefix', u.username, clean ? `${clean} (${cleanStyle})` : '(убран)');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/chat', requireAdmin, async (req, res) => {
  try {
    await run("DELETE FROM chat_messages");
    await addHistory(req.user.username, 'clear_chat', null, null);
    io.emit('chat_cleared');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/chat/:id', requireAdmin, async (req, res) => {
  try {
    await run("DELETE FROM chat_messages WHERE id=?", [req.params.id]);
    io.emit('chat_msg_deleted', req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/history', requireAdmin, async (req, res) => {
  try {
    await run("DELETE FROM history");
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
//  CHAT
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/chat', async (req, res) => {
  try {
    const rows = await q("SELECT * FROM chat_messages ORDER BY created_at ASC LIMIT 200");
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chat', requireAuth, async (req, res) => {
  try {
    if (req.user.role === 'guest') return res.status(403).json({ error: 'Гости не могут писать в чат' });
    const { id, text, file_url, file_type, voice_url, voice_duration, created_at } = req.body;
    if (!text?.trim() && !file_url && !voice_url) return res.status(400).json({ error: 'Пустое сообщение' });
    const msgId = id || genId();
    const now = created_at || new Date().toLocaleString('ru-RU');
    await run(
      "INSERT INTO chat_messages (id,author,text,file_url,file_type,voice_url,voice_duration,created_at) VALUES (?,?,?,?,?,?,?,?)",
      [msgId, req.user.username, text?.trim()||'', file_url||null, file_type||null, voice_url||null, voice_duration||null, now]
    );
    const msg = { id: msgId, author: req.user.username, text: text?.trim()||'', file_url: file_url||null, file_type: file_type||null, voice_url: voice_url||null, voice_duration: voice_duration||null, created_at: now };
    io.emit('chat_message', msg);
    res.json(msg);
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// Toggle guests
app.post('/api/admin/guests-toggle', requireAdmin, async (req, res) => {
  try {
    const { allowed } = req.body;
    await setSetting('guests_allowed', allowed ? '1' : '0');
    io.emit('guests_setting', { allowed: allowed ? true : false });
    await addHistory(req.user.username, 'guests_toggle', null, allowed ? 'разрешены' : 'запрещены');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/guests-setting', requireAdmin, async (req, res) => {
  try {
    const val = await getSetting('guests_allowed');
    res.json({ allowed: val !== '0' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Set prefix for user
app.post('/api/admin/users/:id/prefix', requireAdmin, async (req, res) => {
  try {
    const { prefix, color, color2, style } = req.body;
    const clean = (prefix || '').slice(0, 20);
    const cleanColor = (color || '').slice(0, 30);
    const cleanColor2 = (color2 || '').slice(0, 30);
    const cleanStyle = ['solid','glow','rgb','pulse','neon','fire','rainbow'].includes(style) ? style : 'solid';
    const u = await q1("SELECT * FROM users WHERE id=?", [req.params.id]);
    if (!u) return res.status(404).json({ error: 'Не найден' });
    await run("UPDATE users SET prefix=?, prefix_color=?, prefix_color2=?, prefix_style=? WHERE id=?", [clean, cleanColor, cleanColor2, cleanStyle, req.params.id]);
    await run("UPDATE sessions SET prefix=?, prefix_color=?, prefix_style=? WHERE username=?", [clean, cleanColor, cleanStyle, u.username]);
    io.emit('user_prefix_updated', { username: u.username, prefix: clean, color: cleanColor, color2: cleanColor2, style: cleanStyle });
    await addHistory(req.user.username, 'set_prefix', u.username, clean || '(удалён)');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Clear chat history
app.delete('/api/admin/chat', requireAdmin, async (req, res) => {
  try {
    await run("DELETE FROM chat_messages");
    io.emit('chat_cleared');
    await addHistory(req.user.username, 'clear_chat', null, null);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Delete single chat message
app.delete('/api/admin/chat/:id', requireAdmin, async (req, res) => {
  try {
    await run("DELETE FROM chat_messages WHERE id=?", [req.params.id]);
    io.emit('chat_msg_deleted', req.params.id);
    await addHistory(req.user.username, 'delete_chat_msg', null, null);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Clear history log
app.delete('/api/admin/history', requireAdmin, async (req, res) => {
  try {
    await run("DELETE FROM history");
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get users with prefix (public endpoint for chat display)
app.get('/api/users/prefixes', async (req, res) => {
  try {
    const rows = await q("SELECT username, prefix, prefix_color, prefix_color2, prefix_style FROM users");
    const map = {};
    rows.forEach(r => { map[r.username] = { prefix: r.prefix||'', color: r.prefix_color||'', color2: r.prefix_color2||'', style: r.prefix_style||'solid' }; });
    res.json(map);
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ─────────────────────────────────────────────────────────────────────────────
//  DATABASE VIEWER ROUTES
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/admin/db/users', requireAdmin, async (req, res) => {
  try {
    const rows = await q(`SELECT
      id, username, role, prefix, prefix_style, prefix_color,
      created_at, password_plain, password_hash
      FROM users ORDER BY created_at DESC`);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/db/topics', requireAdmin, async (req, res) => {
  try {
    const rows = await q(`SELECT
      id, title, author, pinned, sort_order, created_at, updated_at
      FROM topics ORDER BY pinned DESC, sort_order ASC, created_at DESC`);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/db/comments', requireAdmin, async (req, res) => {
  try {
    const rows = await q(`SELECT
      id, topic_id, author, content, file_url, file_type, created_at
      FROM comments ORDER BY created_at DESC LIMIT 300`);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/db/chat', requireAdmin, async (req, res) => {
  try {
    const rows = await q(`SELECT
      id, author, text, file_url, file_type, voice_url, voice_duration, created_at
      FROM chat_messages ORDER BY created_at DESC LIMIT 300`);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/db/invites', requireAdmin, async (req, res) => {
  try {
    const rows = await q(`SELECT
      id, code, used, used_by, created_at
      FROM invite_codes ORDER BY created_at DESC`);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Session check ────────────────────────────────────────────────────────────
app.get('/api/me', requireAuth, (req, res) => {
  res.json({ username: req.user.username, role: req.user.role });
});

// ── AI Proxy (OpenRouter — бесплатные модели) ────────────────────────────────
app.post('/api/ai', requireAuth, async (req, res) => {
  try {
    const OR_KEY = process.env.OPENROUTER_API_KEY;
    if (!OR_KEY) return res.status(503).json({ error: 'AI не настроен. Добавьте OPENROUTER_API_KEY в переменные окружения.' });

    const { prompt } = req.body;
    if (!prompt?.trim()) return res.status(400).json({ error: 'Пустой запрос' });

    const systemPrompt = `Ты эксперт веб-разработчик. Верни ТОЛЬКО JSON без markdown и пояснений:
{"html":"...тело страницы без html/head/body тегов...","css":"...чистый css...","js":"...чистый js..."}
Требования: современный дизайн, тёмная тема, полностью рабочий код. Только JSON, ничего лишнего.`;

    const body = JSON.stringify({
      model: 'google/gemma-3-27b-it:free',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt.trim() }
      ],
      max_tokens: 8000,
      temperature: 0.7
    });

    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'openrouter.ai',
        path: '/api/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OR_KEY}`,
          'HTTP-Referer': 'https://starosta-hub.app',
          'X-Title': 'Starosta Hub',
          'Content-Length': Buffer.byteLength(body)
        }
      };
      const req2 = https.request(options, r => {
        let data = '';
        r.on('data', chunk => data += chunk);
        r.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch(e) { reject(new Error('Ошибка парсинга ответа')); }
        });
      });
      req2.on('error', reject);
      req2.write(body);
      req2.end();
    });

    if (result.error) return res.status(502).json({ error: result.error.message || 'Ошибка AI' });

    const text = result.choices?.[0]?.message?.content || '';
    if (!text) return res.status(502).json({ error: 'Пустой ответ от AI' });

    res.json({ text });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
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
