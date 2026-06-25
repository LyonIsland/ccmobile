// ccmobile Configuration — loads from environment variables (supports .env file)

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// Load .env file if present
const ENV_PATH = path.join(__dirname, '.env');
if (fs.existsSync(ENV_PATH)) {
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
}

const HOME_DIR = process.env.CCMOBILE_HOME_DIR || require('os').homedir();

// Auto-detect Claude CLI path
function findClaude() {
  if (process.env.CCMOBILE_CLAUDE_CLI) return process.env.CCMOBILE_CLAUDE_CLI;
  const candidates = ['/usr/local/bin/claude', '/usr/bin/claude', path.join(HOME_DIR, '.local/bin/claude')];
  for (const p of candidates) { if (fs.existsSync(p)) return p; }
  try { return execSync('which claude', { encoding: 'utf8' }).trim(); } catch {}
  return 'claude'; // fallback — will fail at spawn with a clear error
}

// Auto-detect bwrap
function findBwrap() {
  if (process.env.CCMOBILE_BWRAP_PATH) return process.env.CCMOBILE_BWRAP_PATH;
  if (fs.existsSync('/usr/bin/bwrap')) return '/usr/bin/bwrap';
  try { return execSync('which bwrap', { encoding: 'utf8' }).trim(); } catch {}
  return null;
}

const BWRAP_PATH = findBwrap();

// Sandbox mode: 'auto' (default) | 'true' | 'false'
function resolveSandbox() {
  const val = (process.env.CCMOBILE_SANDBOX || 'auto').toLowerCase();
  if (val === 'false' || val === '0') return false;
  if (val === 'true' || val === '1') return true;
  // auto: enable if bwrap is available
  return !!BWRAP_PATH;
}

module.exports = {
  // Server
  PORT: process.env.PORT || 6767,

  // Multi-user auth
  ADMIN_USER: process.env.CCMOBILE_ADMIN_USER || '',
  ADMIN_PASS: process.env.CCMOBILE_ADMIN_PASS || '',

  // Paths
  HOME_DIR,
  PROJECT_ROOT: process.env.CCMOBILE_PROJECT_ROOT || path.join(HOME_DIR, 'projects'),
  USER_DATA_ROOT: process.env.CCMOBILE_USER_DATA_ROOT || path.join(__dirname, 'user-data'),
  SHARED_PROJECTS_ROOT: process.env.CCMOBILE_SHARED_PROJECTS_ROOT || path.join(__dirname, 'shared-projects'),
  CLAUDE_SESSIONS_ROOT: HOME_DIR + '/.claude/projects',
  FILE_HISTORY_ROOT: HOME_DIR + '/.claude/file-history',

  // Claude CLI
  CLAUDE_CLI_PATH: findClaude(),

  // Sandbox
  USE_SANDBOX: resolveSandbox(),
  BWRAP_PATH,

  // Helpers
  ENV_PATH,
  HAS_ENV: fs.existsSync(ENV_PATH),
};
