// Storage. Each element is one JSON document keyed by (user, id); the client
// owns the element schema, the server only persists it. Every query is scoped
// to one user, so accounts can never see or change each other's elements.
import { DatabaseSync } from 'node:sqlite';

// Rows from before accounts existed belong to this placeholder until the
// first account is created, which claims them.
const UNCLAIMED = '';

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

// Databases created before accounts had one global elements table. Move every
// row under the placeholder owner, keeping the data exactly as it was.
function migrate(db) {
  const has = (table) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (has('elements') && !columns(db, 'elements').includes('user_id')) {
    db.exec(`
      ALTER TABLE elements RENAME TO elements_legacy;
      CREATE TABLE elements (
        user_id TEXT NOT NULL,
        id TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        public_token TEXT GENERATED ALWAYS AS (json_extract(data, '$.content.publicToken')) VIRTUAL,
        PRIMARY KEY (user_id, id)
      );
      INSERT INTO elements (user_id, id, data, updated_at) SELECT '', id, data, updated_at FROM elements_legacy;
      DROP TABLE elements_legacy;
    `);
  }
  if (has('board_locks') && !columns(db, 'board_locks').includes('user_id')) {
    db.exec(`
      ALTER TABLE board_locks RENAME TO board_locks_legacy;
      CREATE TABLE board_locks (user_id TEXT NOT NULL, board_id TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (user_id, board_id));
      INSERT INTO board_locks (user_id, board_id, salt, hash) SELECT '', board_id, salt, hash FROM board_locks_legacy;
      DROP TABLE board_locks_legacy;
    `);
  }
}

