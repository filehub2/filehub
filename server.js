'use strict';

const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const app = express();
const PORT = Number(process.env.PORT || 3001);
const SHARE_DIR = path.resolve(process.env.FILEHUB_SHARE_DIR || '/mnt/pendrive/FileHub/Compartilhados');
const DATA_DIR = path.resolve(process.env.FILEHUB_DATA_DIR || path.join(os.homedir(), '.filehub-data'));
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SETUP_TOKEN_FILE = path.join(DATA_DIR, 'setup-token.sha256');
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 20 * 1024 * 1024 * 1024); // 20 GiB
const MAX_FILES = Number(process.env.MAX_FILES || 300);
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const sessions = new Map();
const loginAttempts = new Map();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');
const hashPassword = (password, salt = randomToken(16)) => new Promise((resolve, reject) => {
  crypto.scrypt(password, salt, 64, (err, key) => err ? reject(err) : resolve({ salt, hash: key.toString('hex') }));
});
const verifyPassword = (password, record) => new Promise((resolve, reject) => {
  crypto.scrypt(password, record.salt, 64, (err, key) => {
    if (err) return reject(err);
    const a = Buffer.from(record.hash, 'hex');
    const b = key;
    resolve(a.length === b.length && crypto.timingSafeEqual(a, b));
  });
});

async function readUsers() {
  try { return JSON.parse(await fsp.readFile(USERS_FILE, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
async function writeUsers(users) {
  const temp = USERS_FILE + '.tmp';
  await fsp.writeFile(temp, JSON.stringify(users, null, 2), { mode: 0o600 });
  await fsp.rename(temp, USERS_FILE);
}
function cleanUsername(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 32);
}
function validUsername(value) { return /^[\p{L}\p{N}_. -]{3,32}$/u.test(value); }
function validPassword(value) { return typeof value === 'string' && value.length >= 10 && value.length <= 200; }
function safeName(value) {
  const name = String(value || '').normalize('NFC').trim();
  if (!name || name === '.' || name === '..' || name.length > 240 || /[\\/\0-\x1f\x7f]/.test(name)) {
    const err = new Error('Nome de arquivo ou pasta inválido.'); err.status = 400; throw err;
  }
  return name;
}
function relPath(value) {
  let raw = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (raw.includes('\0')) throw Object.assign(new Error('Caminho inválido.'), { status: 400 });
  const parts = raw.split('/').filter(Boolean);
  if (parts.some(p => p === '.' || p === '..')) throw Object.assign(new Error('Caminho inválido.'), { status: 400 });
  return parts.join(path.sep);
}
function insideRoot(target) {
  const rel = path.relative(SHARE_DIR, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
async function safeTarget(relative, allowMissing = false) {
  const rel = relPath(relative);
  const target = path.resolve(SHARE_DIR, rel);
  if (!insideRoot(target)) throw Object.assign(new Error('Acesso fora da pasta compartilhada bloqueado.'), { status: 403 });
  let probe = target;
  while (true) {
    try {
      const real = await fsp.realpath(probe);
      if (!insideRoot(real)) throw Object.assign(new Error('Acesso fora da pasta compartilhada bloqueado.'), { status: 403 });
      const st = await fsp.lstat(probe);
      if (st.isSymbolicLink()) throw Object.assign(new Error('Links simbólicos não são permitidos.'), { status: 403 });
      break;
    } catch (e) {
      if (e.code !== 'ENOENT' || !allowMissing) {
        if (e.status) throw e;
        if (e.code !== 'ENOENT') throw e;
      }
      const parent = path.dirname(probe);
      if (parent === probe) throw e;
      probe = parent;
      if (probe === SHARE_DIR) break;
    }
  }
  return target;
}
async function ensureNoSymlinkAncestors(target) {
  const rel = path.relative(SHARE_DIR, target);
  let current = SHARE_DIR;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if ((await fsp.lstat(current)).isSymbolicLink()) throw Object.assign(new Error('Links simbólicos não são permitidos.'), { status: 403 }); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
function getSession(req) {
  const token = req.cookiesToken || parseCookies(req.headers.cookie || '').filehub_session;
  const s = token && sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(token); return null; }
  s.expires = Date.now() + SESSION_TTL;
  return { token, ...s };
}
function parseCookies(header) {
  const out = {};
  header.split(';').forEach(part => {
    const i = part.indexOf('='); if (i < 0) return;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch (_) {}
  });
  return out;
}
function auth(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Faça login para continuar.' });
  req.user = session.user;
  req.sessionToken = session.token;
  req.csrf = session.csrf;
  next();
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Apenas o administrador pode fazer isso.' });
  next();
}
function csrf(req, res, next) {
  const supplied = req.headers['x-csrf-token'];
  if (!supplied || supplied !== req.csrf) return res.status(403).json({ error: 'Token de segurança inválido. Atualize a página.' });
  next();
}
function errorHandler(err, req, res, next) {
  console.error('[FileHub]', err && (err.stack || err));
  if (res.headersSent) return next(err);
  res.status(err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500)).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Arquivo excede o limite permitido.' : (err.message || 'Erro interno.') });
}

const uploadTemp = path.join(DATA_DIR, 'tmp');
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadTemp),
    filename: (req, file, cb) => cb(null, randomToken(18) + '.upload')
  }),
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES }
});

