const express = require('express');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const readline = require('readline');
const multer = require('multer');
const AdmZip = require('adm-zip');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const config = require('./config');

process.on('uncaughtException', (err) => { console.error('[UNCAUGHT]', err.stack || err); });
process.on('unhandledRejection', (err) => { console.error('[UNHANDLED]', err.stack || err); });
process.on('SIGTERM', () => { console.error('[SIGNAL] SIGTERM received'); });
process.on('SIGHUP', () => { console.error('[SIGNAL] SIGHUP received'); });
process.on('exit', (code) => { console.error('[EXIT] process exiting with code', code); });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.TRUST_PROXY);

const JSON_BODY_LIMIT = process.env.CCMOBILE_JSON_LIMIT || '40mb';
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 60 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_MESSAGE = 10;

app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
const cookieParser = require('cookie-parser');
app.use(cookieParser());

const upload = multer({ dest: '/tmp/ccmobile-uploads/', limits: { fileSize: MAX_UPLOAD_BYTES, files: 20 }, defParamCharset: 'utf8' });

// ========== Constants ==========
const HOME_DIR = config.HOME_DIR;
const USER_DATA_ROOT = config.USER_DATA_ROOT;
const SHARED_PROJECTS_ROOT = config.SHARED_PROJECTS_ROOT;
const CLAUDE_SESSIONS_ROOT = config.CLAUDE_SESSIONS_ROOT;
const FILE_HISTORY_ROOT = config.FILE_HISTORY_ROOT;

// Per-user session/file-history roots (Claude CLI writes to user's HOME)
function getUserSessionsRoot(username) {
  return path.join(USER_DATA_ROOT, username, '.claude', 'projects');
}
function getUserFileHistoryRoot(username) {
  return path.join(USER_DATA_ROOT, username, '.claude', 'file-history');
}
const activeSessions = new Map();
const authTokens = new Map(); // in-memory cache, backed by DB

