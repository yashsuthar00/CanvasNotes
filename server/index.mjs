// Canvas Notes server: a JSON API over a local SQLite file, uploaded files on
// disk, link previews, and the built client (or Vite middleware in --dev).
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openStore } from './store.mjs';
import { unfurl } from './unfurl.mjs';
import { buildZip } from './zip.mjs';
import { createAccounts, installSecret, rateLimiter } from './accounts.mjs';
import { authPage } from './authPage.mjs';
import { createFileSweeper } from './filesweep.mjs';
import { createBoards } from './boards.mjs';
import { fetchImportable, generateIdeas, searchImages } from './integrations.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DEV = process.argv.includes('--dev');
const PORT = Number(process.env.PORT || 5180);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const FILES_DIR = path.join(DATA_DIR, 'files');
const DIST_DIR = path.join(ROOT, 'dist');
const SIGNUPS = process.env.CANVASNOTES_SIGNUPS === 'closed' ? 'closed' : 'open';
const INVITE_CODE = process.env.CANVASNOTES_INVITE_CODE || '';
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.CANVASNOTES_TRUST_PROXY || '');
// Upload space per account.
const QUOTA_BYTES = Number(process.env.CANVASNOTES_QUOTA_MB || 1024) * 1024 * 1024;
// How long an upload that no card uses any more is kept before it is deleted.
const FILE_GRACE_MS = Number(process.env.CANVASNOTES_FILE_GRACE_MIN || 30) * 60_000;
const MAX_UPLOAD = 100 * 1024 * 1024;
const MAX_JSON = 50 * 1024 * 1024;

fs.mkdirSync(FILES_DIR, { recursive: true });
const store = openStore(path.join(DATA_DIR, 'canvasnotes.db'), { maxUserBytes: Number(process.env.CANVASNOTES_DATA_MB || 200) * 1024 * 1024 });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

function send(res, status, body, headers = {}) {
  const isBuffer = Buffer.isBuffer(body);
  const payload = isBuffer || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': isBuffer || typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
    ...headers,
  });
  res.end(payload);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req, MAX_JSON);
  try {
    return JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

// Files uploaded before accounts existed; the first account to sign up takes them over.
const legacyFiles = () =>
  fs.readdirSync(FILES_DIR).flatMap((name) => {
    const stat = fs.statSync(path.join(FILES_DIR, name));
    return stat.isFile() ? [{ name, size: stat.size }] : [];
  });
const accounts = createAccounts(store, { signups: SIGNUPS, inviteCode: INVITE_CODE, trustProxy: TRUST_PROXY, legacyFiles });
const boards = createBoards({ store, secret: installSecret(DATA_DIR) });
const sweeper = createFileSweeper({ store, filesDir: FILES_DIR, graceMs: FILE_GRACE_MS, log: (m) => console.log(m) });
// Finishes deletions whose grace period has passed (and catches anything a change-triggered sweep missed).
setInterval(() => {
  try {
    sweeper.sweepAll();
  } catch (err) {
    console.error('file sweep failed', err);
  }
}, Math.max(1000, Math.min(5 * 60_000, FILE_GRACE_MS))).unref();
// Calls that cost money or make the server fetch the web, per account.
const ideasLimit = rateLimiter(30, 60 * 60 * 1000);
const fetchLimit = rateLimiter(300, 60 * 60 * 1000);
const limit = (limiter, user) => {
  if (limiter.blocked(user.id)) throw Object.assign(new Error('Too many requests. Try again later.'), { status: 429 });
  limiter.hit(user.id);
};
// Files the login page itself needs before signing in.
const PUBLIC_PATHS = new Set(['/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/favicon.svg']);

// What a signed-out visitor may load: the sign-in page's assets, and published boards.
function isPublicRequest(pathname) {
  if (PUBLIC_PATHS.has(pathname) || pathname.startsWith('/assets/') || pathname.startsWith('/api/public/') || pathname.startsWith('/p/')) return true;
  return pathname.startsWith('/files/') && boards.publishedFiles().has(pathname);
}

// Files are stored once by content hash and owned per account, so one account
// can never load another's uploads unless they're on a published board.
function saveUpload(user, body, name, mime) {
  const ext = (path.extname(name).toLowerCase().match(/^\.[a-z0-9]{1,8}$/) || [''])[0];
  const hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 32);
  const fileName = hash + ext;
  if (!store.ownsUpload(user.id, fileName) && store.usedBytes(user.id) + body.length > QUOTA_BYTES) {
    throw Object.assign(new Error('Your storage is full. Delete some files and try again.'), { status: 413 });
  }
  const target = path.join(FILES_DIR, fileName);
  if (!fs.existsSync(target)) fs.writeFileSync(target, body);
  store.addUpload(user.id, fileName, body.length);
  return { url: `/files/${fileName}`, name, size: body.length, mime: mime || MIME[ext] || 'application/octet-stream' };
}