// options.maxElementBytes / maxUserBytes: size limits for one card and for one account's cards.
export function openStore(file, { maxElementBytes = 5 * 1024 * 1024, maxUserBytes = 200 * 1024 * 1024 } = {}) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
  // Keep a full copy before converting a database from before accounts.
  const legacy = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'elements'").get() && !columns(db, 'elements').includes('user_id');
  if (legacy) {
    const backup = file.replace(/\.db$/, '') + `-before-accounts-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.db`;
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
    console.log(`Converted the database for accounts; the previous version is saved as ${backup}`);
  }
  db.exec('BEGIN');
  try {
    migrate(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL DEFAULT '',
        salt TEXT NOT NULL,
        hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
      CREATE TABLE IF NOT EXISTS elements (
        user_id TEXT NOT NULL,
        id TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        public_token TEXT GENERATED ALWAYS AS (json_extract(data, '$.content.publicToken')) VIRTUAL,
        PRIMARY KEY (user_id, id)
      );
      CREATE INDEX IF NOT EXISTS elements_public ON elements(public_token) WHERE public_token IS NOT NULL;
      CREATE TABLE IF NOT EXISTS board_locks (
        user_id TEXT NOT NULL,
        board_id TEXT NOT NULL,
        salt TEXT NOT NULL,
        hash TEXT NOT NULL,
        PRIMARY KEY (user_id, board_id)
      );
      CREATE TABLE IF NOT EXISTS uploads (
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        orphaned_at INTEGER,
        PRIMARY KEY (user_id, name)
      );
      CREATE INDEX IF NOT EXISTS uploads_name ON uploads(name);
    `);
    // Added after the first accounts release: when a file stopped being used by any of the account's cards.
    if (!columns(db, 'uploads').includes('orphaned_at')) db.exec('ALTER TABLE uploads ADD COLUMN orphaned_at INTEGER');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const q = {
    selectAll: db.prepare('SELECT data FROM elements WHERE user_id = ?'),
    dataBytes: db.prepare('SELECT COALESCE(SUM(length(data)), 0) AS n FROM elements WHERE user_id = ?'),
    upsert: db.prepare(
      'INSERT INTO elements (user_id, id, data, updated_at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(user_id, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
    ),
    remove: db.prepare('DELETE FROM elements WHERE user_id = ? AND id = ?'),
    clear: db.prepare('DELETE FROM elements WHERE user_id = ?'),
    byToken: db.prepare("SELECT user_id FROM elements WHERE public_token = ? AND json_extract(data, '$.type') = 'board' LIMIT 1"),
    tokenOwner: db.prepare('SELECT user_id FROM elements WHERE public_token = ? LIMIT 1'),
    publishers: db.prepare('SELECT DISTINCT user_id FROM elements WHERE public_token IS NOT NULL'),
    selectLocks: db.prepare('SELECT board_id, salt, hash FROM board_locks WHERE user_id = ?'),
    upsertLock: db.prepare(
      'INSERT INTO board_locks (user_id, board_id, salt, hash) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, board_id) DO UPDATE SET salt = excluded.salt, hash = excluded.hash',
    ),
    deleteLock: db.prepare('DELETE FROM board_locks WHERE user_id = ? AND board_id = ?'),
    userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
    listUsers: db.prepare('SELECT email, name, created_at FROM users ORDER BY created_at'),
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (id, email, name, salt, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    setPassword: db.prepare('UPDATE users SET salt = ?, hash = ? WHERE id = ?'),
    setName: db.prepare('UPDATE users SET name = ? WHERE id = ?'),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
    sessionUser: db.prepare(
      'SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?',
    ),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?'),
    deleteExpired: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    claimElements: db.prepare("UPDATE elements SET user_id = ? WHERE user_id = ''"),
    claimLocks: db.prepare("UPDATE board_locks SET user_id = ? WHERE user_id = ''"),
    // Uploading a file again brings it back into use.
    insertUpload: db.prepare('INSERT INTO uploads (user_id, name, size, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, name) DO UPDATE SET orphaned_at = NULL'),
    uploadsOf: db.prepare('SELECT name, size, created_at, orphaned_at FROM uploads WHERE user_id = ?'),
    uploaders: db.prepare('SELECT DISTINCT user_id FROM uploads'),
    fileRefs: db.prepare("SELECT data FROM elements WHERE user_id = ? AND data LIKE '%/files/%'"),
    setOrphaned: db.prepare('UPDATE uploads SET orphaned_at = ? WHERE user_id = ? AND name = ?'),
    deleteUpload: db.prepare('DELETE FROM uploads WHERE user_id = ? AND name = ?'),
    ownsUpload: db.prepare('SELECT 1 FROM uploads WHERE user_id = ? AND name = ?'),
    usedBytes: db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM uploads WHERE user_id = ?'),
    userUploads: db.prepare('SELECT name FROM uploads WHERE user_id = ?'),
    deleteUploads: db.prepare('DELETE FROM uploads WHERE user_id = ?'),
    uploadOwners: db.prepare('SELECT COUNT(*) AS n FROM uploads WHERE name = ?'),
    deleteLocks: db.prepare('DELETE FROM board_locks WHERE user_id = ?'),
  };

  // Bumped on every write, so derived data (like which files are public) can be cached.
  let version = 0;

  function transaction(fn) {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      version++;
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function put(userId, el) {
    if (!el || typeof el !== 'object' || typeof el.id !== 'string' || !el.id || el.id.length > 200) {
      throw Object.assign(new Error('Element needs a string id'), { status: 400 });
    }
    // A public link token belongs to whoever published it first; another account
    // reusing it (say, from an imported backup) could otherwise take over that link.
    // Short or odd tokens would be guessable, so they're dropped too.
    const token = el.content?.publicToken;
    if (token) {
      const owner = q.tokenOwner.get(String(token))?.user_id;
      if ((owner !== undefined && owner !== userId) || !/^[\w-]{16,64}$/.test(String(token))) el = { ...el, content: { ...el.content, publicToken: null } };
    }
    const json = JSON.stringify(el);
    if (json.length > maxElementBytes) throw Object.assign(new Error('This card is too large to save.'), { status: 413 });
    q.upsert.run(userId, el.id, json, Date.now());
  }

  // Inside a write transaction: refuse (and so roll back) if the account went over its limit.
  function checkUserSize(userId) {
    if (q.dataBytes.get(userId).n > maxUserBytes) throw Object.assign(new Error('Your account is full. Delete some boards or cards and try again.'), { status: 413 });
  }

  return {
    get version() {
      return version;
    },

    // ----- elements (always for one user)
    all(userId) {
      return q.selectAll.all(userId).map((row) => JSON.parse(row.data));
    },
    apply(userId, ops) {
      transaction(() => {
        for (const op of ops) {
          if (op?.op === 'put') put(userId, op.el);
          else if (op?.op === 'del' && typeof op.id === 'string') q.remove.run(userId, op.id);
          else throw Object.assign(new Error(`Unknown op: ${JSON.stringify(op).slice(0, 80)}`), { status: 400 });
        }
        if (ops.some((op) => op?.op === 'put')) checkUserSize(userId);
      });
    },
    importAll(userId, elements, replace) {
      transaction(() => {
        if (replace) q.clear.run(userId);
        for (const el of elements) put(userId, el);
        checkUserSize(userId);
      });
    },
    // The owner of the board published under this token, if any.
    publisherOf(token) {
      return q.byToken.get(token)?.user_id ?? null;
    },
    publishers() {
      return q.publishers.all().map((r) => r.user_id);
    },

    // ----- password-protected boards: board id → { salt, hash }. Hashes never leave the server.
    locks(userId) {
      return new Map(q.selectLocks.all(userId).map((r) => [r.board_id, { salt: r.salt, hash: r.hash }]));
    },
    setLock(userId, id, salt, hash) {
      q.upsertLock.run(userId, id, salt, hash);
      version++;
    },
    removeLock(userId, id) {
      q.deleteLock.run(userId, id);
      version++;
    },

    // ----- accounts
    userCount: () => q.userCount.get().n,
    listUsers: () => q.listUsers.all(),
    userByEmail: (email) => q.userByEmail.get(email) ?? null,
    userById: (id) => q.userById.get(id) ?? null,
    // Creates the account; the very first one also takes over data from before accounts existed.
    createUser({ id, email, name, salt, hash }, { claimLegacy, legacyFiles = [] } = {}) {
      return transaction(() => {
        const first = q.userCount.get().n === 0;
        q.insertUser.run(id, email, name, salt, hash, Date.now());
        if (first && claimLegacy) {
          q.claimElements.run(id);
          q.claimLocks.run(id);
          for (const f of legacyFiles) q.insertUpload.run(id, f.name, f.size, Date.now());
        }
        return first;
      });
    },
    setPassword: (id, salt, hash) => q.setPassword.run(salt, hash, id),
    setName: (id, name) => q.setName.run(name, id),
    // Removes the account and everything in it. Returns the upload names nobody else owns any more.
    deleteUser(id) {
      return transaction(() => {
        const names = q.userUploads.all(id).map((r) => r.name);
        q.clear.run(id);
        q.deleteLocks.run(id);
        q.deleteUploads.run(id);
        q.deleteUser.run(id);
        return names.filter((name) => q.uploadOwners.get(name).n === 0);
      });
    },

    // ----- sessions (only a hash of the token is stored)
    createSession(tokenHash, userId, maxAgeMs) {
      const now = Date.now();
      q.deleteExpired.run(now);
      q.insertSession.run(tokenHash, userId, now, now + maxAgeMs);
    },
    sessionUser: (tokenHash) => q.sessionUser.get(tokenHash, Date.now()) ?? null,
    deleteSession: (tokenHash) => q.deleteSession.run(tokenHash),
    deleteOtherSessions: (userId, keepHash) => q.deleteOtherSessions.run(userId, keepHash),

    // ----- uploaded files (stored once by content hash, owned per user)
    addUpload(userId, name, size) {
      q.insertUpload.run(userId, name, size, Date.now());
    },
    ownsUpload: (userId, name) => !!q.ownsUpload.get(userId, name),
    uploadsOf: (userId) => q.uploadsOf.all(userId),
    uploaders: () => q.uploaders.all().map((r) => r.user_id),
    // Every uploaded file any of the account's cards points at (in any field, any section, Trash included).
    referencedFiles(userId) {
      const names = new Set();
      for (const { data } of q.fileRefs.all(userId)) for (const m of data.matchAll(/\/files\/([0-9a-f]{16,64}(?:\.[a-z0-9]{1,8})?)/g)) names.add(m[1]);
      return names;
    },
    setOrphaned: (userId, name, at) => q.setOrphaned.run(at, userId, name),
    // Removes the account's claim on a file; returns true when no account owns it any more.
    releaseUpload(userId, name) {
      q.deleteUpload.run(userId, name);
      return q.uploadOwners.get(name).n === 0;
    },
    usedBytes: (userId) => q.usedBytes.get(userId).n,

    close() {
      db.close();
    },
  };
}