// ========== Database Setup ==========
const DB_PATH = path.join(__dirname, 'data', 'ccmobile.db');
if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'));
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL,
    last_login TEXT
  );
  CREATE TABLE IF NOT EXISTS shared_projects (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    description TEXT DEFAULT '',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS project_access (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    requested_at TEXT NOT NULL,
    reviewed_at TEXT,
    reviewed_by TEXT,
    UNIQUE(project_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS session_names (
    session_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    user_id TEXT
  );
  CREATE TABLE IF NOT EXISTS session_codex_ids (
    claude_session_id TEXT PRIMARY KEY,
    codex_session_id TEXT,
    user_id TEXT
  );
  CREATE TABLE IF NOT EXISTS standalone_session_projects (
    session_id TEXT PRIMARY KEY,
    project_name TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS project_notes (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    user_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_notes_project ON project_notes(project);
  CREATE INDEX IF NOT EXISTS idx_access_project ON project_access(project_id);
  CREATE INDEX IF NOT EXISTS idx_access_user ON project_access(user_id);
  CREATE INDEX IF NOT EXISTS idx_standalone_user_project ON standalone_session_projects(user_id, project_name);
`);

// Add user_id columns if not exist (migration for existing DBs)
try { db.exec(`ALTER TABLE session_names ADD COLUMN user_id TEXT`); } catch {}
try { db.exec(`ALTER TABLE project_notes ADD COLUMN user_id TEXT`); } catch {}
// Migration: create session_codex_ids table if not exist (for older DBs)
try { db.exec(`CREATE TABLE IF NOT EXISTS session_codex_ids (claude_session_id TEXT PRIMARY KEY, codex_session_id TEXT, user_id TEXT)`); } catch {}
try { db.exec(`CREATE TABLE IF NOT EXISTS standalone_session_projects (session_id TEXT PRIMARY KEY, project_name TEXT NOT NULL, user_id TEXT NOT NULL, created_at TEXT NOT NULL)`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_standalone_user_project ON standalone_session_projects(user_id, project_name)`); } catch {}
// Migration: allow NULL codex_session_id for proactive pairing (existing DBs with NOT NULL)
try {
  const tblInfo = db.pragma('table_info(session_codex_ids)');
  const col = tblInfo.find(c => c.name === 'codex_session_id');
  if (col && col.notnull === 1) {
    db.exec(`
      CREATE TABLE session_codex_ids_tmp (claude_session_id TEXT PRIMARY KEY, codex_session_id TEXT, user_id TEXT);
      INSERT INTO session_codex_ids_tmp SELECT * FROM session_codex_ids;
      DROP TABLE session_codex_ids;
      ALTER TABLE session_codex_ids_tmp RENAME TO session_codex_ids;
    `);
  }
} catch {}
try { db.exec(`ALTER TABLE users ADD COLUMN has_onboarded INTEGER DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE users ADD COLUMN theme TEXT DEFAULT 'light'`); } catch {}

// Logging tables
db.exec(`
  CREATE TABLE IF NOT EXISTS system_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    event TEXT NOT NULL,
    user_id TEXT,
    username TEXT,
    detail TEXT
  );
  CREATE TABLE IF NOT EXISTS chat_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    project TEXT NOT NULL,
    project_type TEXT DEFAULT 'personal',
    session_id TEXT,
    message_preview TEXT,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    duration_ms INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_syslog_time ON system_logs(timestamp);
  CREATE INDEX IF NOT EXISTS idx_syslog_user ON system_logs(user_id);
  CREATE INDEX IF NOT EXISTS idx_chatlog_time ON chat_logs(timestamp);
  CREATE INDEX IF NOT EXISTS idx_chatlog_user ON chat_logs(user_id);

  CREATE TABLE IF NOT EXISTS auth_tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id);
`);

// ========== Logging Helpers ==========
function logSystem(event, userId, username, detail) {
  db.prepare('INSERT INTO system_logs (timestamp, level, event, user_id, username, detail) VALUES (?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), 'info', event, userId || null, username || null, detail || null);
}

function logChat(userId, username, project, projectType, sessionId, messagePreview, usage) {
  db.prepare('INSERT INTO chat_logs (timestamp, user_id, username, project, project_type, session_id, message_preview, input_tokens, output_tokens, cache_read_tokens, cost_usd, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), userId, username, project, projectType || 'personal', sessionId || null, (messagePreview || '').substring(0, 200), usage.inputTokens || 0, usage.outputTokens || 0, usage.cacheReadTokens || 0, usage.costUsd || 0, usage.durationMs || 0);
}

// ========== Initial Admin Setup ==========
function ensureAdminUser() {
  const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
  if (userCount === 0 && config.ADMIN_USER && config.ADMIN_PASS) {
    const id = crypto.randomUUID();
    const hash = bcrypt.hashSync(config.ADMIN_PASS, 10);
    db.prepare('INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, config.ADMIN_USER, hash, 'admin', new Date().toISOString());
    console.log(`  [init] Admin user "${config.ADMIN_USER}" created`);
  }
}

// ========== Ensure directories ==========
function ensureDirs() {
  if (!fs.existsSync(USER_DATA_ROOT)) fs.mkdirSync(USER_DATA_ROOT, { recursive: true });
  if (!fs.existsSync(SHARED_PROJECTS_ROOT)) fs.mkdirSync(SHARED_PROJECTS_ROOT, { recursive: true });
}

// ========== Auth Helpers ==========
const TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function validateToken(token) {
  if (!token) return null;
  // Check in-memory cache first
  let session = authTokens.get(token);
  if (session) {
    if (Date.now() > session.expiresAt) {
      authTokens.delete(token);
      db.prepare('DELETE FROM auth_tokens WHERE token = ?').run(token);
      return null;
    }
    // Refresh expiry
    session.expiresAt = Date.now() + TOKEN_EXPIRY_MS;
    db.prepare('UPDATE auth_tokens SET expires_at = ? WHERE token = ?').run(session.expiresAt, token);
    return session.user;
  }
  // Fallback: check DB (e.g. after server restart)
  const row = db.prepare('SELECT at.token, at.expires_at, u.id, u.username, u.role FROM auth_tokens at JOIN users u ON at.user_id = u.id WHERE at.token = ?').get(token);
  if (!row) return null;
  if (Date.now() > row.expires_at) {
    db.prepare('DELETE FROM auth_tokens WHERE token = ?').run(token);
    return null;
  }
  // Restore to in-memory cache
  const user = { id: row.id, username: row.username, role: row.role };
  const newExpiry = Date.now() + TOKEN_EXPIRY_MS;
  authTokens.set(token, { user, expiresAt: newExpiry });
  db.prepare('UPDATE auth_tokens SET expires_at = ? WHERE token = ?').run(newExpiry, token);
  return user;
}

function deleteUserTokens(userId) {
  const rows = db.prepare('SELECT token FROM auth_tokens WHERE user_id = ?').all(userId);
  for (const r of rows) authTokens.delete(r.token);
  db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').run(userId);
}

// Cleanup expired tokens periodically
setInterval(() => {
  const now = Date.now();
  db.prepare('DELETE FROM auth_tokens WHERE expires_at < ?').run(now);
  for (const [token, session] of authTokens) {
    if (now > session.expiresAt) authTokens.delete(token);
  }
}, 60 * 60 * 1000); // every hour

// ========== User Data Helpers ==========
function getUserHome(username) {
  return path.join(USER_DATA_ROOT, username);
}

function getUserProjectsDir(username) {
  return path.join(USER_DATA_ROOT, username, 'projects');
}

function getUserClaudeDir(username) {
  return path.join(USER_DATA_ROOT, username, '.claude');
}

function ensureUserDirs(username) {
  const home = getUserHome(username);
  const dirs = [
    path.join(home, 'projects'),
    path.join(home, '.claude'),
    path.join(home, '.claude', 'projects'),
    path.join(home, '.claude', 'file-history'),
    path.join(home, '.codex'),
  ];
  for (const d of dirs) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
  // Copy or refresh global Claude credentials for the user
  const globalCred = path.join(HOME_DIR, '.claude', '.credentials.json');
  const userCred = path.join(home, '.claude', '.credentials.json');
  if (fs.existsSync(globalCred)) {
    let needCopy = !fs.existsSync(userCred);
    if (!needCopy) {
      // Check if user's token has expired, refresh from global if so
      try {
        const cred = JSON.parse(fs.readFileSync(userCred, 'utf8'));
        const expiresAt = cred.claudeAiOauth?.expiresAt || 0;
        if (Date.now() > expiresAt) needCopy = true;
      } catch { needCopy = true; }
    }
    if (needCopy) {
      fs.copyFileSync(globalCred, userCred);
    }
  }
  // Copy or refresh global Codex auth for the user
  const globalCodexAuth = path.join(HOME_DIR, '.codex', 'auth.json');
  const userCodexAuth = path.join(home, '.codex', 'auth.json');
  if (fs.existsSync(globalCodexAuth)) {
    let needCopy = !fs.existsSync(userCodexAuth);
    if (!needCopy) {
      try {
        const auth = JSON.parse(fs.readFileSync(userCodexAuth, 'utf8'));
        // If no tokens or access_token is missing, re-copy
        if (!auth.tokens?.access_token) needCopy = true;
      } catch { needCopy = true; }
    }
    if (needCopy) {
      fs.copyFileSync(globalCodexAuth, userCodexAuth);
    }
  }
}

// ========== Check if Claude CLI is authenticated ==========
function isClaudeAuthed() {
  try {
    const credPath = path.join(HOME_DIR, '.claude', '.credentials.json');
    if (!fs.existsSync(credPath)) return false;
    const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    return !!(cred.claudeAiOauth?.accessToken || cred.apiKey);
  } catch { return false; }
}

// ========== Setup API (no auth required) ==========
app.get('/setup/status', (req, res) => {
  const backend = config.CLI_BACKEND;
  let cliFound, cliAuthed, cliPath;
  if (backend === 'codex') {
    cliPath = config.CODEX_CLI_PATH;
    cliFound = fs.existsSync(cliPath);
    cliAuthed = cliFound; // Codex auth checked at runtime via CODEX_API_KEY or login
  } else {
    cliPath = config.CLAUDE_CLI_PATH;
    cliFound = fs.existsSync(cliPath);
    cliAuthed = cliFound && isClaudeAuthed();
  }
  const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
  // Report both backend availabilities for per-session switching
  const claudeAvailable = fs.existsSync(config.CLAUDE_CLI_PATH);
  const codexAvailable = fs.existsSync(config.CODEX_CLI_PATH);
  res.json({
    configured: config.HAS_ENV && cliAuthed && userCount > 0,
    claudeCli: cliPath,
    claudeCliFound: cliFound,
    claudeAuthed: cliAuthed,
    sandbox: config.USE_SANDBOX,
    userCount,
    backend,
    claudeAvailable,
    codexAvailable
  });
});

// ========== Auth API (no token required) ==========
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BLOCK_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 8;
const loginFailures = new Map();

function loginRateKey(req, username) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  return `${ip}:${String(username || '').toLowerCase()}`;
}

function isLoginBlocked(key) {
  const entry = loginFailures.get(key);
  if (!entry) return false;
  if (entry.blockedUntil && entry.blockedUntil > Date.now()) return true;
  if (entry.firstFailure + LOGIN_WINDOW_MS < Date.now()) {
    loginFailures.delete(key);
    return false;
  }
  return false;
}

function recordLoginFailure(key) {
  const now = Date.now();
  const entry = loginFailures.get(key);
  if (!entry || entry.firstFailure + LOGIN_WINDOW_MS < now) {
    loginFailures.set(key, { count: 1, firstFailure: now, blockedUntil: 0 });
    return;
  }
  entry.count += 1;
  if (entry.count >= LOGIN_MAX_FAILURES) entry.blockedUntil = now + LOGIN_BLOCK_MS;
}

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const rateKey = loginRateKey(req, username);
  if (isLoginBlocked(rateKey)) {
    logSystem('login_rate_limited', null, username, `Too many failed attempts from ${req.ip || req.socket?.remoteAddress || 'unknown'}`);
    return res.status(429).json({ error: 'Too many failed login attempts. Try again later.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    recordLoginFailure(rateKey);
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  loginFailures.delete(rateKey);

  // Update last_login
  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(new Date().toISOString(), user.id);

  // Ensure user directories
  ensureUserDirs(username);

  // Generate token and persist
  const token = generateToken();
  const expiresAt = Date.now() + TOKEN_EXPIRY_MS;
  authTokens.set(token, {
    user: { id: user.id, username: user.username, role: user.role },
    expiresAt
  });
  db.prepare('INSERT INTO auth_tokens (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(token, user.id, expiresAt, new Date().toISOString());

  // Set httpOnly cookie for auto-login
  const isHttpsRequest = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.cookie('ccmobile_token', token, {
    httpOnly: true,
    secure: isHttpsRequest,
    maxAge: TOKEN_EXPIRY_MS,
    sameSite: 'lax',
    path: '/'
  });

  res.json({ ok: true, token, user: { id: user.id, username: user.username, role: user.role, hasOnboarded: !!user.has_onboarded, theme: user.theme || 'light' } });
  logSystem('login', user.id, user.username, `Login successful (role: ${user.role})`);
});

// ========== Auth Middleware ==========
app.use('/api', (req, res, next) => {
  // Allow login endpoint without token
  if (req.path === '/auth/login') return next();

  // Try Authorization header first, then cookie
  const authHeader = req.headers['authorization'] || '';
  let token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token && req.cookies) token = req.cookies.ccmobile_token || '';
  const user = validateToken(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  req.user = user;
  req.authToken = token;
  next();
});

// ========== Auth endpoints (token required) ==========
app.post('/api/auth/logout', (req, res) => {
  const token = req.authToken;
  if (token) {
    authTokens.delete(token);
    db.prepare('DELETE FROM auth_tokens WHERE token = ?').run(token);
  }
  res.clearCookie('ccmobile_token', { path: '/' });
  logSystem('logout', req.user.id, req.user.username, null);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const user = db.prepare('SELECT has_onboarded, theme FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: { ...req.user, hasOnboarded: !!(user && user.has_onboarded), theme: (user && user.theme) || 'light' } });
});

app.post('/api/auth/complete-onboarding', (req, res) => {
  db.prepare('UPDATE users SET has_onboarded = 1 WHERE id = ?').run(req.user.id);
  res.json({ ok: true });
});

app.put('/api/auth/theme', (req, res) => {
  const { theme } = req.body;
  if (theme !== 'light' && theme !== 'dark') return res.status(400).json({ error: 'Invalid theme' });
  db.prepare('UPDATE users SET theme = ? WHERE id = ?').run(theme, req.user.id);
  res.json({ ok: true });
});

app.post('/api/auth/change-password', (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) return res.status(400).json({ error: 'Both old and new password required' });
  if (newPassword.length < 4) return res.status(400).json({ error: 'Password too short (min 4 chars)' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(oldPassword, user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
  res.json({ ok: true });
});

// ========== Admin Middleware ==========
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin required' });
  next();
}

// ========== Static Files ==========
app.use(express.static('application/public'));

// ========== Helper Functions ==========

function projectToSessionDir(projectPath) {
  // Claude CLI replaces both '/' and '_' with '-' when creating session directories
  return projectPath.replace(/[/_]/g, '-').replace(/^-/, '-');
}

function findClaudeMd(dir) {
  try {
    const f = fs.readdirSync(dir).find(n => n.toLowerCase() === 'claude.md');
    return f ? path.join(dir, f) : null;
  } catch { return null; }
}

function buildProjectInfo(fullPath, name, type, username) {
  const sessionDir = path.join(getUserSessionsRoot(username), projectToSessionDir(fullPath));
  let sessionCount = 0;
  if (fs.existsSync(sessionDir)) {
    sessionCount = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl')).length;
  }
  return {
    name, path: fullPath, type,
    hasGit: fs.existsSync(path.join(fullPath, '.git')) && (() => { try { execSync('git remote get-url origin', { cwd: fullPath, stdio: 'ignore' }); return true; } catch { return false; } })(),
    hasClaudeMd: !!findClaudeMd(fullPath),
    sessionCount
  };
}

function standaloneProjectNameFromDate(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `chat-${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

function getStandaloneProjectRows(userId) {
  return db.prepare('SELECT session_id, project_name FROM standalone_session_projects WHERE user_id = ?').all(userId);
}

function isStandaloneProject(userId, projectName) {
  return !!db.prepare('SELECT 1 FROM standalone_session_projects WHERE user_id = ? AND project_name = ? LIMIT 1').get(userId, projectName);
}

// Build bwrap sandbox args for a user + project
function buildUserSandboxArgs(username, projectDir, cliPath, cliArgs) {
  const userHome = getUserHome(username);
  const userClaudeDir = getUserClaudeDir(username);

  // Ensure required user directories exist
  ensureUserDirs(username);

  const args = [
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/lib', '/lib',
    '--ro-bind', '/lib64', '/lib64',
    '--ro-bind', '/bin', '/bin',
    '--ro-bind', '/sbin', '/sbin',
    '--ro-bind', '/etc', '/etc',
    '--ro-bind', '/run', '/run',
    '--dev', '/dev',
    '--proc', '/proc',
    '--bind', '/tmp', '/tmp',
    '--bind', projectDir, projectDir,
    '--bind', userHome, userHome,
    '--chdir', projectDir,
    '--share-net',
    cliPath, ...cliArgs
  ];
  return args;
}

// Resolve project path for a user (personal or shared)
function isPathInside(root, target) {
  const rootPath = path.resolve(root);
  const targetPath = path.resolve(target);
  const rel = path.relative(rootPath, targetPath);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function resolveInside(root, unsafePath) {
  const resolved = path.resolve(root, unsafePath || '');
  return isPathInside(root, resolved) ? resolved : null;
}

function safeProjectName(projectName) {
  if (!projectName || typeof projectName !== 'string') return null;
  const trimmed = projectName.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return null;
  if (path.basename(trimmed) !== trimmed) return null;
  if (!/^[a-zA-Z0-9_.-]+$/.test(trimmed)) return null;
  return trimmed;
}

function resolveUserProjectPath(user, projectName, projectType) {
  const username = typeof user === 'string' ? user : user?.username;
  const userId = typeof user === 'string' ? null : user?.id;
  const role = typeof user === 'string' ? 'user' : user?.role;
  const projName = safeProjectName(projectName);
  if (!projName || !username) return null;

  if (projectType === 'shared') {
    const project = db.prepare('SELECT id FROM shared_projects WHERE name = ?').get(projName);
    if (!project) return null;
    if (role !== 'admin' && (!userId || !userHasSharedAccess(userId, project.id))) return null;
    const sharedPath = path.resolve(SHARED_PROJECTS_ROOT, projName);
    return isPathInside(SHARED_PROJECTS_ROOT, sharedPath) ? sharedPath : null;
  }

  const personalRoot = getUserProjectsDir(username);
  const personalPath = path.resolve(personalRoot, projName);
  return isPathInside(personalRoot, personalPath) ? personalPath : null;
}

function isAllowedFilePath(user, filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const target = path.resolve(filePath);
  const userHome = getUserHome(user.username);
  if (isPathInside(userHome, target)) return true;
  if (!isPathInside(SHARED_PROJECTS_ROOT, target)) return false;

  const rel = path.relative(path.resolve(SHARED_PROJECTS_ROOT), target);
  const projectName = rel.split(path.sep)[0];
  const project = safeProjectName(projectName) && db.prepare('SELECT id FROM shared_projects WHERE name = ?').get(projectName);
  if (!project) return false;
  return user.role === 'admin' || userHasSharedAccess(user.id, project.id);
}

function safeUploadFileName(name) {
  const base = path.basename(name || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160);
  if (!base || base === '.' || base === '..') return null;
  return base;
}

// Check if user has access to a shared project
function userHasSharedAccess(userId, projectId) {
  const access = db.prepare('SELECT status FROM project_access WHERE user_id = ? AND project_id = ? AND status = ?').get(userId, projectId, 'approved');
  return !!access;
}

// Parse JSONL session file
function parseSessionJSONL(filePath) {
  return new Promise((resolve) => {
    const userMessages = new Map();
    const snapshotGroups = new Map();
    const allMessages = [];
    let customTitle = null;

    const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
    rl.on('line', (line) => {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'custom-title') {
          customTitle = obj.customTitle || null;
        }
        if (obj.type === 'user' && !obj.isMeta) {
          let content = obj.message?.content || '';
          if (Array.isArray(content)) content = content.find(b => b.type === 'text')?.text || '';
          if (typeof content === 'string' && !content.startsWith('<') && content.trim().length > 0) {
            userMessages.set(obj.uuid, { content: content.substring(0, 120), timestamp: obj.timestamp });
            allMessages.push({ role: 'user', content, ts: obj.timestamp, uuid: obj.uuid });
          }
        }
        if (obj.type === 'assistant' && obj.message?.content) {
          let text = '';
          const tools = [];
          for (const block of obj.message.content) {
            if (block.type === 'text' && block.text) text += block.text;
            if (block.type === 'tool_use') tools.push({ name: block.name, input: block.input });
          }
          if (text || tools.length) {
            allMessages.push({ role: 'assistant', content: text, tools, ts: obj.timestamp });
          }
        }
        if (obj.type === 'file-history-snapshot' && obj.snapshot?.messageId) {
          snapshotGroups.set(obj.snapshot.messageId, obj.snapshot);
        }
      } catch {}
    });
    rl.on('close', () => resolve({ userMessages, snapshotGroups, allMessages, customTitle }));
  });
}

function getSessionJSONLPath(username, projectPath, sessionId, createDir = false) {
  if (!sessionId) return null;
  const sessionDir = path.join(getUserSessionsRoot(username), projectToSessionDir(projectPath));
  if (createDir && !fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
  return path.join(sessionDir, `${sessionId}.jsonl`);
}

async function collectProjectSessions(user, projectName, projectType, projectPath, options = {}) {
  const sessionDir = path.join(getUserSessionsRoot(user.username), projectToSessionDir(projectPath));
  if (!fs.existsSync(sessionDir)) return [];

  const standaloneRows = getStandaloneProjectRows(user.id);
  const standaloneBySession = new Map(standaloneRows.map(r => [r.session_id, r.project_name]));
  const standaloneProject = isStandaloneProject(user.id, projectName);
  const sessions = [];

  for (const file of fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'))) {
    const sessionId = file.replace('.jsonl', '');
    const filePath = path.join(sessionDir, file);
    const stat = fs.statSync(filePath);
    const rowProject = standaloneBySession.get(sessionId);
    const standalone = standaloneProject || rowProject === projectName;
    if (options.onlyStandalone && !standalone) continue;
    if (options.excludeStandalone && standalone) continue;
    try {
      const { allMessages, customTitle } = await parseSessionJSONL(filePath);
      if (allMessages.length === 0) continue;
      const firstUser = allMessages.find(m => m.role === 'user');
      const last = allMessages[allMessages.length - 1];
      sessions.push({
        sessionId,
        firstMessage: firstUser ? firstUser.content.substring(0, 120) : null,
        customTitle: customTitle || null,
        lastTimestamp: last.ts || stat.mtime.toISOString(),
        messageCount: allMessages.filter(m => m.role === 'user').length,
        mtime: stat.mtime.getTime(),
        projectName,
        projectType,
        standalone
      });
    } catch {}
  }

  sessions.sort((a, b) => b.mtime - a.mtime);
  if (sessions.length) {
    const placeholders = sessions.map(() => '?').join(',');
    const ids = sessions.map(s => s.sessionId);
    const nameRows = db.prepare(`SELECT session_id, name FROM session_names WHERE session_id IN (${placeholders})`).all(...ids);
    const nameMap = Object.fromEntries(nameRows.map(r => [r.session_id, r.name]));
    const codexRows = db.prepare(`SELECT claude_session_id, codex_session_id FROM session_codex_ids WHERE claude_session_id IN (${placeholders})`).all(...ids);
    const codexMap = Object.fromEntries(codexRows.map(r => [r.claude_session_id, r.codex_session_id]));
    for (const s of sessions) {
      s.customName = nameMap[s.sessionId] || s.customTitle || null;
      s.codexSessionId = codexMap[s.sessionId] || null;
    }
  }
  return sessions;
}

async function collectAllSessionOverview(user) {
  const projects = [];
  const standalone = [];
  const personalDir = getUserProjectsDir(user.username);

  if (fs.existsSync(personalDir)) {
    const dirs = fs.readdirSync(personalDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'));
    for (const d of dirs) {
      const projectPath = path.join(personalDir, d.name);
      const projectSessions = await collectProjectSessions(user, d.name, 'personal', projectPath);
      if (isStandaloneProject(user.id, d.name)) {
        standalone.push(...projectSessions.map(s => ({ ...s, standalone: true })));
      } else {
        projects.push({ name: d.name, type: 'personal', sessions: projectSessions.filter(s => !s.standalone) });
      }
    }
  }

  const sharedProjects = db.prepare('SELECT * FROM shared_projects').all();
  for (const sp of sharedProjects) {
    const hasAccess = user.role === 'admin' || userHasSharedAccess(user.id, sp.id);
    const projectPath = path.join(SHARED_PROJECTS_ROOT, sp.name);
    if (!hasAccess || !fs.existsSync(projectPath)) continue;
    const sessions = await collectProjectSessions(user, sp.name, 'shared', projectPath, { excludeStandalone: true });
    projects.push({ name: sp.name, type: 'shared', sessions, description: sp.description });
  }

  projects.sort((a, b) => {
    const am = a.sessions[0]?.mtime || 0;
    const bm = b.sessions[0]?.mtime || 0;
    return bm - am || a.name.localeCompare(b.name);
  });
  standalone.sort((a, b) => b.mtime - a.mtime);
  const all = [...projects.flatMap(p => p.sessions), ...standalone].sort((a, b) => b.mtime - a.mtime);
  return { latest: all[0] || null, projects, standalone, sessions: all };
}

function readSessionTranscriptForPrompt(filePath, maxChars = 60000) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  const turns = [];
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'user' && !obj.isMeta) {
        let content = obj.message?.content || '';
        if (Array.isArray(content)) content = content.find(b => b.type === 'text')?.text || '';
        if (typeof content === 'string' && content.trim()) turns.push(`User: ${content.trim()}`);
      } else if (obj.type === 'assistant' && obj.message?.content) {
        let text = '';
        for (const block of obj.message.content) {
          if (block.type === 'text' && block.text) text += block.text;
        }
        if (text.trim()) turns.push(`Assistant: ${text.trim()}`);
      }
    } catch {}
  }
  const transcript = turns.join('\n\n');
  if (transcript.length <= maxChars) return transcript;
  const headChars = Math.min(20000, Math.floor(maxChars / 3));
  const tailChars = maxChars - headChars;
  return [
    transcript.slice(0, headChars),
    '\n\n[...middle of this conversation omitted to fit context...]\n\n',
    transcript.slice(-tailChars)
  ].join('');
}

function appendCodexTranscript(session, userText, assistantText) {
  if (!session?.username || !session?.projectPath || !session?.claudeSessionId) return;
  if (!assistantText || !assistantText.trim()) return;
  const filePath = getSessionJSONLPath(session.username, session.projectPath, session.claudeSessionId, true);
  const now = new Date();
  const userUuid = crypto.randomUUID();
  const assistantUuid = crypto.randomUUID();
  const lines = [
    {
      type: 'user',
      uuid: userUuid,
      timestamp: now.toISOString(),
      message: { role: 'user', content: userText || '' }
    },
    {
      type: 'assistant',
      uuid: assistantUuid,
      parentUuid: userUuid,
      timestamp: new Date(now.getTime() + 1).toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: assistantText }] },
      ccmobileBackend: 'codex',
      codexSessionId: session.codexSessionId || null
    }
  ];
  fs.appendFileSync(filePath, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
}

// ========== Projects API ==========

// List user's projects (personal + authorized shared)
app.get('/api/projects', (req, res) => {
  const { username, id: userId } = req.user;
  const projects = [];

  // Personal projects
  const personalDir = getUserProjectsDir(username);
  if (fs.existsSync(personalDir)) {
    const dirs = fs.readdirSync(personalDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'));
    for (const d of dirs) {
      if (isStandaloneProject(userId, d.name)) continue;
      projects.push(buildProjectInfo(path.join(personalDir, d.name), d.name, 'personal', username));
    }
  }

  // Shared projects (approved access or admin)
  const sharedProjects = db.prepare('SELECT * FROM shared_projects').all();
  for (const sp of sharedProjects) {
    const hasAccess = req.user.role === 'admin' || userHasSharedAccess(userId, sp.id);
    if (hasAccess) {
      const spPath = path.join(SHARED_PROJECTS_ROOT, sp.name);
      if (fs.existsSync(spPath)) {
        projects.push({ ...buildProjectInfo(spPath, sp.name, 'shared', username), description: sp.description });
      }
    }
  }

  res.json({ projects });
});

// Create a personal project
app.post('/api/projects/create', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Project name required' });
  const projName = safeProjectName(name.trim().replace(/[^a-zA-Z0-9_\-\.]/g, '-'));
  if (!projName) return res.status(400).json({ error: 'Invalid project name' });

  const userProjDir = getUserProjectsDir(req.user.username);
  const projPath = path.join(userProjDir, projName);
  if (fs.existsSync(projPath)) return res.status(409).json({ error: 'Project already exists' });

  fs.mkdirSync(projPath, { recursive: true });
  logSystem('create_project', req.user.id, req.user.username, `Created personal project "${projName}"`);
  res.json({ ok: true, name: projName, type: 'personal' });
});

// Create a shared project (by any user, with user sharing list)
app.post('/api/projects/create-shared', (req, res) => {
  const { name, description, sharedWith } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Project name required' });
  const projName = safeProjectName(name.trim().replace(/[^a-zA-Z0-9_\-\.]/g, '-'));
  if (!projName) return res.status(400).json({ error: 'Invalid project name' });

  const existing = db.prepare('SELECT id FROM shared_projects WHERE name = ?').get(projName);
  if (existing) return res.status(409).json({ error: 'Shared project name already exists' });

  // Create directory
  const projPath = path.join(SHARED_PROJECTS_ROOT, projName);
  if (!fs.existsSync(projPath)) fs.mkdirSync(projPath, { recursive: true });

  const id = crypto.randomUUID();
  db.prepare('INSERT INTO shared_projects (id, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, projName, description || '', req.user.id, new Date().toISOString());

  // Auto-approve creator
  const accessId = crypto.randomUUID();
  db.prepare('INSERT INTO project_access (id, project_id, user_id, status, requested_at, reviewed_at, reviewed_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(accessId, id, req.user.id, 'approved', new Date().toISOString(), new Date().toISOString(), req.user.id);

  // Share with selected users (auto-approve)
  if (Array.isArray(sharedWith) && sharedWith.length > 0) {
    for (const userId of sharedWith) {
      if (userId === req.user.id) continue;
      const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
      if (!user) continue;
      const aid = crypto.randomUUID();
      db.prepare('INSERT OR IGNORE INTO project_access (id, project_id, user_id, status, requested_at, reviewed_at, reviewed_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(aid, id, userId, 'approved', new Date().toISOString(), new Date().toISOString(), req.user.id);
    }
  }

  logSystem('create_shared_project', req.user.id, req.user.username, `Created shared project "${projName}" (shared with ${(sharedWith || []).length} users)`);
  res.json({ ok: true, name: projName, type: 'shared', id });
});

// Get user list for sharing (all users except self)
app.get('/api/users/list', (req, res) => {
  const users = db.prepare('SELECT id, username, role FROM users WHERE id != ? ORDER BY username').all(req.user.id);
  res.json(users);
});

// ========== CLAUDE.md ==========
app.get('/api/projects/:name/claude-md', (req, res) => {
  const projectPath = resolveUserProjectPath(req.user, req.params.name, req.query.type || 'personal');
  if (!projectPath || !fs.existsSync(projectPath)) return res.status(404).json({ error: 'Project not found' });
  const mdPath = findClaudeMd(projectPath);
  if (!mdPath) return res.json({ exists: false, content: '' });
  res.json({ exists: true, content: fs.readFileSync(mdPath, 'utf8') });
});

app.put('/api/projects/:name/claude-md', (req, res) => {
  const projectPath = resolveUserProjectPath(req.user, req.params.name, req.query.type || 'personal');
  if (!projectPath || !fs.existsSync(projectPath)) return res.status(404).json({ error: 'Project not found' });
  const mdPath = findClaudeMd(projectPath) || path.join(projectPath, 'CLAUDE.md');
  try {
    fs.writeFileSync(mdPath, req.body.content || '');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== Sessions API ==========
app.get('/api/projects/:name/sessions', async (req, res) => {
  const projectPath = resolveUserProjectPath(req.user, req.params.name, req.query.type || 'personal');
  if (!projectPath || !fs.existsSync(projectPath)) return res.json([]);
  const sessions = await collectProjectSessions(req.user, req.params.name, req.query.type || 'personal', projectPath);
  res.json(sessions);
});

app.get('/api/sessions/overview', async (req, res) => {
  try {
    res.json(await collectAllSessionOverview(req.user));
  } catch (e) {
    console.error('[sessions overview]', e);
    res.status(500).json({ error: 'Failed to load sessions' });
  }
});

app.put('/api/sessions/:sessionId/name', (req, res) => {
  const { sessionId } = req.params;
  const { name, project, type } = req.body;
  const trimmed = (name || '').trim();
  if (!trimmed) {
    db.prepare('DELETE FROM session_names WHERE session_id = ?').run(sessionId);
  } else {
    db.prepare('INSERT OR REPLACE INTO session_names (session_id, name, user_id) VALUES (?, ?, ?)').run(sessionId, trimmed, req.user.id);
  }
  if (project) {
    const projectPath = resolveUserProjectPath(req.user, project, type || 'personal');
    if (!projectPath || !fs.existsSync(projectPath)) return res.status(404).json({ error: 'Project not found' });
    const sessionDir = path.join(getUserSessionsRoot(req.user.username), projectToSessionDir(projectPath));
    const jsonlPath = path.join(sessionDir, `${sessionId}.jsonl`);
    if (fs.existsSync(jsonlPath)) {
      const titleLine = JSON.stringify({ type: 'custom-title', customTitle: trimmed || '', sessionId }) + '\n';
      try { fs.appendFileSync(jsonlPath, titleLine); } catch {}
    }
  }
  res.json({ ok: true });
});

app.get('/api/sessions/:sessionId/messages', async (req, res) => {
  const { sessionId } = req.params;
  const projectName = req.query.project;
  const projectType = req.query.type || 'personal';
  if (!projectName) return res.status(400).json({ error: 'project query param required' });

  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const before = req.query.before != null ? parseInt(req.query.before) : null;

  const projectPath = resolveUserProjectPath(req.user, projectName, projectType);
  if (!projectPath || !fs.existsSync(projectPath)) return res.status(404).json({ error: 'Project not found' });
  const sessionDir = path.join(getUserSessionsRoot(req.user.username), projectToSessionDir(projectPath));
  const filePath = path.join(sessionDir, `${sessionId}.jsonl`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Session not found' });

  const { allMessages } = await parseSessionJSONL(filePath);
  const total = allMessages.length;
  let end = before != null ? before : total;
  let start = Math.max(0, end - limit);
  const indexed = allMessages.slice(start, end).map((m, i) => ({ ...m, idx: start + i }));
  res.json({ messages: indexed, total, hasMore: start > 0 });
});

// Create a new chat session
app.post('/api/sessions', (req, res) => {
  let { projectName, type, standalone } = req.body;
  let projectType = type || 'personal';
  if (standalone) {
    projectType = 'personal';
    const userProjDir = getUserProjectsDir(req.user.username);
    if (!fs.existsSync(userProjDir)) fs.mkdirSync(userProjDir, { recursive: true });
    do {
      projectName = standaloneProjectNameFromDate();
    } while (fs.existsSync(path.join(userProjDir, projectName)));
    fs.mkdirSync(path.join(userProjDir, projectName), { recursive: true });
  }
  if (!projectName) return res.status(400).json({ error: 'projectName is required' });
  const projectPath = resolveUserProjectPath(req.user, projectName, projectType);
  if (!projectPath || !fs.existsSync(projectPath)) return res.status(404).json({ error: 'Project not found' });

  const id = crypto.randomUUID();
  const ccmobileSessionId = crypto.randomUUID();
  if (standalone) {
    db.prepare('INSERT OR REPLACE INTO standalone_session_projects (session_id, project_name, user_id, created_at) VALUES (?, ?, ?, ?)')
      .run(ccmobileSessionId, projectName, req.user.id, new Date().toISOString());
  }
  activeSessions.set(id, { ccmobileSessionId, claudeSessionId: null, codexSessionId: null, projectPath, projectName, projectType, standalone: !!standalone, username: req.user.username, lastActive: Date.now() });
  res.json({ id, projectPath, projectName, projectType, standalone: !!standalone });
});

// Resume an existing session (claude or codex)
app.post('/api/sessions/resume', (req, res) => {
  const { projectName, claudeSessionId, codexSessionId, type } = req.body;
  if (!projectName) return res.status(400).json({ error: 'projectName is required' });
  const projectType = type || 'personal';
  const projectPath = resolveUserProjectPath(req.user, projectName, projectType);
  if (!projectPath || !fs.existsSync(projectPath)) return res.status(404).json({ error: 'Project not found' });

  // Load codexSessionId from DB if not provided but claudeSessionId is given
  let effectiveCodexId = codexSessionId || null;
  if (claudeSessionId && !effectiveCodexId) {
    try {
      const row = db.prepare('SELECT codex_session_id FROM session_codex_ids WHERE claude_session_id = ?').get(claudeSessionId);
      if (row) effectiveCodexId = row.codex_session_id;
    } catch {}
  }

  // Check if there's already an active running session for this session ID
  for (const [existingId, s] of activeSessions) {
    const matchClaude = claudeSessionId && s.claudeSessionId === claudeSessionId;
    const matchCodex = effectiveCodexId && s.codexSessionId === effectiveCodexId;
    if ((matchClaude || matchCodex) && s.username === req.user.username && s.childProcess && !s.childProcess.killed) {
      s.lastActive = Date.now();
      return res.json({ id: existingId, claudeSessionId: s.claudeSessionId, codexSessionId: s.codexSessionId, projectPath, projectName, running: true });
    }
  }

  const id = crypto.randomUUID();
  activeSessions.set(id, { ccmobileSessionId: claudeSessionId || crypto.randomUUID(), claudeSessionId: claudeSessionId || null, codexSessionId: effectiveCodexId, projectPath, projectName, projectType, username: req.user.username, lastActive: Date.now() });
  res.json({ id, claudeSessionId: claudeSessionId || null, codexSessionId: effectiveCodexId, projectPath, projectName, running: false });
});

// Send message and stream response via SSE
app.post('/api/sessions/:id/message', (req, res) => {
  const session = activeSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  session.lastActive = Date.now();

  const { message, images, files, model, effort, backend: reqBackend } = req.body;
  const backend = (reqBackend === 'codex' || reqBackend === 'claude') ? reqBackend : config.CLI_BACKEND; // per-session override

  // Validate model selection based on backend
  let selectedModel;
  let selectedEffort;
  if (backend === 'codex') {
    selectedModel = config.CODEX_MODEL;
    const ALLOWED_EFFORTS = ['low', 'medium', 'high'];
    selectedEffort = ALLOWED_EFFORTS.includes((effort || '').toLowerCase()) ? effort.toLowerCase() : config.CODEX_EFFORT;
  } else {
    const ALLOWED_MODELS = ['opus', 'sonnet'];
    selectedModel = ALLOWED_MODELS.includes(model) ? model : config.CLAUDE_MODEL;
  }

  // Save chat attachments inside the project so Codex can read them.
  const tempFiles = [];
  const imageInputFiles = [];
  const attachedFiles = [];
  const attachmentSessionId = session.claudeSessionId || session.ccmobileSessionId || req.params.id || crypto.randomUUID();
  function safeAttachmentName(name) {
    const base = path.basename(name || 'attachment').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
    return base || 'attachment';
  }
  function extForMime(mimeType, fallbackName) {
    const ext = path.extname(fallbackName || '');
    if (ext) return ext;
    if (mimeType === 'image/png') return '.png';
    if (mimeType === 'image/gif') return '.gif';
    if (mimeType === 'image/webp') return '.webp';
    if (mimeType === 'image/svg+xml') return '.svg';
    if (mimeType === 'application/pdf') return '.pdf';
    if (mimeType === 'text/plain') return '.txt';
    return '.bin';
  }
  let totalAttachmentBytes = 0;
  function decodeAttachmentData(data) {
    if (!data || typeof data !== 'string') return null;
    const normalized = data.includes(',') ? data.split(',').pop() : data;
    const buf = Buffer.from(normalized, 'base64');
    totalAttachmentBytes += buf.length;
    if (buf.length > MAX_ATTACHMENT_BYTES || totalAttachmentBytes > MAX_TOTAL_ATTACHMENT_BYTES) return null;
    return buf;
  }
  if (Array.isArray(images) && images.length > 0) {
    const imgDir = path.join(session.projectPath, '.ccmobile-tmp');
    if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
    for (const img of images.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)) {
      const buf = decodeAttachmentData(img?.data);
      if (!buf) return res.status(413).json({ error: 'Attachment too large' });
      const ext = img.mimeType === 'image/png' ? '.png' : img.mimeType === 'image/gif' ? '.gif' : img.mimeType === 'image/webp' ? '.webp' : '.jpg';
      const tmpPath = path.join(imgDir, `${crypto.randomUUID()}${ext}`);
      fs.writeFileSync(tmpPath, buf);
      tempFiles.push(tmpPath);
      imageInputFiles.push(tmpPath);
    }
  }
  if (Array.isArray(files) && files.length > 0) {
    const attachDir = path.join(session.projectPath, '.ccmobile-attachments', attachmentSessionId);
    if (!fs.existsSync(attachDir)) fs.mkdirSync(attachDir, { recursive: true });
    for (const file of files.slice(0, MAX_ATTACHMENTS_PER_MESSAGE)) {
      const buf = decodeAttachmentData(file?.data);
      if (!buf) return res.status(413).json({ error: 'Attachment too large' });
      const originalName = safeAttachmentName(file.name || 'attachment');
      const ext = extForMime(file.mimeType, originalName);
      const nameWithExt = path.extname(originalName) ? originalName : originalName + ext;
      const destPath = path.join(attachDir, `${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${nameWithExt}`);
      fs.writeFileSync(destPath, buf);
      attachedFiles.push({ name: originalName || nameWithExt, path: destPath, mimeType: file.mimeType || 'application/octet-stream' });
      if ((file.mimeType || '').startsWith('image/')) imageInputFiles.push(destPath);
    }
  }

  const originalUserPrompt = message || '';
  const logMessagePreview = originalUserPrompt || (Array.isArray(files) && files.length ? 'Please look at the attached file(s).' : 'Please look at the attached image(s).');
  let prompt = originalUserPrompt;
  if (imageInputFiles.length > 0) {
    prompt += '\n\n' + imageInputFiles.map(f => `[Attached image: ${f}]`).join('\n');
  }
  if (attachedFiles.length > 0) {
    prompt += '\n\nAttached files saved in the project. Read them if needed:\n' +
      attachedFiles.map(f => `- ${f.name}: ${f.path} (${f.mimeType})`).join('\n');
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  let resAlive = true;
  function sseSend(data) {
    if (!resAlive) return;
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { resAlive = false; }
  }

  let child;
  const username = session.username;
  const userHome = getUserHome(username);

  if (backend === 'codex') {
    // ===== Codex CLI backend =====
    // Ensure user dirs + auth credentials exist before spawn
    ensureUserDirs(username);

    if (!session.claudeSessionId) {
      session.claudeSessionId = session.ccmobileSessionId || crypto.randomUUID();
    }

    const priorHistoryPath = getSessionJSONLPath(username, session.projectPath, session.claudeSessionId, false);
    const priorTranscript = readSessionTranscriptForPrompt(priorHistoryPath);
    if (priorTranscript) {
      prompt = [
        'Previous conversation context from the currently selected ccmobile conversation:',
        priorTranscript,
        '',
        'Use only that conversation as prior chat context. Ignore any unrelated Codex thread memory.',
        'Answer the latest user message below.',
        '',
        prompt
      ].join('\n');
    }

    // Use ccmobile JSONL as the source of truth for chat history. Starting a fresh
    // Codex exec avoids stale or mismatched Codex threads leaking another session.
    const codexArgs = ['exec', '--json', '--sandbox', 'danger-full-access', '--skip-git-repo-check', '-C', session.projectPath];
    if (selectedModel) codexArgs.push('--model', selectedModel);
    if (selectedEffort) codexArgs.push('-c', `model_reasoning_effort="${selectedEffort}"`);
    codexArgs.push(prompt);
    if (imageInputFiles.length > 0) {
      for (const imgPath of imageInputFiles) codexArgs.push('--image', imgPath);
    }

    if (config.USE_SANDBOX) {
      const bwrapArgs = buildUserSandboxArgs(username, session.projectPath, config.CODEX_CLI_PATH, codexArgs);
      console.log(`[spawn] bwrap sandbox (codex) for ${username}@${session.projectPath}`);
      child = spawn(config.BWRAP_PATH, bwrapArgs, {
        env: { ...process.env, HOME: userHome, CODEX_HOME: path.join(userHome, '.codex') },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true
      });
    } else {
      console.log(`[spawn] direct codex for ${username}@${session.projectPath}`);
      child = spawn(config.CODEX_CLI_PATH, codexArgs, {
        cwd: session.projectPath,
        env: { ...process.env, HOME: userHome, CODEX_HOME: path.join(userHome, '.codex') },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true
      });
    }
  } else {
    // ===== Claude CLI backend (default) =====
    const claudeArgs = ['-p', '--output-format', 'stream-json', '--verbose', '--model', selectedModel];
    if (session.claudeSessionId) {
      claudeArgs.push('--resume', session.claudeSessionId);
    }
    claudeArgs.push('--dangerously-skip-permissions');

    if (config.USE_SANDBOX) {
      const bwrapArgs = buildUserSandboxArgs(username, session.projectPath, config.CLAUDE_CLI_PATH, claudeArgs);
      console.log(`[spawn] bwrap sandbox (claude) for ${username}@${session.projectPath}`);
      child = spawn(config.BWRAP_PATH, bwrapArgs, {
        env: { ...process.env, HOME: userHome },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true
      });
    } else {
      console.log(`[spawn] direct claude for ${username}@${session.projectPath}`);
      child = spawn(config.CLAUDE_CLI_PATH, claudeArgs, {
        cwd: session.projectPath,
        env: { ...process.env, HOME: userHome },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true
      });
    }
  }

  session.childProcess = child;

  // For Claude, write prompt to stdin; for Codex, prompt is in args
  if (backend !== 'codex') {
    child.stdin.write(prompt);
    child.stdin.end();
  } else {
    child.stdin.end();
  }

  function cleanupTempFiles() {
    for (const f of tempFiles) {
      try { fs.unlinkSync(f); } catch {}
    }
    const imgDir = path.join(session.projectPath, '.ccmobile-tmp');
    try { fs.rmSync(imgDir, { recursive: true, force: true }); } catch {}
  }

  let fullText = '';
  let buffer = '';

  child.on('error', (err) => {
    console.error('[spawn error]', err);
    sseSend({ type: 'error', text: err.message });
  });

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);

        if (backend === 'codex') {
          // ===== Codex JSONL event parsing =====
          if (evt.type === 'thread.started') {
            session.codexSessionId = evt.thread_id;
            // Persist codex session ID mapping to DB (update existing row or insert new)
            if (session.claudeSessionId) {
              try { db.prepare('INSERT OR REPLACE INTO session_codex_ids (claude_session_id, codex_session_id, user_id) VALUES (?, ?, ?)').run(session.claudeSessionId, evt.thread_id, req.user.id); } catch {}
            }
            sseSend({ type: 'init', sessionId: evt.thread_id, historySessionId: session.claudeSessionId, backend: 'codex' });
          }
          else if (evt.type === 'item.started' && evt.item) {
            if (evt.item.type === 'command_execution') {
              sseSend({ type: 'tool_use', name: 'command', input: { command: evt.item.command } });
            } else if (evt.item.type === 'file_change') {
              sseSend({ type: 'tool_use', name: 'file_edit', input: { file: evt.item.file, status: 'started' } });
            }
          }
          else if (evt.type === 'item.completed' && evt.item) {
            if (evt.item.type === 'agent_message') {
              const text = evt.item.text || '';
              fullText += text;
              sseSend({ type: 'text', text });
            } else if (evt.item.type === 'command_execution') {
              sseSend({ type: 'tool_use', name: 'command', input: { command: evt.item.command, exit_code: evt.item.exit_code } });
            } else if (evt.item.type === 'file_change') {
              sseSend({ type: 'tool_use', name: 'file_edit', input: { file: evt.item.file, status: 'completed' } });
            }
          }
          else if (evt.type === 'turn.completed') {
            const usage = evt.usage || {};
            session._lastUsage = {
              input_tokens: usage.input_tokens || 0,
              output_tokens: usage.output_tokens || 0,
              cache_read_input_tokens: usage.cached_input_tokens || 0
            };
            sseSend({ type: 'done', text: fullText, cost: null, duration: null });
          }
          else if (evt.type === 'error') {
            sseSend({ type: 'error', text: evt.message || JSON.stringify(evt) });
          }
        } else {
          // ===== Claude stream-json event parsing =====
          if (evt.type === 'system' && evt.subtype === 'init') {
            session.claudeSessionId = evt.session_id;
            // Always persist/update the mapping row — pair claude session with codex (codex may be NULL at this point)
            try { db.prepare('INSERT OR REPLACE INTO session_codex_ids (claude_session_id, codex_session_id, user_id) VALUES (?, ?, ?)').run(evt.session_id, session.codexSessionId || null, req.user.id); } catch {}
            sseSend({ type: 'init', sessionId: evt.session_id, backend: 'claude' });
          }
          else if (evt.type === 'assistant' && evt.message?.content) {
            for (const block of evt.message.content) {
              if (block.type === 'text') {
                fullText += block.text;
                sseSend({ type: 'text', text: block.text });
              } else if (block.type === 'tool_use') {
                sseSend({ type: 'tool_use', name: block.name, input: block.input });
              }
            }
          }
          else if (evt.type === 'result') {
            session.claudeSessionId = evt.session_id;
            // Always persist/update the mapping row — ensure claude↔codex pairing stays in sync
            if (evt.session_id) {
              try { db.prepare('INSERT OR REPLACE INTO session_codex_ids (claude_session_id, codex_session_id, user_id) VALUES (?, ?, ?)').run(evt.session_id, session.codexSessionId || null, req.user.id); } catch {}
            }
            if (evt.result && !fullText) fullText = evt.result;
            session._lastCost = evt.total_cost_usd;
            session._lastDuration = evt.duration_ms;
            session._lastUsage = evt.usage || {};
            sseSend({ type: 'done', text: evt.result, cost: evt.total_cost_usd, duration: evt.duration_ms });
          }
        }
      } catch {}
    }
  });

  let resumeFailed = false;
  child.stderr.on('data', (chunk) => {
    const errText = chunk.toString();
    console.error(`[${backend} stderr]`, errText);
    // For codex, stderr is progress info; only send actual errors
    if (backend === 'codex') {
      // Detect resume failure (session expired or not found)
      if (errText.includes('thread/resume') || errText.includes('no rollout found') || errText.includes('thread not found')) {
        resumeFailed = true;
        sseSend({ type: 'error', text: 'Session expired. Will start a new session on next message.', code: 'SESSION_EXPIRED' });
      } else if (errText.includes('Error') || errText.includes('error:') || errText.includes('Not inside a trusted directory')) {
        sseSend({ type: 'error', text: errText });
      }
    } else {
      if (errText.trim()) sseSend({ type: 'error', text: errText });
    }
  });

  child.on('close', (code, signal) => {
    console.log(`[${backend} exit] code=${code}, signal=${signal}, text length=${fullText.length}`);
    session.childProcess = null;
    cleanupTempFiles();
    // If resume failed, clear the stale session ID so next request starts fresh
    if (resumeFailed) {
      if (backend === 'codex' && session.codexSessionId) {
        console.log(`[codex] Clearing expired session ${session.codexSessionId} for ${session.username}@${session.projectName}`);
        session.codexSessionId = null;
      } else if (backend === 'claude' && session.claudeSessionId) {
        console.log(`[claude] Clearing expired session ${session.claudeSessionId} for ${session.username}@${session.projectName}`);
        session.claudeSessionId = null;
      }
    }
    session.lastResult = { text: fullText, cost: session._lastCost, duration: session._lastDuration };
    if (backend === 'codex' && !resumeFailed) {
      try { appendCodexTranscript(session, logMessagePreview, fullText); } catch (e) { console.error('[codex history write failed]', e.message); }
    }
    // Log chat with token usage
    const activeSessionId = (backend === 'codex') ? session.codexSessionId : session.claudeSessionId;
    const usage = session._lastUsage || {};
    logChat(req.user.id, req.user.username, session.projectName, session.projectType, activeSessionId, logMessagePreview, {
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      cacheReadTokens: usage.cache_read_input_tokens || 0,
      costUsd: session._lastCost || 0,
      durationMs: session._lastDuration || 0
    });
    sseSend({ type: 'end' });
    if (resAlive) { try { res.end(); } catch {} }
    resAlive = false;
    if (session._waitCallbacks) {
      for (const cb of session._waitCallbacks) cb();
      session._waitCallbacks = null;
    }
  });

  res.on('close', () => { resAlive = false; });
});

// Wait for session result (reconnection endpoint)
app.get('/api/sessions/:id/wait', (req, res) => {
  const session = activeSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  if (!session.childProcess) {
    try {
      const r = session.lastResult || {};
      res.write(`data: ${JSON.stringify({ type: 'done', text: r.text || '', cost: r.cost, duration: r.duration })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'end' })}\n\n`);
      res.end();
    } catch {}
    return;
  }

  if (!session._waitCallbacks) session._waitCallbacks = [];
  let waitAlive = true;
  const onDone = () => {
    if (!waitAlive) return;
    waitAlive = false;
    try {
      const r = session.lastResult || {};
      res.write(`data: ${JSON.stringify({ type: 'done', text: r.text || '', cost: r.cost, duration: r.duration })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'end' })}\n\n`);
      res.end();
    } catch {}
  };
  session._waitCallbacks.push(onDone);
  res.on('close', () => {
    waitAlive = false;
    if (session._waitCallbacks) session._waitCallbacks = session._waitCallbacks.filter(cb => cb !== onDone);
  });
});

// Stop a running Claude process
app.post('/api/sessions/:id/stop', (req, res) => {
  const session = activeSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.childProcess && !session.childProcess.killed) {
    console.log(`[stop] sending SIGINT to session ${req.params.id}, pid=${session.childProcess.pid}`);
    try { process.kill(-session.childProcess.pid, 'SIGINT'); } catch (e) { session.childProcess.kill('SIGINT'); }
    res.json({ ok: true });
  } else {
    res.json({ ok: false, reason: 'No running process' });
  }
});

app.delete('/api/sessions/:id', (req, res) => {
  activeSessions.delete(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/sessions/:sessionId/delete', (req, res) => {
  const { sessionId } = req.params;
  const projectName = req.query.project;
  const projectType = req.query.type || 'personal';
  if (!projectName) return res.status(400).json({ error: 'project required' });
  const projectPath = resolveUserProjectPath(req.user, projectName, projectType);
  if (!projectPath || !fs.existsSync(projectPath)) return res.status(404).json({ error: 'Project not found' });
  const standaloneProject = projectType === 'personal' && isStandaloneProject(req.user.id, projectName);
  const sessionDir = path.join(getUserSessionsRoot(req.user.username), projectToSessionDir(projectPath));
  const jsonlPath = path.join(sessionDir, `${sessionId}.jsonl`);
  try { if (fs.existsSync(jsonlPath)) fs.unlinkSync(jsonlPath); } catch {}
  try { db.prepare('DELETE FROM session_names WHERE session_id = ?').run(sessionId); } catch {}
  try { db.prepare('DELETE FROM session_codex_ids WHERE claude_session_id = ?').run(sessionId); } catch {}
  try { db.prepare('DELETE FROM standalone_session_projects WHERE session_id = ? OR (user_id = ? AND project_name = ?)').run(sessionId, req.user.id, projectName); } catch {}
  if (standaloneProject && isPathInside(getUserProjectsDir(req.user.username), projectPath)) {
    try { fs.rmSync(projectPath, { recursive: true, force: true }); } catch {}
  }
  for (const [id, s] of activeSessions) {
    if (s.claudeSessionId === sessionId || s.codexSessionId === sessionId) { activeSessions.delete(id); break; }
  }
  res.json({ ok: true });
});

// ========== File Preview/Download ==========
// Check if a file exists (by absolute path within project)
app.get('/api/file-check', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ exists: false });

  // Security: only allow files within user's project directories or shared projects
  if (!isAllowedFilePath(req.user, filePath)) return res.json({ exists: false });

  try {
    const safePath = path.resolve(filePath);
    const stat = fs.statSync(safePath);
    if (stat.isFile()) {
      return res.json({ exists: true, size: stat.size, name: path.basename(safePath) });
    }
  } catch {}
  res.json({ exists: false });
});

// Serve a file for preview/download
app.get('/api/file-preview', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path required' });

  if (!isAllowedFilePath(req.user, filePath)) return res.status(403).json({ error: 'Access denied' });
  const safePath = path.resolve(filePath);

  if (!fs.existsSync(safePath) || !fs.statSync(safePath).isFile()) {
    return res.status(404).json({ error: 'File not found' });
  }

  const ext = path.extname(safePath).toLowerCase();
  const MIME_MAP = {
    '.html': 'text/html', '.htm': 'text/html',
    '.css': 'text/css', '.js': 'application/javascript',
    '.json': 'application/json', '.xml': 'application/xml',
    '.txt': 'text/plain', '.md': 'text/plain', '.log': 'text/plain',
    '.csv': 'text/csv',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip', '.gz': 'application/gzip',
  };
  const contentType = MIME_MAP[ext] || 'application/octet-stream';
  const inline = ['.html', '.htm', '.txt', '.md', '.log', '.csv', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.mp4', '.webm', '.pdf'].includes(ext);

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(path.basename(safePath))}"`);
  fs.createReadStream(safePath).pipe(res);
});

// Return a snippet (first N chars) of a text file for inline preview
app.get('/api/file-snippet', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path required' });

  if (!isAllowedFilePath(req.user, filePath)) return res.status(403).json({ error: 'Access denied' });
  const safePath = path.resolve(filePath);

  if (!fs.existsSync(safePath) || !fs.statSync(safePath).isFile()) {
    return res.status(404).json({ error: 'File not found' });
  }

  const ext = path.extname(safePath).toLowerCase();
  const textExts = ['.md', '.markdown', '.txt', '.log', '.json', '.yaml', '.yml', '.toml', '.ini', '.conf',
    '.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.java', '.c', '.cpp', '.rs', '.rb', '.php', '.sh',
    '.sql', '.html', '.htm', '.css', '.xml', '.csv'];
  if (!textExts.includes(ext)) {
    return res.json({ snippet: null, previewable: false });
  }

  // HTML files get larger snippet for proper rendering
  const defaultMax = ['.html', '.htm'].includes(ext) ? 4000 : 800;
  const maxChars = Math.min(parseInt(req.query.max) || defaultMax, 8000);

  try {
    const fd = fs.openSync(safePath, 'r');
    const buf = Buffer.alloc(maxChars);
    const bytesRead = fs.readSync(fd, buf, 0, maxChars, 0);
    fs.closeSync(fd);
    const content = buf.slice(0, bytesRead).toString('utf8');
    res.json({ snippet: content, previewable: true, ext: ext });
  } catch (e) {
    res.status(500).json({ error: 'Read failed' });
  }
});

// Force-download a file (always attachment)
app.get('/api/file-download', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path required' });

  if (!isAllowedFilePath(req.user, filePath)) return res.status(403).json({ error: 'Access denied' });
  const safePath = path.resolve(filePath);

  if (!fs.existsSync(safePath) || !fs.statSync(safePath).isFile()) {
    return res.status(404).json({ error: 'File not found' });
  }

  const ext = path.extname(safePath).toLowerCase();
  const MIME_MAP = {
    '.html': 'text/html', '.htm': 'text/html',
    '.css': 'text/css', '.js': 'application/javascript',
    '.json': 'application/json', '.xml': 'application/xml',
    '.txt': 'text/plain', '.md': 'text/plain', '.log': 'text/plain',
    '.csv': 'text/csv',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip', '.gz': 'application/gzip',
  };
  const contentType = MIME_MAP[ext] || 'application/octet-stream';
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(safePath))}"`);
  fs.createReadStream(safePath).pipe(res);
});