async function walkFolder(dir, prefix = '') {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.filehub-') || entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    const st = await fsp.stat(full);
    const relative = prefix ? prefix + '/' + entry.name : entry.name;
    out.push({ name: entry.name, path: relative, type: entry.isDirectory() ? 'folder' : 'file', size: st.size, modified: st.mtimeMs, ext: path.extname(entry.name).toLowerCase() });
  }
  return out;
}

app.get('/api/status', async (req, res, next) => {
  try {
    const users = await readUsers();
    res.json({ setupRequired: users.length === 0, app: 'FileHub', version: '1.0.0' });
  } catch (e) { next(e); }
});

app.post('/api/setup', async (req, res, next) => {
  try {
    const users = await readUsers();
    if (users.length) return res.status(403).json({ error: 'A configuração inicial já foi concluída.' });
    const savedTokenHash = (await fsp.readFile(SETUP_TOKEN_FILE, 'utf8').catch(() => '')).trim();
    const providedTokenHash = crypto.createHash('sha256').update(String(req.body.setupToken || '')).digest('hex');
    if (!savedTokenHash || savedTokenHash.length !== providedTokenHash.length || !crypto.timingSafeEqual(Buffer.from(savedTokenHash), Buffer.from(providedTokenHash))) return res.status(403).json({ error: 'Código inicial inválido. Confira o código exibido no terminal do servidor.' });
    const username = cleanUsername(req.body.username);
    const password = req.body.password;
    if (!validUsername(username)) return res.status(400).json({ error: 'Nickname: use de 3 a 32 caracteres.' });
    if (!validPassword(password)) return res.status(400).json({ error: 'A senha precisa ter pelo menos 10 caracteres.' });
    const record = await hashPassword(password);
    const user = { id: randomToken(12), username, ...record, role: 'admin', active: true, createdAt: new Date().toISOString() };
    await writeUsers([user]);
    await fsp.unlink(SETUP_TOKEN_FILE).catch(() => {});
    const csrfToken = createSession(res, user);
    res.json({ ok: true, user: publicUser(user), csrf: csrfToken });
  } catch (e) { next(e); }
});

function createSession(res, user) {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  sessions.set(token, { user: publicUser(user), csrf: csrfToken, expires: Date.now() + SESSION_TTL });
  res.cookie('filehub_session', token, { httpOnly: true, secure: 'auto', sameSite: 'lax', path: '/', maxAge: SESSION_TTL });
  return csrfToken;
}
function publicUser(user) { return { id: user.id, username: user.username, role: user.role, active: user.active }; }

app.post('/api/login', async (req, res, next) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const attempt = loginAttempts.get(ip) || { count: 0, until: 0 };
    if (attempt.until > Date.now()) return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos.' });
    const username = cleanUsername(req.body.username);
    const users = await readUsers();
    const user = users.find(u => u.username.toLowerCase() === username.toLowerCase() && u.active);
    const ok = user ? await verifyPassword(String(req.body.password || ''), user) : false;
    if (!ok) {
      attempt.count++;
      if (attempt.count >= 8) { attempt.until = Date.now() + 10 * 60 * 1000; attempt.count = 0; }
      loginAttempts.set(ip, attempt);
      return res.status(401).json({ error: 'Nickname ou senha incorretos.' });
    }
    loginAttempts.delete(ip);
    const csrfToken = createSession(res, user);
    res.json({ ok: true, user: publicUser(user), csrf: csrfToken });
  } catch (e) { next(e); }
});

app.post('/api/logout', auth, csrf, (req, res) => {
  sessions.delete(req.sessionToken);
  res.clearCookie('filehub_session', { path: '/' });
  res.json({ ok: true });
});
app.get('/api/me', auth, (req, res) => res.json({ user: req.user, csrf: req.csrf }));