// Uploaded file types the browser may show inline. Anything else (HTML, SVG,
// scripts, unknown types) is sent as a download in a sandbox, so an uploaded
// page can never run as this site.
const INLINE_UPLOADS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.pdf', '.mp4', '.webm', '.mp3', '.wav', '.txt']);

function serveFile(res, filePath, { immutable = false, upload = false, headers = {} } = {}) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, 'Not found');
    const ext = path.extname(filePath).toLowerCase();
    const extra = {};
    if (upload) {
      // Images keep their type so <img> works; the sandbox stops anything active.
      if (ext !== '.pdf') extra['content-security-policy'] = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox";
      if (!INLINE_UPLOADS.has(ext)) extra['content-disposition'] = 'attachment';
    }
    res.writeHead(200, {
      'content-type': (upload && !INLINE_UPLOADS.has(ext) && ext !== '.svg' ? null : MIME[ext]) || 'application/octet-stream',
      'content-length': stat.size,
      // Uploads are private to their owner: browsers may cache them, shared proxies may not.
      'cache-control': immutable ? `${upload ? 'private' : 'public'}, max-age=31536000, immutable` : 'no-cache',
      'x-content-type-options': 'nosniff',
      ...extra,
      ...headers,
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

// Resolves a request path inside `base`, refusing anything that escapes it.
function safeJoin(base, requestPath) {
  const resolved = path.resolve(base, '.' + path.posix.normalize('/' + decodeURIComponent(requestPath)));
  return resolved.startsWith(base + path.sep) || resolved === base ? resolved : null;
}

function reply(res, result) {
  return send(res, result.status, result.body, result.headers);
}

// Published boards: readable by anyone with the link, signed in or not.
async function handlePublicApi(req, res, url) {
  const pubMatch = req.method === 'GET' && url.pathname.match(/^\/api\/public\/([\w-]+)$/);
  if (!pubMatch) return send(res, 401, { error: 'Sign in required' });
  const pub = boards.published(pubMatch[1]);
  return pub ? send(res, 200, pub) : send(res, 404, { error: 'This board is no longer published' });
}

async function handleApi(req, res, url, user) {
  const route = `${req.method} ${url.pathname}`;
  switch (route) {
    case 'GET /api/state':
      return send(res, 200, { elements: boards.visible(req, user.id), auth: true, user, storage: { used: store.usedBytes(user.id), quota: QUOTA_BYTES } });
    case 'POST /api/account/profile':
      return reply(res, accounts.updateProfile(user, await readJson(req)));
    case 'POST /api/account/password':
      return reply(res, await accounts.changePassword(req, user, await readJson(req)));
    case 'POST /api/account/delete': {
      const result = await accounts.deleteAccount(req, user, await readJson(req));
      for (const name of result.orphans || []) fs.rmSync(path.join(FILES_DIR, name), { force: true });
      return reply(res, result);
    }
    case 'POST /api/ops': {
      const { ops } = await readJson(req);
      if (!Array.isArray(ops)) return send(res, 400, { error: 'ops must be an array' });
      store.apply(user.id, ops);
      sweeper.soon(user.id);
      return send(res, 200, { ok: true, applied: ops.length });
    }
    case 'POST /api/upload': {
      const name = (url.searchParams.get('name') || 'file').slice(0, 200);
      const body = await readBody(req, MAX_UPLOAD);
      return send(res, 200, saveUpload(user, body, name, req.headers['content-type']));
    }
    case 'GET /api/image-search':
      limit(fetchLimit, user);
      return send(res, 200, await searchImages(url.searchParams.get('q')));
    case 'POST /api/import-url': {
      limit(fetchLimit, user);
      const { url: target } = await readJson(req);
      const { buf, name, mime } = await fetchImportable(target);
      return send(res, 200, saveUpload(user, buf, name, mime));
    }
    case 'POST /api/ai-ideas': {
      limit(ideasLimit, user);
      const result = await generateIdeas(await readJson(req));
      return send(res, result.status, result.body);
    }
    case 'POST /api/board-lock':
    case 'POST /api/board-unlock':
    case 'POST /api/board-unlock-remove': {
      const body = await readJson(req);
      const fn = url.pathname.endsWith('remove') ? 'removeLock' : url.pathname.endsWith('unlock') ? 'unlock' : 'lock';
      const result = boards[fn](req, user.id, body);
      return send(res, result.status, result.body, result.headers);
    }
    case 'GET /api/unfurl': {
      limit(fetchLimit, user);
      const target = url.searchParams.get('url') || '';
      return send(res, 200, await unfurl(target));
    }
    case 'GET /api/export':
      return send(
        res,
        200,
        { app: 'canvasnotes', version: 1, exportedAt: new Date().toISOString(), elements: store.all(user.id) },
        { 'content-disposition': `attachment; filename="canvasnotes-${new Date().toISOString().slice(0, 10)}.json"` },
      );
    case 'POST /api/import': {
      const { elements, mode } = await readJson(req);
      if (!Array.isArray(elements)) return send(res, 400, { error: 'elements must be an array' });
      store.importAll(user.id, elements, mode === 'replace');
      sweeper.soon(user.id);
      return send(res, 200, { ok: true, imported: elements.length });
    }
    default: {
      const zipMatch = req.method === 'GET' && url.pathname.match(/^\/api\/board-files\/([\w-]+)$/);
      if (zipMatch) return sendBoardZip(res, zipMatch[1], boards.visible(req, user.id), user);
      return send(res, 404, { error: 'Unknown API route' });
    }
  }
}

// A file or folder name inside the ZIP: no path separators, no leading dots
// (so a board called ".." can't make an entry that unzips outside the folder).
const zipSafe = (name) => String(name).replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-').replace(/^[.\s]+/, '').slice(0, 120) || 'untitled';

// Every uploaded image/file on a board and its sub-boards, as one ZIP.
function sendBoardZip(res, boardId, all, user) {
  const byParent = new Map();
  for (const el of all) {
    if (el.section === 'trash') continue;
    if (!byParent.has(el.parentId)) byParent.set(el.parentId, []);
    byParent.get(el.parentId).push(el);
  }
  const entries = [];
  const used = new Set();
  const walk = (id, prefix, seen) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const el of byParent.get(id) || []) {
      const src = el.type === 'image' || el.type === 'file' ? el.content?.src : null;
      if (src && src.startsWith('/files/') && store.ownsUpload(user.id, src.slice('/files/'.length))) {
        const file = safeJoin(FILES_DIR, src.slice('/files/'.length));
        if (file && fs.existsSync(file)) {
          const base = (el.type === 'file' ? el.content.name : el.content.caption) || path.basename(file);
          let name = prefix + zipSafe(base);
          if (!path.extname(name)) name += path.extname(file);
          let n = 1;
          while (used.has(name)) name = name.replace(/(\.[^.]*)?$/, (ext) => ` (${n++})${ext}`);
          used.add(name);
          entries.push({ name, data: fs.readFileSync(file) });
        }
      }
      if (el.type === 'board') walk(el.id, `${prefix}${zipSafe(el.content?.title || 'board')}/`, seen);
    }
  };
  walk(boardId, '', new Set());
  if (entries.length === 0) return send(res, 404, 'No files found on this board');
  const zip = buildZip(entries);
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-length': zip.length,
    'content-disposition': `attachment; filename="canvasnotes-files-${boardId}.zip"`,
  });
  res.end(zip);
}