// ========== Project File Download (by relative path) ==========
app.get('/api/projects/:name/download', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path required' });

  const projectPath = resolveUserProjectPath(req.user, req.params.name, req.query.type || 'personal');
  if (!projectPath || !fs.existsSync(projectPath)) return res.status(404).json({ error: 'Project not found' });

  const absPath = resolveInside(projectPath, filePath);
  if (!absPath) return res.status(403).json({ error: 'Access denied' });

  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
    return res.status(404).json({ error: 'File not found' });
  }

  const ext = path.extname(absPath).toLowerCase();
  const MIME_MAP = {
    '.html': 'text/html', '.htm': 'text/html',
    '.css': 'text/css', '.js': 'application/javascript',
    '.json': 'application/json', '.xml': 'application/xml',
    '.txt': 'text/plain', '.md': 'text/plain', '.log': 'text/plain',
    '.csv': 'text/csv',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip', '.gz': 'application/gzip',
  };
  const contentType = MIME_MAP[ext] || 'application/octet-stream';
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(absPath))}"`);
  fs.createReadStream(absPath).pipe(res);
});

// ========== File Tree & Upload ==========
app.get('/api/projects/:name/files', (req, res) => {
  const projectPath = resolveUserProjectPath(req.user, req.params.name, req.query.type || 'personal');
  if (!projectPath || !fs.existsSync(projectPath)) return res.status(404).json({ error: 'Project not found' });

  const relDir = req.query.path || '';
  const absDir = resolveInside(projectPath, relDir);
  if (!absDir) return res.status(400).json({ error: 'Invalid path' });
  if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) return res.status(404).json({ error: 'Directory not found' });

  const HIDDEN = new Set(['.git', 'node_modules', '.ccmobile-tmp', '.ccmobile-attachments', '__pycache__', '.next', '.cache', 'dist']);
  try {
    const entries = fs.readdirSync(absDir, { withFileTypes: true })
      .filter(e => !HIDDEN.has(e.name) && !e.name.startsWith('.git'))
      .map(e => ({ name: e.name, isDir: e.isDirectory() }))
      .sort((a, b) => { if (a.isDir !== b.isDir) return a.isDir ? -1 : 1; return a.name.localeCompare(b.name); });
    res.json({ path: relDir, entries });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:name/upload', upload.array('files', 20), (req, res) => {
  const projectPath = resolveUserProjectPath(req.user, req.params.name, req.query.type || req.body.type || 'personal');
  if (!projectPath || !fs.existsSync(projectPath)) return res.status(404).json({ error: 'Project not found' });

  const targetDir = req.body.targetDir || '';
  const absTarget = resolveInside(projectPath, targetDir);
  if (!absTarget) return res.status(400).json({ error: 'Invalid path' });
  if (!fs.existsSync(absTarget) || !fs.statSync(absTarget).isDirectory()) return res.status(400).json({ error: 'Target directory not found' });

  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

  const uploaded = [];
  for (const file of req.files) {
    const safeName = safeUploadFileName(file.originalname);
    if (!safeName) {
      try { fs.unlinkSync(file.path); } catch {}
      continue;
    }
    const destPath = resolveInside(absTarget, safeName);
    if (!destPath || (fs.existsSync(destPath) && fs.statSync(destPath).isDirectory())) {
      try { fs.unlinkSync(file.path); } catch {}
      continue;
    }
    fs.renameSync(file.path, destPath);
    uploaded.push(safeName);
  }
  res.json({ ok: true, uploaded });
});