app.get('/api/files', auth, async (req, res, next) => {
  try {
    const rel = relPath(req.query.path || '');
    const dir = await safeTarget(rel);
    await ensureNoSymlinkAncestors(dir);
    const st = await fsp.stat(dir);
    if (!st.isDirectory()) return res.status(400).json({ error: 'O caminho não é uma pasta.' });
    const items = await walkFolder(dir, rel.replace(/\\/g, '/'));
    items.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name, 'pt-BR', { numeric: true, sensitivity: 'base' }) : (a.type === 'folder' ? -1 : 1));
    res.json({ path: rel.replace(/\\/g, '/'), items });
  } catch (e) { next(e); }
});

app.post('/api/folders', auth, csrf, async (req, res, next) => {
  try {
    const parent = await safeTarget(req.body.path || '');
    await ensureNoSymlinkAncestors(parent);
    const target = path.join(parent, safeName(req.body.name));
    if (!insideRoot(target)) throw Object.assign(new Error('Caminho inválido.'), { status: 403 });
    await fsp.mkdir(target);
    res.json({ ok: true });
  } catch (e) { if (e.code === 'EEXIST') e.status = 409; next(e); }
});

app.post('/api/upload', auth, csrf, (req, res, next) => {
  upload.array('files', MAX_FILES)(req, res, async err => {
    if (err) return next(err);
    try {
      const rel = relPath(req.body.path || '');
      const destDir = await safeTarget(rel);
      await ensureNoSymlinkAncestors(destDir);
      if (!(await fsp.stat(destDir)).isDirectory()) throw Object.assign(new Error('Destino inválido.'), { status: 400 });
      const completed = [];
      for (const file of (req.files || [])) {
        const name = safeName(file.originalname);
        const target = path.join(destDir, name);
        if (!insideRoot(target)) throw Object.assign(new Error('Destino inválido.'), { status: 403 });
        await ensureNoSymlinkAncestors(target);
        try { await fsp.access(target); throw Object.assign(new Error('Já existe um item chamado: ' + name), { status: 409 }); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
        await fsp.rename(file.path, target);
        completed.push(name);
      }
      res.json({ ok: true, uploaded: completed });
    } catch (e) { next(e); }
    finally { for (const file of (req.files || [])) fsp.unlink(file.path).catch(() => {}); }
  });
});

app.post('/api/item/rename', auth, csrf, async (req, res, next) => {
  try {
    const source = await safeTarget(req.body.path);
    await ensureNoSymlinkAncestors(source);
    const parent = path.dirname(source);
    const target = path.join(parent, safeName(req.body.name));
    if (!insideRoot(target)) throw Object.assign(new Error('Destino inválido.'), { status: 403 });
    if (target !== source) {
      try { await fsp.access(target); throw Object.assign(new Error('Já existe um item com esse nome.'), { status: 409 }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      await fsp.rename(source, target);
    }
    res.json({ ok: true });
  } catch (e) { if (e.code === 'EEXIST') e.status = 409; next(e); }
});

app.post('/api/item/delete', auth, csrf, async (req, res, next) => {
  try {
    const target = await safeTarget(req.body.path);
    if (target === SHARE_DIR) throw Object.assign(new Error('A pasta compartilhada principal não pode ser excluída.'), { status: 400 });
    await ensureNoSymlinkAncestors(target);
    await fsp.rm(target, { recursive: true, force: false });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/item/move', auth, csrf, async (req, res, next) => {
  try {
    const source = await safeTarget(req.body.path);
    const destDir = await safeTarget(req.body.destination);
    await ensureNoSymlinkAncestors(source); await ensureNoSymlinkAncestors(destDir);
    if (!(await fsp.stat(destDir)).isDirectory()) throw Object.assign(new Error('Destino não é uma pasta.'), { status: 400 });
    const target = path.join(destDir, path.basename(source));
    if (!insideRoot(target) || target === source || target.startsWith(source + path.sep)) throw Object.assign(new Error('Não é possível mover para dentro do próprio item.'), { status: 400 });
    try { await fsp.access(target); throw Object.assign(new Error('Já existe um item com esse nome no destino.'), { status: 409 }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await fsp.rename(source, target);
    res.json({ ok: true });
  } catch (e) { if (e.code === 'EXDEV') e.status = 400; if (e.code === 'EEXIST') e.status = 409; next(e); }
});


app.post('/api/item/copy', auth, csrf, async (req, res, next) => {
  try {
    const source = await safeTarget(req.body.path);
    const destDir = await safeTarget(req.body.destination);
    await ensureNoSymlinkAncestors(source); await ensureNoSymlinkAncestors(destDir);
    if (!(await fsp.stat(destDir)).isDirectory()) throw Object.assign(new Error('Destino não é uma pasta.'), { status: 400 });
    const target = path.join(destDir, path.basename(source));
    if (!insideRoot(target) || target === source || target.startsWith(source + path.sep)) throw Object.assign(new Error('Destino inválido.'), { status: 400 });
    try { await fsp.access(target); throw Object.assign(new Error('Já existe um item com esse nome no destino.'), { status: 409 }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await fsp.cp(source, target, { recursive: true, errorOnExist: true, force: false, dereference: false });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.get('/api/zip', auth, async (req, res, next) => {
  try {
    const target = await safeTarget(req.query.path || '');
    await ensureNoSymlinkAncestors(target);
    if (!(await fsp.stat(target)).isDirectory()) return res.status(400).json({ error: 'Selecione uma pasta.' });
    const base = path.basename(target) || 'Compartilhados';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${base.replace(/[^a-zA-Z0-9._-]/g, '_')}.zip"`);
    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.on('error', err => { if (!res.headersSent) next(err); else res.destroy(err); });
    archive.pipe(res);
    archive.directory(target, false, entry => entry.name.split(path.sep).some(part => part.startsWith('.filehub-')) ? false : entry);
    archive.finalize();
  } catch (e) { next(e); }
});

app.get('/api/download', auth, async (req, res, next) => {
  try {
    const target = await safeTarget(req.query.path);
    await ensureNoSymlinkAncestors(target);
    const st = await fsp.stat(target);
    if (!st.isFile()) return res.status(400).json({ error: 'Selecione um arquivo para baixar.' });
    res.download(target, path.basename(target));
  } catch (e) { next(e); }
});

app.get('/api/preview', auth, async (req, res, next) => {
  try {
    const target = await safeTarget(req.query.path);
    await ensureNoSymlinkAncestors(target);
    const st = await fsp.stat(target);
    if (!st.isFile()) return res.status(400).end('Arquivo inválido.');
    const ext = path.extname(target).toLowerCase();
    const mime = ({ '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.mp4':'video/mp4','.webm':'video/webm','.mp3':'audio/mpeg','.ogg':'audio/ogg','.wav':'audio/wav','.pdf':'application/pdf','.txt':'text/plain; charset=utf-8','.md':'text/plain; charset=utf-8' })[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', st.size);
    res.setHeader('Content-Disposition', 'inline; filename*=UTF-8\'\'' + encodeURIComponent(path.basename(target)));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    fs.createReadStream(target).pipe(res);
  } catch (e) { next(e); }
});

app.get('/api/search', auth, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().toLocaleLowerCase('pt-BR').slice(0, 100);
    if (!q) return res.json({ items: [] });
    const results = [];
    async function scan(dir, prefix = '') {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const rel = prefix ? prefix + '/' + entry.name : entry.name;
        if (entry.name.toLocaleLowerCase('pt-BR').includes(q)) {
          const st = await fsp.stat(path.join(dir, entry.name));
          results.push({ name: entry.name, path: rel, type: entry.isDirectory() ? 'folder' : 'file', size: st.size, modified: st.mtimeMs });
          if (results.length >= 300) return;
        }
        if (entry.isDirectory() && results.length < 300) await scan(path.join(dir, entry.name), rel);
        if (results.length >= 300) return;
      }
    }
    await scan(SHARE_DIR);
    res.json({ items: results });
  } catch (e) { next(e); }
});


app.get('/api/recent', auth, async (req, res, next) => {
  try {
    const results = [];
    async function scan(dir, prefix = '') {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const rel = prefix ? prefix + '/' + entry.name : entry.name;
        const full = path.join(dir, entry.name);
        const st = await fsp.stat(full);
        results.push({ name: entry.name, path: rel, type: entry.isDirectory() ? 'folder' : 'file', size: st.size, modified: st.mtimeMs, ext: path.extname(entry.name).toLowerCase() });
        if (entry.isDirectory() && results.length < 1500) await scan(full, rel);
        if (results.length >= 1500) return;
      }
    }
    await scan(SHARE_DIR);
    results.sort((a, b) => b.modified - a.modified);
    res.json({ items: results.slice(0, 100) });
  } catch (e) { next(e); }
});

app.get('/api/admin/users', auth, adminOnly, async (req, res, next) => {
  try { res.json({ users: (await readUsers()).map(publicUser) }); } catch (e) { next(e); }
});
app.post('/api/admin/users', auth, csrf, adminOnly, async (req, res, next) => {
  try {
    const username = cleanUsername(req.body.username);
    const password = req.body.password;
    if (!validUsername(username)) return res.status(400).json({ error: 'Nickname: use de 3 a 32 caracteres.' });
    if (!validPassword(password)) return res.status(400).json({ error: 'A senha precisa ter pelo menos 10 caracteres.' });
    const users = await readUsers();
    if (users.some(u => u.username.toLowerCase() === username.toLowerCase())) return res.status(409).json({ error: 'Esse nickname já está em uso.' });
    const record = await hashPassword(password);
    const user = { id: randomToken(12), username, ...record, role: 'user', active: true, createdAt: new Date().toISOString() };
    users.push(user); await writeUsers(users);
    res.json({ ok: true, user: publicUser(user) });
  } catch (e) { next(e); }
});
app.patch('/api/admin/users/:id', auth, csrf, adminOnly, async (req, res, next) => {
  try {
    const users = await readUsers();
    const user = users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Conta não encontrada.' });
    if (user.role === 'admin') return res.status(400).json({ error: 'A conta principal de administrador não pode ser bloqueada por aqui.' });
    user.active = Boolean(req.body.active);
    await writeUsers(users);
    if (!user.active) for (const [token, s] of sessions) if (s.user.id === user.id) sessions.delete(token);
    res.json({ ok: true, user: publicUser(user) });
  } catch (e) { next(e); }
});
app.post('/api/admin/users/:id/password', auth, csrf, adminOnly, async (req, res, next) => {
  try {
    if (!validPassword(req.body.password)) return res.status(400).json({ error: 'A senha precisa ter pelo menos 10 caracteres.' });
    const users = await readUsers(); const user = users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Conta não encontrada.' });
    Object.assign(user, await hashPassword(req.body.password)); await writeUsers(users);
    for (const [token, s] of sessions) if (s.user.id === user.id) sessions.delete(token);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.delete('/api/admin/users/:id', auth, csrf, adminOnly, async (req, res, next) => {
  try {
    const users = await readUsers(); const user = users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Conta não encontrada.' });
    if (user.role === 'admin') return res.status(400).json({ error: 'A conta de administrador principal não pode ser excluída.' });
    await writeUsers(users.filter(u => u.id !== user.id));
    for (const [token, s] of sessions) if (s.user.id === user.id) sessions.delete(token);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// O JSON do túnel não pode ficar em cache: o endereço Quick Tunnel pode mudar.
app.get('/config.json', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'config.json'));
});
// O JSON do túnel não pode ficar em cache: o endereço Quick Tunnel pode mudar.
app.get('/config.json', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'config.json'));
});
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', etag: true, maxAge: '1h' }));
app.use((err, req, res, next) => errorHandler(err, req, res, next));

async function start() {
  await fsp.mkdir(SHARE_DIR, { recursive: true });
  await fsp.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await fsp.mkdir(uploadTemp, { recursive: true, mode: 0o700 });
  try { await fsp.chmod(DATA_DIR, 0o700); } catch (_) {}
  const existingUsers = await readUsers();
  if (existingUsers.length === 0) {
    let setupHash = '';
    try { setupHash = (await fsp.readFile(SETUP_TOKEN_FILE, 'utf8')).trim(); } catch (_) {}
    if (!setupHash) {
      const setupToken = randomToken(24);
      setupHash = crypto.createHash('sha256').update(setupToken).digest('hex');
      await fsp.writeFile(SETUP_TOKEN_FILE, setupHash, { mode: 0o600 });
      console.log('CODIGO DE CONFIGURACAO INICIAL (use uma vez na primeira tela): ' + setupToken);
    }
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('=====================================');
    console.log(' FileHub iniciado');
    console.log(' Porta: ' + PORT);
    console.log(' Pasta compartilhada: ' + SHARE_DIR);
    console.log(' Dados privados: ' + DATA_DIR);
    console.log(' Node.js: ' + process.version);
    console.log('=====================================');
    console.log('Acesse http://IP-DO-TVBOX:' + PORT);
  });
}
start().catch(err => { console.error('Falha ao iniciar FileHub:', err); process.exit(1); });