let vite = null;
if (DEV) {
  const { createServer } = await import('vite');
  vite = await createServer({ root: ROOT, server: { middlewareMode: true }, appType: 'spa' });
}

// What the app page may load. Scripts only from this site (so injected HTML
// can't run code); embeds and web images from https; data goes only to this server.
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  'frame-src https:',
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

// Requests that change something must come from this site's own pages (a
// second line of defence next to the SameSite cookie).
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = (TRUST_PROXY && req.headers['x-forwarded-host']) || req.headers.host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('x-frame-options', 'SAMEORIGIN');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  if (req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted) res.setHeader('strict-transport-security', 'max-age=31536000');
  if (url.pathname.startsWith('/api/')) res.setHeader('cache-control', 'no-store');
  try {
    if (!['GET', 'HEAD'].includes(req.method) && !sameOrigin(req)) return send(res, 403, { error: 'Cross-site request refused' });
    if (req.method === 'POST' && url.pathname === '/api/signup') return reply(res, await accounts.signup(req, await readJson(req)));
    if (req.method === 'POST' && url.pathname === '/api/login') return reply(res, await accounts.login(req, await readJson(req)));
    if (req.method === 'POST' && url.pathname === '/api/logout') return reply(res, accounts.logout(req));
    const user = accounts.userOf(req);
    if (!user && !isPublicRequest(url.pathname)) {
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/files/')) return send(res, 401, { error: 'Sign in required' });
      const nonce = crypto.randomBytes(16).toString('base64');
      return send(res, 200, authPage({ ...accounts.signupInfo(), nonce }), {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
      });
    }
    if (url.pathname.startsWith('/api/public/') || (!user && url.pathname.startsWith('/api/'))) return await handlePublicApi(req, res, url);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url, user);
    if (url.pathname.startsWith('/files/')) {
      const name = url.pathname.slice('/files/'.length);
      if (!(user && store.ownsUpload(user.id, decodeURIComponent(name))) && !boards.publishedFiles().has(url.pathname)) return send(res, 404, 'Not found');
      const file = safeJoin(FILES_DIR, name);
      return file ? serveFile(res, file, { immutable: true, upload: true }) : send(res, 404, 'Not found');
    }
    if (vite) return vite.middlewares(req, res, () => send(res, 404, 'Not found'));
    const file = url.pathname === '/' ? null : safeJoin(DIST_DIR, url.pathname);
    if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return serveFile(res, file, { immutable: url.pathname.startsWith('/assets/'), headers: file.endsWith('.html') ? { 'content-security-policy': APP_CSP } : {} });
    }
    if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
      return send(res, 500, 'Client not built. Run `npm run build` first, or use `npm run dev`.');
    }
    return serveFile(res, path.join(DIST_DIR, 'index.html'), { headers: { 'content-security-policy': APP_CSP } });
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    // Unexpected errors stay in the server log; the client only learns that something failed.
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Server error' : err.message || 'Error' });
  }
});

// Slow clients can't hold connections open forever (slowloris); big uploads still have 10 minutes.
server.headersTimeout = 20_000;
server.requestTimeout = 10 * 60_000;

server.listen(PORT, HOST, () => {
  console.log(`Canvas Notes ${DEV ? '(dev) ' : ''}running at http://${HOST}:${PORT}`);
  if (['0.0.0.0', '::'].includes(HOST)) {
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      if (/^(docker|br-|veth)/.test(name)) continue;
      for (const a of addrs ?? []) {
        if (a.family === 'IPv4' && !a.internal) console.log(`  on your network: http://${a.address}:${PORT}`);
      }
    }
  }
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(`Accounts: sign-ups ${SIGNUPS}${INVITE_CODE ? ' (invite code required)' : ''}, ${store.userCount()} account(s)`);
  if (process.env.CANVASNOTES_PASSWORD) {
    console.warn('Note: CANVASNOTES_PASSWORD is no longer used. Everyone signs in with their own account now; set CANVASNOTES_SIGNUPS=closed to stop new sign-ups.');
  }
});

function shutdown() {
  server.close();
  vite?.close();
  store.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