app.post('/api/projects/:name/upload-zip', upload.single('file'), (req, res) => {
  const projectPath = resolveUserProjectPath(req.user, req.params.name, req.query.type || req.body.type || 'personal');
  if (!projectPath || !fs.existsSync(projectPath)) return res.status(404).json({ error: 'Project not found' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const targetDir = req.body.targetDir || '';
  const absTarget = resolveInside(projectPath, targetDir);
  if (!absTarget) return res.status(400).json({ error: 'Invalid path' });

  try {
    let folderName = safeUploadFileName(path.basename(req.file.originalname, path.extname(req.file.originalname))) || 'uploaded';
    const extractDir = resolveInside(absTarget, folderName);
    if (!extractDir) return res.status(400).json({ error: 'Invalid zip folder name' });
    fs.mkdirSync(extractDir, { recursive: true });
    const zip = new AdmZip(req.file.path);
    const entries = zip.getEntries();
    if (entries.length > 1000) return res.status(400).json({ error: 'Zip has too many entries' });
    let totalSize = 0;
    for (const entry of entries) {
      totalSize += entry.header?.size || 0;
      if (totalSize > 100 * 1024 * 1024) return res.status(400).json({ error: 'Zip is too large after extraction' });
      const entryPath = resolveInside(extractDir, entry.entryName);
      if (!entryPath) return res.status(400).json({ error: 'Zip contains unsafe paths' });
      if (entry.isDirectory) {
        fs.mkdirSync(entryPath, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(entryPath), { recursive: true });
        fs.writeFileSync(entryPath, entry.getData());
      }
    }
    fs.unlinkSync(req.file.path);
    res.json({ ok: true, folder: folderName });
  } catch (e) {
    if (req.file.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: 'Failed to extract zip: ' + e.message });
  }
});

// ========== Git Commit & Push ==========
function gitExec(args, projectPath) {
  return execSync(`git ${args}`, { cwd: projectPath, encoding: 'utf8', timeout: 30000 });
}

app.get('/api/projects/:name/git-status', (req, res) => {
  const projectPath = resolveUserProjectPath(req.user, req.params.name, req.query.type || 'personal');
  if (!projectPath || !fs.existsSync(path.join(projectPath, '.git'))) return res.status(400).json({ error: 'Not a git repo' });

  try {
    const status = gitExec('status --porcelain', projectPath);
    const files = status.trim().split('\n').filter(Boolean).map(line => ({ status: line.substring(0, 2).trim(), file: line.substring(3) }));
    const branch = gitExec('branch --show-current', projectPath).trim();
    let hasRemote = false;
    try { gitExec('remote get-url origin', projectPath); hasRemote = true; } catch {}
    res.json({ files, branch, hasRemote });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/projects/:name/git-push', (req, res) => {
  const projectPath = resolveUserProjectPath(req.user, req.params.name, req.query.type || req.body.type || 'personal');
  if (!projectPath || !fs.existsSync(path.join(projectPath, '.git'))) return res.status(400).json({ error: 'Not a git repo' });

  const commitMsg = req.body.message || 'Update from ccmobile';
  try {
    execSync('git add -A', { cwd: projectPath, encoding: 'utf8' });
    const result = require('child_process').spawnSync('git', ['commit', '-m', commitMsg], { cwd: projectPath, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || 'Commit failed');
    let pushed = false, hasRemote = false;
    try { gitExec('remote get-url origin', projectPath); hasRemote = true; } catch {}
    if (hasRemote) { try { gitExec('push', projectPath); pushed = true; } catch {} }
    res.json({ ok: true, pushed, hasRemote });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ========== Rewind ==========
app.get('/api/sessions/:sessionId/rewind-points', async (req, res) => {
  const { sessionId } = req.params;
  const projectName = req.query.project;
  const projectType = req.query.type || 'personal';
  if (!projectName) return res.status(400).json({ error: 'project query param required' });

  const projectPath = resolveUserProjectPath(req.user, projectName, projectType);
  if (!projectPath || !fs.existsSync(projectPath)) return res.status(404).json({ error: 'Project not found' });
  const sessionDir = path.join(getUserSessionsRoot(req.user.username), projectToSessionDir(projectPath));
  const filePath = path.join(sessionDir, `${sessionId}.jsonl`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Session not found' });

  const { userMessages, snapshotGroups } = await parseSessionJSONL(filePath);
  const points = [];
  for (const [msgId, snapshot] of snapshotGroups) {
    const userMsg = userMessages.get(msgId);
    if (!userMsg) continue;
    const fileCount = Object.keys(snapshot.trackedFileBackups || {}).filter(f => snapshot.trackedFileBackups[f].backupFileName != null).length;
    if (fileCount === 0) continue;
    points.push({ messageId: msgId, userContent: userMsg.content, timestamp: snapshot.timestamp || userMsg.timestamp, fileCount });
  }
  res.json(points);
});

app.post('/api/rewind', async (req, res) => {
  const { projectName, sessionId, messageId, type } = req.body;
  const projectType = type || 'personal';
  const projectPath = resolveUserProjectPath(req.user, projectName, projectType);
  if (!projectPath || !fs.existsSync(projectPath)) return res.status(404).json({ error: 'Project not found' });

  const sessionDir = path.join(getUserSessionsRoot(req.user.username), projectToSessionDir(projectPath));
  const filePath = path.join(sessionDir, `${sessionId}.jsonl`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Session not found' });

  const { snapshotGroups } = await parseSessionJSONL(filePath);
  const snapshot = snapshotGroups.get(messageId);
  if (!snapshot) return res.status(404).json({ error: 'Snapshot not found for this message' });

  const fileHistoryDir = path.join(getUserFileHistoryRoot(req.user.username), sessionId);
  const restored = [], deleted = [], errors = [];

  for (const [relPath, info] of Object.entries(snapshot.trackedFileBackups || {})) {
    const targetPath = path.join(projectPath, relPath);
    try {
      if (info.backupFileName) {
        const backupPath = path.join(fileHistoryDir, info.backupFileName);
        if (fs.existsSync(backupPath)) {
          fs.mkdirSync(path.dirname(targetPath), { recursive: true });
          fs.copyFileSync(backupPath, targetPath);
          restored.push(relPath);
        } else {
          errors.push(`backup missing: ${relPath}`);
        }
      } else {
        if (fs.existsSync(targetPath)) { fs.unlinkSync(targetPath); deleted.push(relPath); }
      }
    } catch (e) { errors.push(`${relPath}: ${e.message}`); }
  }

  console.log(`[rewind] restored=${restored.length}, deleted=${deleted.length}, errors=${errors.length}`);
  res.json({ ok: true, restored, deleted, errors });
});

// ========== Project Notes ==========
app.get('/api/projects/:name/notes', (req, res) => {
  const notes = db.prepare('SELECT * FROM project_notes WHERE project = ? AND (user_id = ? OR user_id IS NULL) ORDER BY created_at DESC').all(req.params.name, req.user.id);
  res.json(notes);
});

app.post('/api/projects/:name/notes', (req, res) => {
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Content required' });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO project_notes (id, project, content, created_at, updated_at, user_id) VALUES (?, ?, ?, ?, ?, ?)').run(id, req.params.name, content.trim(), now, now, req.user.id);
  res.json({ id, project: req.params.name, content: content.trim(), created_at: now, updated_at: now });
});

app.put('/api/projects/:name/notes/:id', (req, res) => {
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Content required' });
  const now = new Date().toISOString();
  db.prepare('UPDATE project_notes SET content = ?, updated_at = ? WHERE id = ? AND project = ? AND user_id = ?').run(content.trim(), now, req.params.id, req.params.name, req.user.id);
  res.json({ ok: true });
});

app.delete('/api/projects/:name/notes/:id', (req, res) => {
  db.prepare('DELETE FROM project_notes WHERE id = ? AND project = ? AND user_id = ?').run(req.params.id, req.params.name, req.user.id);
  res.json({ ok: true });
});

// ========== Shared Projects (all users) ==========
app.get('/api/shared-projects', (req, res) => {
  const projects = db.prepare('SELECT * FROM shared_projects ORDER BY created_at DESC').all();
  const result = projects.map(p => {
    const access = db.prepare('SELECT status FROM project_access WHERE project_id = ? AND user_id = ?').get(p.id, req.user.id);
    return { ...p, myAccess: access ? access.status : null };
  });
  res.json(result);
});

app.post('/api/shared-projects/:id/request-access', (req, res) => {
  const project = db.prepare('SELECT * FROM shared_projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const existing = db.prepare('SELECT * FROM project_access WHERE project_id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (existing) return res.status(400).json({ error: `Already ${existing.status}` });

  const id = crypto.randomUUID();
  db.prepare('INSERT INTO project_access (id, project_id, user_id, status, requested_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, req.params.id, req.user.id, 'pending', new Date().toISOString());
  res.json({ ok: true, status: 'pending' });
});

app.get('/api/my-access-requests', (req, res) => {
  const requests = db.prepare(`
    SELECT pa.*, sp.name as project_name, sp.description as project_description
    FROM project_access pa JOIN shared_projects sp ON pa.project_id = sp.id
    WHERE pa.user_id = ? ORDER BY pa.requested_at DESC
  `).all(req.user.id);
  res.json(requests);
});

// ========== Admin: User Management ==========
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, username, role, created_at, last_login FROM users ORDER BY created_at').all();
  res.json(users);
});

app.post('/api/admin/users', requireAdmin, (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 2) return res.status(400).json({ error: 'Username too short' });
  if (password.length < 4) return res.status(400).json({ error: 'Password too short (min 4)' });
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) return res.status(400).json({ error: 'Username must be alphanumeric (a-z, 0-9, _, -)' });

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(409).json({ error: 'Username already exists' });

  const id = crypto.randomUUID();
  const hash = bcrypt.hashSync(password, 10);
  const userRole = (role === 'admin') ? 'admin' : 'user';
  db.prepare('INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, username, hash, userRole, new Date().toISOString());

  // Create user directories
  ensureUserDirs(username);

  logSystem('admin.create_user', req.user.id, req.user.username, `Created user "${username}" (role: ${userRole})`);
  res.json({ ok: true, user: { id, username, role: userRole } });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });

  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  db.prepare('DELETE FROM project_access WHERE user_id = ?').run(req.params.id);
  // Invalidate tokens for this user
  deleteUserTokens(req.params.id);
  logSystem('admin.delete_user', req.user.id, req.user.username, `Deleted user "${user.username}"`);
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/reset-password', requireAdmin, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Password too short (min 4)' });

  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.params.id);
  res.json({ ok: true });
});

// ========== Admin: Shared Projects ==========
app.post('/api/admin/shared-projects', requireAdmin, (req, res) => {
  const { name, description } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Project name required' });
  const projName = safeProjectName(name.trim().replace(/[^a-zA-Z0-9_\-\.]/g, '-'));
  if (!projName) return res.status(400).json({ error: 'Invalid project name' });

  const existing = db.prepare('SELECT id FROM shared_projects WHERE name = ?').get(projName);
  if (existing) return res.status(409).json({ error: 'Project name already exists' });

  // Create directory
  const projPath = path.join(SHARED_PROJECTS_ROOT, projName);
  if (!fs.existsSync(projPath)) fs.mkdirSync(projPath, { recursive: true });

  const id = crypto.randomUUID();
  db.prepare('INSERT INTO shared_projects (id, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, projName, description || '', req.user.id, new Date().toISOString());

  // Auto-approve admin
  const accessId = crypto.randomUUID();
  db.prepare('INSERT INTO project_access (id, project_id, user_id, status, requested_at, reviewed_at, reviewed_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(accessId, id, req.user.id, 'approved', new Date().toISOString(), new Date().toISOString(), req.user.id);

  logSystem('admin.create_shared_project', req.user.id, req.user.username, `Created shared project "${projName}"`);
  res.json({ ok: true, project: { id, name: projName, description: description || '' } });
});

app.delete('/api/admin/shared-projects/:id', requireAdmin, (req, res) => {
  const project = db.prepare('SELECT * FROM shared_projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  db.prepare('DELETE FROM shared_projects WHERE id = ?').run(req.params.id);
  db.prepare('DELETE FROM project_access WHERE project_id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/shared-projects/:id/members', requireAdmin, (req, res) => {
  const members = db.prepare(`
    SELECT pa.*, u.username FROM project_access pa
    JOIN users u ON pa.user_id = u.id
    WHERE pa.project_id = ? ORDER BY pa.requested_at DESC
  `).all(req.params.id);
  res.json(members);
});

// ========== Admin: Access Requests ==========
app.get('/api/admin/access-requests', requireAdmin, (req, res) => {
  const requests = db.prepare(`
    SELECT pa.*, u.username, sp.name as project_name
    FROM project_access pa
    JOIN users u ON pa.user_id = u.id
    JOIN shared_projects sp ON pa.project_id = sp.id
    WHERE pa.status = 'pending'
    ORDER BY pa.requested_at ASC
  `).all();
  res.json(requests);
});

app.post('/api/admin/access-requests/:id/approve', requireAdmin, (req, res) => {
  const request = db.prepare('SELECT pa.*, u.username as req_user, sp.name as proj_name FROM project_access pa JOIN users u ON pa.user_id = u.id JOIN shared_projects sp ON pa.project_id = sp.id WHERE pa.id = ?').get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found' });

  db.prepare('UPDATE project_access SET status = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?')
    .run('approved', new Date().toISOString(), req.user.id, req.params.id);
  logSystem('admin.approve_access', req.user.id, req.user.username, `Approved ${request.req_user} access to "${request.proj_name}"`);
  res.json({ ok: true });
});

app.post('/api/admin/access-requests/:id/reject', requireAdmin, (req, res) => {
  const request = db.prepare('SELECT pa.*, u.username as req_user, sp.name as proj_name FROM project_access pa JOIN users u ON pa.user_id = u.id JOIN shared_projects sp ON pa.project_id = sp.id WHERE pa.id = ?').get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found' });

  db.prepare('UPDATE project_access SET status = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?')
    .run('rejected', new Date().toISOString(), req.user.id, req.params.id);
  logSystem('admin.reject_access', req.user.id, req.user.username, `Rejected ${request.req_user} access to "${request.proj_name}"`);
  res.json({ ok: true });
});

// ========== Admin: Logs ==========
app.get('/api/admin/logs/system', requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const offset = parseInt(req.query.offset) || 0;
  const logs = db.prepare('SELECT * FROM system_logs ORDER BY timestamp DESC LIMIT ? OFFSET ?').all(limit, offset);
  const total = db.prepare('SELECT COUNT(*) as cnt FROM system_logs').get().cnt;
  res.json({ logs, total });
});

app.get('/api/admin/logs/chat', requireAdmin, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const offset = parseInt(req.query.offset) || 0;
  const userId = req.query.user_id || null;
  let logs, total;
  if (userId) {
    logs = db.prepare('SELECT * FROM chat_logs WHERE user_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?').all(userId, limit, offset);
    total = db.prepare('SELECT COUNT(*) as cnt FROM chat_logs WHERE user_id = ?').get(userId).cnt;
  } else {
    logs = db.prepare('SELECT * FROM chat_logs ORDER BY timestamp DESC LIMIT ? OFFSET ?').all(limit, offset);
    total = db.prepare('SELECT COUNT(*) as cnt FROM chat_logs').get().cnt;
  }
  res.json({ logs, total });
});

app.get('/api/admin/logs/stats', requireAdmin, (req, res) => {
  // Per-user token consumption summary
  const stats = db.prepare(`
    SELECT user_id, username,
      COUNT(*) as total_chats,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens,
      SUM(cache_read_tokens) as total_cache_tokens,
      ROUND(SUM(cost_usd), 6) as total_cost_usd,
      SUM(duration_ms) as total_duration_ms
    FROM chat_logs GROUP BY user_id ORDER BY total_cost_usd DESC
  `).all();
  res.json(stats);
});

// ========== Auto-cleanup stale sessions ==========
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, s] of activeSessions) {
    if ((s.lastActive || 0) < cutoff) activeSessions.delete(id);
  }
}, 10 * 60 * 1000);

