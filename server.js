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

// ── AI JSON parser (fixes invalid escapes from LLM output) ──────────────────
function parseAiJson(text) {
  try {
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    if (s === -1 || e <= s) return null;
    let slice = text.slice(s, e + 1);

    let out = '';
    let inStr = false;
    let i = 0;
    while (i < slice.length) {
      const c = slice[i];
      if (!inStr && c === '"') { inStr = true; out += c; i++; continue; }
      if (inStr) {
        if (c === '\\') {
          const n = slice[i + 1];
          if (!n) { i++; continue; }
          if (n === '"')  { out += '\\"';  i += 2; continue; }
          if (n === '\\') { out += '\\\\'; i += 2; continue; }
          if (n === 'n')  { out += '\\n';  i += 2; continue; }
          if (n === 'r')  { out += '\\r';  i += 2; continue; }
          if (n === 't')  { out += '\\t';  i += 2; continue; }
          if (n === '/')  { out += '/';    i += 2; continue; }
          if (n === 'u' && i + 5 < slice.length) { out += slice.slice(i, i+6); i += 6; continue; }
          // Invalid escape (e.g. \') — output the char without backslash
          out += n; i += 2; continue;
        }
        if (c === '"') { inStr = false; out += c; i++; continue; }
        if (c === '\n') { out += '\\n'; i++; continue; }
        if (c === '\r') { i++; continue; }
        if (c === '\t') { out += '\\t'; i++; continue; }
        out += c; i++; continue;
      }
      out += c; i++;
    }

    const parsed = JSON.parse(out);
    if (parsed && (parsed.html !== undefined || parsed.css !== undefined || parsed.js !== undefined)) {
      return JSON.stringify(parsed); // clean, valid JSON string
    }
    return null;
  } catch(e) {
    return null;
  }
}

// ── AI proxy (/api/ai — generate from scratch) ────────────────────────────────
app.post('/api/ai', requireAuth, async (req, res) => {
  try {
    const CF_TOKEN   = process.env.CF_API_TOKEN;
    const CF_ACCOUNT = process.env.CF_ACCOUNT_ID;
    if (!CF_TOKEN || !CF_ACCOUNT) return res.status(503).json({ error: 'AI не настроен. Добавьте CF_API_TOKEN и CF_ACCOUNT_ID.' });

    const { prompt } = req.body;
    if (!prompt?.trim()) return res.status(400).json({ error: 'Пустой запрос' });

    const sysPrompt = 'You are a web developer. Respond ONLY with a JSON object, no markdown, no explanation: {"html":"body content only","css":"styles only","js":"scripts only"}. Use dark theme, modern design. Escape all special chars properly in JSON strings.';

    const body = JSON.stringify({
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user',   content: prompt.trim() }
      ],
      max_tokens: 4096,
      stream: false
    });

    const result = await cfAiRequest(CF_ACCOUNT, CF_TOKEN, body);
    if (!result.success) return res.status(502).json({ error: result.errors?.[0]?.message || 'Cloudflare AI error' });

    const raw  = String(result.result?.response || '');
    const text = parseAiJson(raw) || raw;
    res.json({ text });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── AI chat (/api/ai-chat — with code context) ────────────────────────────────
app.post('/api/ai-chat', requireAuth, async (req, res) => {
  try {
    const CF_TOKEN   = process.env.CF_API_TOKEN;
    const CF_ACCOUNT = process.env.CF_ACCOUNT_ID;
    if (!CF_TOKEN || !CF_ACCOUNT) return res.status(503).json({ error: 'AI не настроен.' });

    const { messages, hasCode } = req.body;
    if (!messages?.length) return res.status(400).json({ error: 'Нет сообщений' });

    const sysPrompt = hasCode
      ? 'You are an expert web developer assistant. The user shares their HTML/CSS/JS code. For code tasks (create/fix/improve): respond ONLY with valid JSON {"html":"...","css":"...","js":"..."}. For questions: answer in Russian plain text. No markdown. In JSON values escape quotes as \\" and newlines as \\n.'
      : 'You are an expert web developer. For code creation: respond ONLY with JSON {"html":"...","css":"...","js":"..."}. For questions: answer in Russian. No markdown.';

    // Prepend system prompt to first message
    const cfMessages = messages.map((m, idx) => ({
      role: m.role,
      content: idx === 0 ? sysPrompt + '\n\n' + m.content : m.content
    }));

    const body = JSON.stringify({
      messages: cfMessages,
      max_tokens: 4096,
      stream: false
    });

    const result = await cfAiRequest(CF_ACCOUNT, CF_TOKEN, body);
    if (!result.success) return res.status(502).json({ error: result.errors?.[0]?.message || 'Cloudflare AI error' });

    const raw        = String(result.result?.response || '');
    const jsonText   = parseAiJson(raw);
    const text       = jsonText || raw;
    const hasCodeResp = !!jsonText;

    console.log('[AI-chat] hasCode:', hasCodeResp, '| preview:', text.slice(0, 80));
    res.json({ text, hasCode: hasCodeResp });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Shared Cloudflare AI request helper
function cfAiRequest(account, token, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.cloudflare.com',
      path: `/client/v4/accounts/${account}/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req2 = https.request(opts, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(new Error('CF parse error: ' + d.slice(0, 100))); }
      });
    });
    req2.on('error', reject);
    req2.write(body);
    req2.end();
  });
}

// ── Session check ────────────────────────────────────────────────────────────
app.get('/api/me', requireAuth, (req, res) => {
  res.json({ username: req.user.username, role: req.user.role });
});

// ── AI Proxy (Cloudflare Workers AI — 10000 запросов/день бесплатно) ──────────
app.post('/api/ai', requireAuth, async (req, res) => {
  try {
    const CF_TOKEN = process.env.CF_API_TOKEN;
    const CF_ACCOUNT = process.env.CF_ACCOUNT_ID;
    if (!CF_TOKEN || !CF_ACCOUNT) {
      return res.status(503).json({ error: 'AI не настроен. Добавьте CF_API_TOKEN и CF_ACCOUNT_ID в переменные окружения.' });
    }

    const { prompt } = req.body;
    if (!prompt?.trim()) return res.status(400).json({ error: 'Пустой запрос' });

    const systemPrompt = 'You are an expert web developer. You MUST respond with ONLY a valid JSON object. No text before or after. No markdown. Format exactly: {"html":"<content here>","css":"css here","js":"js here"}. Rules: HTML is body content only (no html/head/body tags). Separate HTML structure, CSS styles, and JS logic into their respective fields. Use proper indentation escaped as \\n. Create beautiful, fully working code with dark theme.';

    const cleanPrompt = prompt.trim().replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
    const body = JSON.stringify({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: cleanPrompt }
      ],
      max_tokens: 4096,
      stream: false
    });

    const result = await new Promise((resolve, reject) => {
      const path = `/client/v4/accounts/${CF_ACCOUNT}/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast`;
      const options = {
        hostname: 'api.cloudflare.com',
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CF_TOKEN}`,
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

    if (!result.success) {
      const errMsg = result.errors?.[0]?.message || 'Ошибка Cloudflare AI';
      return res.status(502).json({ error: errMsg });
    }

    let text = String(result.result?.response || '');
    if (!text) return res.status(502).json({ error: 'Пустой ответ от AI' });
    text = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
    text = cleanAiJson(text);
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
