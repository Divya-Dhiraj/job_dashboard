// auth.js — Username + password auth for the Job Dashboard.
//
// Model: 1 login = 1 profile. There is no separate users table; the
// profiles table itself carries username + password_hash. Sessions are
// stored as signed HTTP-only cookies (no Redis, no JWT, no DB sessions).
//
// Cookie payload: just the profile id, signed with HMAC-SHA256 using the
// auto-generated app_settings.session_secret. The signature catches tampering;
// the cookie is otherwise opaque to the client.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./database');

const COOKIE_NAME = 'jd_session';
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const BCRYPT_ROUNDS = 10;

// ─────────────────────────────────────────────────────────────────────────────
// Session secret — generated once on first boot and persisted to app_settings.
// Rotating it logs everyone out (their cookies become invalid).
// ─────────────────────────────────────────────────────────────────────────────
function getSessionSecret() {
  let secret = db.getSetting('session_secret');
  if (!secret) {
    secret = crypto.randomBytes(48).toString('hex');
    db.setSetting('session_secret', secret);
  }
  return secret;
}

// ─────────────────────────────────────────────────────────────────────────────
// Token = base64(profileId).base64(hmac(profileId))
// Tamper-evident, opaque to the client, no DB lookup needed to validate.
// ─────────────────────────────────────────────────────────────────────────────
function sign(profileId) {
  const id = String(profileId);
  const sig = crypto.createHmac('sha256', getSessionSecret()).update(id).digest('hex');
  return Buffer.from(id).toString('base64url') + '.' + sig;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  let id;
  try { id = Buffer.from(parts[0], 'base64url').toString('utf8'); }
  catch { return null; }
  const expected = crypto.createHmac('sha256', getSessionSecret()).update(id).digest('hex');
  // Constant-time compare to prevent timing attacks
  if (parts[1].length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(parts[1]), Buffer.from(expected))) return null;
  const idNum = parseInt(id);
  return Number.isFinite(idNum) ? idNum : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Password helpers
// ─────────────────────────────────────────────────────────────────────────────
async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  if (!hash) return false;
  try { return await bcrypt.compare(plain, hash); }
  catch { return false; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Username helpers
// ─────────────────────────────────────────────────────────────────────────────
function normalizeUsername(u) {
  return String(u || '').trim().toLowerCase();
}

function isValidUsername(u) {
  return /^[a-z0-9][a-z0-9_.-]{2,30}$/.test(u);
}

function findProfileByUsername(username) {
  const norm = normalizeUsername(username);
  if (!norm) return null;
  return db.brainOne('SELECT * FROM profiles WHERE LOWER(username) = ?', [norm]);
}

function isUsernameTaken(username) {
  return !!findProfileByUsername(username);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cookie helpers
// ─────────────────────────────────────────────────────────────────────────────
function setSessionCookie(res, profileId) {
  res.cookie(COOKIE_NAME, sign(profileId), {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE_MS,
    // Note: we don't set "secure: true" because the dashboard runs locally
    // over http://localhost. If you ever put it behind HTTPS, flip this.
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

// Auth middleware: populates req.profile from the cookie. If no valid
// session, leaves req.profile = null (the route handler decides whether
// that's allowed).
function loadSession(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  const profileId = verify(token);
  if (profileId) {
    const p = db.getProfile(profileId);
    if (p) req.profile = p;
  }
  next();
}

// Hard auth gate. Use on routes that must have a logged-in profile.
function requireAuth(req, res, next) {
  if (!req.profile) return res.status(401).json({ error: 'unauthorized', message: 'Login required' });
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// High-level operations exposed to server.js endpoints
// ─────────────────────────────────────────────────────────────────────────────

// Create a new profile with a password. Returns the new profile or throws on
// validation errors. Caller should set the session cookie afterwards.
async function signup({ username, password, profileFields }) {
  const norm = normalizeUsername(username);
  if (!isValidUsername(norm)) {
    throw new Error('Username must be 3-31 characters, lowercase letters, digits, dots, dashes, or underscores, starting with a letter or digit.');
  }
  if (!password || password.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }
  if (isUsernameTaken(norm)) {
    throw new Error('Username already taken.');
  }
  const password_hash = await hashPassword(password);
  // createProfile already exists in database.js; we extend with auth fields.
  const created = db.createProfile({ ...profileFields, slug: profileFields.slug || norm });
  // Set username + password_hash via raw exec (createProfile doesn't accept them)
  db.brainExec(
    'UPDATE profiles SET username = ?, password_hash = ?, password_must_change = 0 WHERE id = ?',
    [norm, password_hash, created.id]
  );
  return db.getProfile(created.id);
}

async function login({ username, password }) {
  const profile = findProfileByUsername(username);
  if (!profile) return { ok: false, error: 'invalid-credentials' };
  if (!profile.password_hash) {
    // Profile was admin-created without a password — first-login flow
    return { ok: false, error: 'no-password-set', profileId: profile.id, username: profile.username };
  }
  const valid = await verifyPassword(password, profile.password_hash);
  if (!valid) return { ok: false, error: 'invalid-credentials' };
  // Update last_login_at
  db.brainExec('UPDATE profiles SET last_login_at = ? WHERE id = ?',
    [new Date().toISOString(), profile.id]);
  return { ok: true, profile };
}

async function changePassword(profileId, { currentPassword, newPassword }) {
  if (!newPassword || newPassword.length < 8) {
    throw new Error('New password must be at least 8 characters.');
  }
  const profile = db.getProfile(profileId);
  if (!profile) throw new Error('Profile not found');

  // Allow setting an initial password (when password_must_change OR no hash yet)
  // without requiring currentPassword.
  const initialSet = !profile.password_hash || profile.password_must_change;
  if (!initialSet) {
    const ok = await verifyPassword(currentPassword || '', profile.password_hash);
    if (!ok) throw new Error('Current password is incorrect.');
  }
  const hash = await hashPassword(newPassword);
  db.brainExec('UPDATE profiles SET password_hash = ?, password_must_change = 0 WHERE id = ?',
    [hash, profileId]);
}

module.exports = {
  COOKIE_NAME,
  loadSession, requireAuth,
  setSessionCookie, clearSessionCookie,
  signup, login, changePassword,
  hashPassword, verifyPassword,
  normalizeUsername, isValidUsername,
  findProfileByUsername, isUsernameTaken,
};