// ========== Startup ==========
ensureDirs();
ensureAdminUser();

const PORT = config.PORT;
console.log('');
console.log('  ╔══════════════════════════════════════╗');
console.log('  ║           ccmobile starting            ║');
console.log('  ╚══════════════════════════════════════╝');
console.log('');
console.log(`  Backend    : ${config.CLI_BACKEND.toUpperCase()}`);
if (config.CLI_BACKEND === 'codex') {
  if (fs.existsSync(config.CODEX_CLI_PATH)) {
    console.log(`  Codex CLI  : ${config.CODEX_CLI_PATH} ✓`);
    console.log(`  Codex Model: ${config.CODEX_MODEL}`);
    console.log(`  Codex Effort: ${config.CODEX_EFFORT}`);
  } else {
    console.log(`  Codex CLI  : not found ✗`);
    console.log(`               Install: npm install -g @openai/codex`);
  }
} else {
  if (fs.existsSync(config.CLAUDE_CLI_PATH)) {
    if (isClaudeAuthed()) {
      console.log(`  Claude CLI : ${config.CLAUDE_CLI_PATH} ✓ (authenticated)`);
    } else {
      console.log(`  Claude CLI : ${config.CLAUDE_CLI_PATH} ✓ (not logged in)`);
      console.log(`               Run: claude   to authenticate`);
    }
  } else {
    console.log(`  Claude CLI : not found ✗`);
    console.log(`               Install: npm install -g @anthropic-ai/claude-code`);
  }
}
console.log(`  Sandbox    : ${config.USE_SANDBOX ? 'enabled (bwrap)' : 'disabled (direct mode)'}`);
console.log(`  User data  : ${USER_DATA_ROOT}`);
console.log(`  Shared     : ${SHARED_PROJECTS_ROOT}`);
const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
console.log(`  Users      : ${userCount} registered`);
if (!config.HAS_ENV) {
  console.log(`  Config     : no .env file — open browser to run setup wizard`);
} else {
  console.log(`  Config     : .env loaded ✓`);
}
console.log('');
const HOST = config.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`  → http://${HOST}:${PORT}`);
  console.log('');
});
