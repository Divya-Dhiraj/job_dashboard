// database.js — SQLite via sql.js (pure JS, no native compilation)
// Multi-profile schema: profiles table is the unit of identity. All jobs,
// applications, scrape_log, and notifications_sent rows are scoped by profile_id.
// app_settings holds tool-wide key/value config (shared API keys, active profile).
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const DB_PATH = path.join(__dirname, 'jobs.db');
const RESUME_TXT_PATH = path.join(__dirname, 'resume.txt');

let db = null;

async function getDb() {
  if (db) return db;
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }
  initSchema();
  migrateLegacyData();
  migrateLegacyResumesIntoTable();
  // Brain tables (idempotent — safe on every boot). Lazy-required to avoid
  // a circular dependency at module load.
  try {
    require('./brain_db').ensureSchema();
  } catch (e) {
    console.warn('[DB] brain schema init failed:', e.message);
  }
  return db;
}

function save() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function initSchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS profiles (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      slug                   TEXT UNIQUE NOT NULL,
      name                   TEXT NOT NULL,
      email                  TEXT,
      phone                  TEXT,
      address                TEXT,
      linkedin               TEXT,
      resume_text            TEXT,
      skill_groups           TEXT DEFAULT '{}',
      search_titles          TEXT DEFAULT '[]',
      target_titles          TEXT DEFAULT '[]',
      allowed_country_codes  TEXT DEFAULT '["de"]',
      notify_email           TEXT,
      anthropic_key_override TEXT,
      created_at             TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id            TEXT NOT NULL,
      profile_id    INTEGER NOT NULL,
      title         TEXT NOT NULL,
      company       TEXT,
      location      TEXT,
      salary        TEXT,
      description   TEXT,
      apply_url     TEXT,
      posted_at     TEXT,
      applicants    INTEGER DEFAULT 0,
      scraped_at    TEXT NOT NULL,
      source        TEXT NOT NULL,
      match_score   REAL DEFAULT 0,
      matched_skills TEXT DEFAULT '[]',
      is_new        INTEGER DEFAULT 1,
      PRIMARY KEY (profile_id, id)
    );
    CREATE TABLE IF NOT EXISTS notifications_sent (
      profile_id    INTEGER NOT NULL,
      job_id        TEXT NOT NULL,
      sent_at       TEXT NOT NULL,
      PRIMARY KEY (profile_id, job_id)
    );
    CREATE TABLE IF NOT EXISTS scrape_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id    INTEGER,
      ran_at        TEXT NOT NULL,
      source        TEXT,
      jobs_found    INTEGER DEFAULT 0,
      jobs_new      INTEGER DEFAULT 0,
      status        TEXT DEFAULT 'success',
      error         TEXT
    );
    CREATE TABLE IF NOT EXISTS applications (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id        INTEGER,
      job_id            TEXT NOT NULL,
      company           TEXT,
      role              TEXT,
      location          TEXT,
      job_url           TEXT,
      job_description   TEXT,
      folder_path       TEXT,
      cv_path           TEXT,
      cover_letter_path TEXT,
      match_score       REAL,
      applied           INTEGER DEFAULT 0,
      applied_at        TEXT,
      status            TEXT DEFAULT 'generated',
      notes             TEXT,
      created_at        TEXT NOT NULL
    );
    -- One profile can store many tailored resumes (e.g. "Tech CV", "Marketing CV").
    -- profile.resume_text is kept as a denormalized mirror of whichever row
    -- has is_default=1, so the matcher / brain / legacy callers don't need
    -- to be retrofitted. summary is a Claude-generated 2-sentence digest
    -- used when ranking which resume to use for a given job.
    CREATE TABLE IF NOT EXISTS profile_resumes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id   INTEGER NOT NULL,
      label        TEXT NOT NULL DEFAULT 'Default',
      resume_text  TEXT NOT NULL,
      summary      TEXT DEFAULT '',
      is_default   INTEGER DEFAULT 0,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS profile_resumes_by_profile ON profile_resumes(profile_id);
  `);

  // Lightweight column-add migrations for existing DBs that predate profile_id.
  // notifications_sent's PK changed from (job_id) to (profile_id, job_id);
  // since it only stores ephemeral "we already emailed" state, the safest
  // migration is to drop + recreate the empty table when the column is missing.
  ensureColumn('jobs', 'profile_id', 'INTEGER');
  ensureColumn('applications', 'profile_id', 'INTEGER');
  ensureColumn('scrape_log', 'profile_id', 'INTEGER');

  // Auth columns on profiles: 1 login = 1 profile, bcrypt-hashed password.
  // password_must_change is set to 1 by admin scripts that pre-create a
  // profile without a real password; the user is then forced to set one
  // on first login.
  ensureColumn('profiles', 'username',             'TEXT');
  ensureColumn('profiles', 'password_hash',        'TEXT');
  ensureColumn('profiles', 'password_must_change', 'INTEGER DEFAULT 0');
  ensureColumn('profiles', 'last_login_at',        'TEXT');

  // Profile expansion: photo, German-specific fields, languages with CEFR
  // levels, per-field visibility (what to include in CV / cover letter),
  // chosen template id, and per-profile API key overrides for every
  // connector. Existing rows get sensible defaults via column DEFAULTs.
  ensureColumn('profiles', 'photo_path',           'TEXT');
  ensureColumn('profiles', 'dob',                  'TEXT');
  ensureColumn('profiles', 'place_of_birth',       'TEXT');
  ensureColumn('profiles', 'nationality',          'TEXT');
  ensureColumn('profiles', 'marital_status',       'TEXT');
  ensureColumn('profiles', 'languages_cefr',       "TEXT DEFAULT '[]'");
  ensureColumn('profiles', 'cv_field_visibility',  "TEXT DEFAULT '{}'");
  ensureColumn('profiles', 'cv_template',          "TEXT DEFAULT 'modern_single'");
  ensureColumn('profiles', 'apify_token_override',   'TEXT');
  ensureColumn('profiles', 'openai_key_override',    'TEXT');
  ensureColumn('profiles', 'resend_key_override',    'TEXT');
  // Authenticated LinkedIn scraping — user pastes their li_at cookie value
  // here, we pass it to a cookie-supporting Apify actor at scrape time.
  ensureColumn('profiles', 'linkedin_cookie_override', 'TEXT');
  try {
    const cols = (() => {
      const stmt = db.prepare('PRAGMA table_info(notifications_sent)');
      const out = [];
      while (stmt.step()) out.push(stmt.getAsObject().name);
      stmt.free();
      return out;
    })();
    if (!cols.includes('profile_id')) {
      db.run('DROP TABLE IF EXISTS notifications_sent');
      db.run(`CREATE TABLE notifications_sent (
        profile_id INTEGER NOT NULL,
        job_id TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        PRIMARY KEY (profile_id, job_id)
      )`);
    }
  } catch (e) { console.warn('[DB] notifications_sent migration:', e.message); }

  // jobs table migration: PK changed from (id) to (profile_id, id) so two
  // profiles can both store the same LinkedIn job (different match scores).
  // Pre-fix DBs hit "UNIQUE constraint failed: jobs.id" the moment a second
  // profile's scrape returned a job an earlier profile already had.
  try {
    const stmt = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'");
    let createSql = '';
    if (stmt.step()) createSql = stmt.getAsObject().sql || '';
    stmt.free();
    const hasCompositePk = /PRIMARY KEY\s*\(\s*profile_id\s*,\s*id\s*\)/i.test(createSql);
    if (!hasCompositePk && createSql) {
      console.log('[DB] Migrating jobs table to composite primary key (profile_id, id)...');
      db.run('BEGIN TRANSACTION');
      db.run(`CREATE TABLE jobs_new (
        id            TEXT NOT NULL,
        profile_id    INTEGER NOT NULL,
        title         TEXT NOT NULL,
        company       TEXT,
        location      TEXT,
        salary        TEXT,
        description   TEXT,
        apply_url     TEXT,
        posted_at     TEXT,
        applicants    INTEGER DEFAULT 0,
        scraped_at    TEXT NOT NULL,
        source        TEXT NOT NULL,
        match_score   REAL DEFAULT 0,
        matched_skills TEXT DEFAULT '[]',
        is_new        INTEGER DEFAULT 1,
        PRIMARY KEY (profile_id, id)
      )`);
      // Copy: only rows that have a profile_id. Old rows without one are
      // orphaned (no profile to attribute them to) and would violate the
      // new NOT NULL constraint anyway — drop them.
      db.run(`INSERT INTO jobs_new
              SELECT id, profile_id, title, company, location, salary, description,
                     apply_url, posted_at, applicants, scraped_at, source,
                     match_score, matched_skills, is_new
              FROM jobs WHERE profile_id IS NOT NULL`);
      db.run('DROP TABLE jobs');
      db.run('ALTER TABLE jobs_new RENAME TO jobs');
      db.run('COMMIT');
      console.log('[DB] jobs table migrated.');
    }
  } catch (e) {
    try { db.run('ROLLBACK'); } catch {}
    console.warn('[DB] jobs PK migration:', e.message);
  }
}

// One-time migration: every profile that already has resume_text but no
// profile_resumes rows gets one row created from that text. Idempotent.
function migrateLegacyResumesIntoTable() {
  try {
    const profilesWithResume = allQuery(
      `SELECT p.id, p.resume_text FROM profiles p
       WHERE p.resume_text IS NOT NULL AND p.resume_text <> ''
         AND NOT EXISTS (SELECT 1 FROM profile_resumes pr WHERE pr.profile_id = p.id)`
    );
    if (profilesWithResume.length === 0) return;
    const now = new Date().toISOString();
    for (const p of profilesWithResume) {
      db.run(
        `INSERT INTO profile_resumes (profile_id, label, resume_text, summary, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
        [p.id, 'Default', p.resume_text, '', now, now]
      );
    }
    save();
    console.log(`[DB] Migrated ${profilesWithResume.length} legacy resume(s) into profile_resumes table.`);
  } catch (e) {
    console.warn('[DB] migrateLegacyResumesIntoTable failed:', e.message);
  }
}

function ensureColumn(table, column, type) {
  try {
    const stmt = db.prepare(`PRAGMA table_info(${table})`);
    const cols = [];
    while (stmt.step()) cols.push(stmt.getAsObject().name);
    stmt.free();
    if (!cols.includes(column)) {
      db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  } catch (e) {
    console.warn(`[DB] ensureColumn(${table}.${column}) failed:`, e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy migration — runs once after schema init.
// If we have existing job/application rows but no profiles, seed a "Divya
// Dhiraj" profile from resume.txt + the matcher's historical skill groups
// and backfill profile_id on existing rows.
// ─────────────────────────────────────────────────────────────────────────────
function migrateLegacyData() {
  const profileCount = (getQuery('SELECT COUNT(*) as c FROM profiles') || {}).c || 0;
  if (profileCount > 0) return;

  const hasJobs = ((getQuery('SELECT COUNT(*) as c FROM jobs') || {}).c || 0) > 0;
  const hasApps = ((getQuery('SELECT COUNT(*) as c FROM applications') || {}).c || 0) > 0;
  if (!hasJobs && !hasApps && !fs.existsSync(RESUME_TXT_PATH)) return;

  const legacy = require('./legacy_divya_seed');
  const resumeText = fs.existsSync(RESUME_TXT_PATH) ? fs.readFileSync(RESUME_TXT_PATH, 'utf-8') : '';

  console.log('[DB] First-run migration: seeding "Divya Dhiraj" profile from legacy data...');

  db.run(
    `INSERT INTO profiles (slug, name, email, phone, address, linkedin, resume_text,
       skill_groups, search_titles, target_titles, allowed_country_codes,
       notify_email, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      legacy.slug,
      legacy.name,
      legacy.email,
      legacy.phone,
      legacy.address,
      legacy.linkedin,
      resumeText,
      JSON.stringify(legacy.skill_groups),
      JSON.stringify(legacy.search_titles),
      JSON.stringify(legacy.target_titles),
      JSON.stringify(legacy.allowed_country_codes),
      legacy.notify_email || process.env.NOTIFY_EMAIL || '',
      new Date().toISOString(),
    ]
  );
  // Get the new profile id
  const profileId = (getQuery('SELECT id FROM profiles WHERE slug = ?', [legacy.slug]) || {}).id;

  // Backfill existing rows
  if (profileId) {
    db.run('UPDATE jobs SET profile_id = ? WHERE profile_id IS NULL', [profileId]);
    db.run('UPDATE applications SET profile_id = ? WHERE profile_id IS NULL', [profileId]);
    db.run('UPDATE scrape_log SET profile_id = ? WHERE profile_id IS NULL', [profileId]);
    // Old notifications_sent had no profile_id; safest is to wipe, since
    // re-notifying about already-stored old jobs is harmless (notify is gated
    // on isNew via upsertJob).
    db.run('DELETE FROM notifications_sent');

    // Mark Divya as the active profile
    db.run(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('active_profile_id', ?)`,
      [String(profileId)]);

    console.log(`[DB] Migration complete. profile_id=${profileId} backfilled, set as active.`);
  }
  save();
}

function runQuery(sql, params = []) {
  db.run(sql, params);
  save();
}

function allQuery(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function getQuery(sql, params = []) {
  const rows = allQuery(sql, params);
  return rows[0] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Profiles CRUD
// ─────────────────────────────────────────────────────────────────────────────

function slugify(name) {
  return String(name || 'profile')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'profile';
}

function uniqueSlug(base) {
  let slug = slugify(base);
  let n = 1;
  while (getQuery('SELECT id FROM profiles WHERE slug = ?', [slug])) {
    n += 1;
    slug = `${slugify(base)}-${n}`;
  }
  return slug;
}

function parseProfileRow(row) {
  if (!row) return null;
  const parse = (v, fallback) => {
    if (v == null) return fallback;
    try { return JSON.parse(v); } catch { return fallback; }
  };
  return {
    ...row,
    skill_groups:          parse(row.skill_groups, {}),
    search_titles:         parse(row.search_titles, []),
    target_titles:         parse(row.target_titles, []),
    allowed_country_codes: parse(row.allowed_country_codes, ['de']),
    languages_cefr:        parse(row.languages_cefr, []),
    cv_field_visibility:   parse(row.cv_field_visibility, {}),
  };
}

function listProfiles() {
  return allQuery('SELECT id, slug, name, email, created_at FROM profiles ORDER BY id ASC');
}

function getProfile(id) {
  return parseProfileRow(getQuery('SELECT * FROM profiles WHERE id = ?', [id]));
}

function getProfileBySlug(slug) {
  return parseProfileRow(getQuery('SELECT * FROM profiles WHERE slug = ?', [slug]));
}

function getActiveProfile() {
  const id = getSetting('active_profile_id');
  if (id) {
    const p = getProfile(parseInt(id));
    if (p) return p;
  }
  // Fallback to first profile if active_profile_id missing/stale
  const first = getQuery('SELECT id FROM profiles ORDER BY id ASC LIMIT 1');
  if (first) {
    setSetting('active_profile_id', String(first.id));
    return getProfile(first.id);
  }
  return null;
}

function setActiveProfile(id) {
  const p = getProfile(id);
  if (!p) throw new Error(`Profile ${id} not found`);
  setSetting('active_profile_id', String(id));
  return p;
}

function createProfile(profile) {
  const slug = uniqueSlug(profile.slug || profile.name);
  db.run(
    `INSERT INTO profiles (slug, name, email, phone, address, linkedin, resume_text,
       skill_groups, search_titles, target_titles, allowed_country_codes,
       notify_email, anthropic_key_override, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      slug,
      profile.name || 'Unnamed',
      profile.email || '',
      profile.phone || '',
      profile.address || '',
      profile.linkedin || '',
      profile.resume_text || '',
      JSON.stringify(profile.skill_groups || {}),
      JSON.stringify(profile.search_titles || []),
      JSON.stringify(profile.target_titles || profile.search_titles || []),
      JSON.stringify(profile.allowed_country_codes || ['de']),
      profile.notify_email || '',
      profile.anthropic_key_override || '',
      new Date().toISOString(),
    ]
  );
  save();
  const created = getProfileBySlug(slug);
  // Auto-activate if this is the only profile
  if (listProfiles().length === 1) setSetting('active_profile_id', String(created.id));
  // Seed the first row into profile_resumes so the Settings library shows
  // the freshly-uploaded resume immediately (without waiting for the boot-time
  // migration that only catches existing-but-unmigrated profiles).
  if (profile.resume_text && profile.resume_text.trim()) {
    try {
      const now = new Date().toISOString();
      db.run(
        `INSERT INTO profile_resumes (profile_id, label, resume_text, summary, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
        [created.id, 'Default', profile.resume_text, '', now, now]
      );
      save();
    } catch (e) { console.warn('[DB] seed profile_resumes failed:', e.message); }
  }
  return created;
}

function updateProfile(id, fields) {
  // Allow-listed columns. Extending this list is the supported way to expose
  // new profile fields to the UI / wizard.
  const allowed = [
    'name', 'email', 'phone', 'address', 'linkedin', 'resume_text',
    'skill_groups', 'search_titles', 'target_titles', 'allowed_country_codes',
    'notify_email',
    // Auth + key overrides
    'anthropic_key_override', 'apify_token_override', 'openai_key_override', 'resend_key_override',
    'linkedin_cookie_override',
    // German-specific personal data
    'dob', 'place_of_birth', 'nationality', 'marital_status',
    // Multi-step wizard outputs
    'languages_cefr', 'cv_field_visibility', 'cv_template', 'photo_path',
  ];
  const jsonCols = new Set(['skill_groups', 'search_titles', 'target_titles', 'allowed_country_codes', 'languages_cefr', 'cv_field_visibility']);
  const sets = []; const params = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k)) continue;
    if (jsonCols.has(k)) {
      sets.push(`${k} = ?`); params.push(JSON.stringify(v));
    } else {
      sets.push(`${k} = ?`); params.push(v == null ? null : String(v));
    }
  }
  if (!sets.length) return getProfile(id);
  params.push(id);
  db.run(`UPDATE profiles SET ${sets.join(', ')} WHERE id = ?`, params);
  // Keep profile_resumes default row in sync with the mirror. If the legacy
  // "replace default resume" path updates profiles.resume_text directly, we
  // need the default library row to reflect it (and vice-versa later when
  // setDefaultResume runs).
  if ('resume_text' in fields) {
    try {
      const def = getDefaultResume(id);
      const now = new Date().toISOString();
      if (def) {
        db.run('UPDATE profile_resumes SET resume_text = ?, updated_at = ? WHERE id = ?',
          [String(fields.resume_text || ''), now, def.id]);
      } else if (fields.resume_text && String(fields.resume_text).trim()) {
        // No library row yet — seed one as the new default.
        db.run(
          `INSERT INTO profile_resumes (profile_id, label, resume_text, summary, is_default, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?)`,
          [id, 'Default', String(fields.resume_text), '', now, now]
        );
      }
    } catch (e) { console.warn('[DB] keep profile_resumes in sync failed:', e.message); }
  }
  save();
  return getProfile(id);
}

function deleteProfile(id) {
  // Cascade: delete profile-scoped data
  db.run('DELETE FROM jobs WHERE profile_id = ?', [id]);
  db.run('DELETE FROM applications WHERE profile_id = ?', [id]);
  db.run('DELETE FROM scrape_log WHERE profile_id = ?', [id]);
  db.run('DELETE FROM notifications_sent WHERE profile_id = ?', [id]);
  db.run('DELETE FROM profiles WHERE id = ?', [id]);
  // If we deleted the active profile, fall back to the first remaining one
  if (getSetting('active_profile_id') === String(id)) {
    const next = getQuery('SELECT id FROM profiles ORDER BY id ASC LIMIT 1');
    if (next) setSetting('active_profile_id', String(next.id));
    else db.run(`DELETE FROM app_settings WHERE key = 'active_profile_id'`);
  }
  save();
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings (shared, key/value)
// ─────────────────────────────────────────────────────────────────────────────

function getSetting(key) {
  const row = getQuery('SELECT value FROM app_settings WHERE key = ?', [key]);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.run(`INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)`,
    [key, value == null ? '' : String(value)]);
  save();
}

function getAllSettings() {
  const rows = allQuery('SELECT key, value FROM app_settings');
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

// Resolve a key from DB first, then env, then default
function resolveSetting(key, envName, fallback = '') {
  return getSetting(key) || process.env[envName] || fallback;
}

// ─────────────────────────────────────────────────────────────────────────────
// Job helpers (profile-scoped)
// ─────────────────────────────────────────────────────────────────────────────

function sanitize(val, fallback = '') {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

function upsertJob(job, profileId) {
  if (!profileId) throw new Error('upsertJob requires profileId');
  const existing = getQuery('SELECT id FROM jobs WHERE id = ? AND profile_id = ?',
    [String(job.id), profileId]);
  if (existing) return false;
  db.run(
    `INSERT INTO jobs (id, profile_id, title, company, location, salary, description, apply_url, posted_at, applicants, scraped_at, source, match_score, matched_skills, is_new)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      sanitize(job.id),
      profileId,
      sanitize(job.title),
      sanitize(job.company),
      sanitize(job.location),
      sanitize(job.salary),
      sanitize(job.description),
      sanitize(job.apply_url),
      sanitize(job.posted_at),
      Number(job.applicants) || 0,
      sanitize(job.scraped_at),
      sanitize(job.source),
      Number(job.match_score) || 0,
      sanitize(job.matched_skills, '[]'),
    ]
  );
  save();
  return true;
}

function getJobs({ profileId, limit = 200, offset = 0, minScore = 0, source = null, search = null, sortBy = 'match_score', sortDir = 'DESC' } = {}) {
  if (!profileId) return [];
  const allowed = ['match_score', 'scraped_at', 'posted_at', 'title', 'company'];
  const col = allowed.includes(sortBy) ? sortBy : 'match_score';
  const dir = sortDir === 'ASC' ? 'ASC' : 'DESC';

  let where = 'WHERE profile_id = ? AND match_score >= ?';
  const params = [profileId, minScore];

  if (source) { where += ' AND source = ?'; params.push(source); }
  if (search) { where += ' AND (title LIKE ? OR company LIKE ? OR description LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }

  params.push(limit, offset);
  return allQuery(`SELECT * FROM jobs ${where} ORDER BY ${col} ${dir} LIMIT ? OFFSET ?`, params);
}

function getStats(profileId) {
  if (!profileId) return { total: 0, today: 0, avgScore: 0, topJob: null, bySource: [], lastScrape: null };
  const total    = (getQuery('SELECT COUNT(*) as count FROM jobs WHERE profile_id = ?', [profileId]) || {}).count || 0;
  const today    = (getQuery("SELECT COUNT(*) as count FROM jobs WHERE profile_id = ? AND date(scraped_at) = date('now')", [profileId]) || {}).count || 0;
  const avgScore = (getQuery('SELECT AVG(match_score) as avg FROM jobs WHERE profile_id = ?', [profileId]) || {}).avg || 0;
  const topJob   = getQuery('SELECT title, company, match_score FROM jobs WHERE profile_id = ? ORDER BY match_score DESC LIMIT 1', [profileId]);
  const bySource = allQuery('SELECT source, COUNT(*) as count FROM jobs WHERE profile_id = ? GROUP BY source', [profileId]);
  const lastScrape = getQuery('SELECT ran_at FROM scrape_log WHERE profile_id = ? ORDER BY id DESC LIMIT 1', [profileId]);
  return { total, today, avgScore: Math.round(avgScore), topJob, bySource, lastScrape: lastScrape?.ran_at };
}

function markNotificationSent(profileId, jobId) {
  db.run('INSERT OR IGNORE INTO notifications_sent (profile_id, job_id, sent_at) VALUES (?, ?, ?)',
    [profileId, jobId, new Date().toISOString()]);
  save();
}

function wasNotificationSent(profileId, jobId) {
  return !!getQuery('SELECT 1 FROM notifications_sent WHERE profile_id = ? AND job_id = ?',
    [profileId, jobId]);
}

function logScrape({ profileId, source, jobs_found, jobs_new, status = 'success', error = null }) {
  db.run('INSERT INTO scrape_log (profile_id, ran_at, source, jobs_found, jobs_new, status, error) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [profileId || null, new Date().toISOString(), source, jobs_found, jobs_new, status, error]);
  save();
}

function getTimeline(profileId) {
  if (!profileId) return [];
  return allQuery(`
    SELECT date(scraped_at) as day, COUNT(*) as count, AVG(match_score) as avg_score
    FROM jobs WHERE profile_id = ? GROUP BY day ORDER BY day DESC LIMIT 30
  `, [profileId]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Applications CRUD (profile-scoped)
// ─────────────────────────────────────────────────────────────────────────────

function createApplication({ profileId, job_id, company, role, location, job_url, job_description, folder_path, cv_path, cover_letter_path, match_score }) {
  if (!profileId) throw new Error('createApplication requires profileId');
  db.run(
    `INSERT INTO applications (profile_id, job_id, company, role, location, job_url, job_description, folder_path, cv_path, cover_letter_path, match_score, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [profileId, job_id, company, role, location, job_url, job_description, folder_path, cv_path, cover_letter_path, match_score || 0, new Date().toISOString()]
  );
  const stmt = db.prepare('SELECT last_insert_rowid() as id');
  let id = null;
  if (stmt.step()) { id = stmt.getAsObject().id; }
  stmt.free();
  save();
  return id;
}

function getApplications(profileId) {
  if (!profileId) return [];
  return allQuery('SELECT * FROM applications WHERE profile_id = ? ORDER BY created_at DESC', [profileId]);
}

function getApplicationById(id) {
  return getQuery('SELECT * FROM applications WHERE id = ?', [id]);
}

function updateApplication(id, fields) {
  const allowed = ['status', 'notes', 'applied', 'applied_at', 'cv_path', 'cover_letter_path', 'folder_path'];
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) { sets.push(`${k} = ?`); params.push(v); }
  }
  if (!sets.length) return;
  params.push(id);
  db.run(`UPDATE applications SET ${sets.join(', ')} WHERE id = ?`, params);
  save();
}

function markAsApplied(id) {
  db.run('UPDATE applications SET applied = 1, applied_at = ?, status = ? WHERE id = ?',
    [new Date().toISOString(), 'applied', id]);
  save();
}

function getJobById(id, profileId) {
  if (profileId) return getQuery('SELECT * FROM jobs WHERE id = ? AND profile_id = ?', [id, profileId]);
  return getQuery('SELECT * FROM jobs WHERE id = ?', [id]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-resume CRUD (profile-scoped)
//
// Design notes:
// - profiles.resume_text is kept in sync with whichever profile_resumes row
//   has is_default=1. Existing matcher / brain code reads profile.resume_text
//   directly — keeping the mirror saves us a wide refactor.
// - "Default" resume is what gets used if the user generates a CV without
//   triggering the auto-picker (or only has one resume to begin with).
// - Deleting the default resume promotes the most-recently-updated other
//   row to default. If there's only one resume, it can't be deleted.
// ─────────────────────────────────────────────────────────────────────────────

function listResumes(profileId) {
  if (!profileId) return [];
  return allQuery(
    `SELECT id, profile_id, label, summary, is_default, created_at, updated_at,
            length(resume_text) AS resume_text_len
     FROM profile_resumes
     WHERE profile_id = ?
     ORDER BY is_default DESC, updated_at DESC`,
    [profileId]
  );
}

function getResumeById(id, profileId) {
  if (!id || !profileId) return null;
  return getQuery(
    'SELECT * FROM profile_resumes WHERE id = ? AND profile_id = ?',
    [id, profileId]
  );
}

function getDefaultResume(profileId) {
  if (!profileId) return null;
  return getQuery(
    `SELECT * FROM profile_resumes
     WHERE profile_id = ? AND is_default = 1
     ORDER BY updated_at DESC LIMIT 1`,
    [profileId]
  );
}

function _syncProfileResumeMirror(profileId) {
  // Mirror the current default resume's text onto profiles.resume_text so
  // legacy readers (matcher.js, brain.js) keep working without retrofitting.
  const def = getDefaultResume(profileId);
  if (!def) return;
  db.run('UPDATE profiles SET resume_text = ? WHERE id = ?', [def.resume_text, profileId]);
}

function addResume(profileId, { label, resume_text, summary, makeDefault = false } = {}) {
  if (!profileId) throw new Error('addResume requires profileId');
  if (!resume_text || !resume_text.trim()) throw new Error('resume_text is required');
  const now = new Date().toISOString();
  const cleanLabel = String(label || '').trim() || 'Untitled';
  // First resume on a profile is automatically the default, regardless of flag.
  const existingCount = (getQuery('SELECT COUNT(*) AS c FROM profile_resumes WHERE profile_id = ?', [profileId]) || {}).c || 0;
  const willBeDefault = (existingCount === 0) || makeDefault;
  if (willBeDefault) {
    db.run('UPDATE profile_resumes SET is_default = 0 WHERE profile_id = ?', [profileId]);
  }
  db.run(
    `INSERT INTO profile_resumes (profile_id, label, resume_text, summary, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [profileId, cleanLabel, resume_text, summary || '', willBeDefault ? 1 : 0, now, now]
  );
  let id = null;
  const stmt = db.prepare('SELECT last_insert_rowid() AS id');
  if (stmt.step()) id = stmt.getAsObject().id;
  stmt.free();
  if (willBeDefault) _syncProfileResumeMirror(profileId);
  save();
  return getResumeById(id, profileId);
}

function updateResume(id, profileId, fields = {}) {
  if (!id || !profileId) throw new Error('updateResume requires id + profileId');
  const allowed = ['label', 'resume_text', 'summary'];
  const sets = []; const params = [];
  for (const [k, v] of Object.entries(fields)) {
    if (!allowed.includes(k)) continue;
    sets.push(`${k} = ?`); params.push(v == null ? null : String(v));
  }
  if (!sets.length) return getResumeById(id, profileId);
  sets.push('updated_at = ?'); params.push(new Date().toISOString());
  params.push(id, profileId);
  db.run(`UPDATE profile_resumes SET ${sets.join(', ')} WHERE id = ? AND profile_id = ?`, params);
  // If the default's text changed, refresh the mirror.
  const row = getResumeById(id, profileId);
  if (row?.is_default) _syncProfileResumeMirror(profileId);
  save();
  return row;
}

function setDefaultResume(id, profileId) {
  if (!id || !profileId) throw new Error('setDefaultResume requires id + profileId');
  const row = getResumeById(id, profileId);
  if (!row) throw new Error('Resume not found');
  db.run('UPDATE profile_resumes SET is_default = 0 WHERE profile_id = ?', [profileId]);
  db.run('UPDATE profile_resumes SET is_default = 1, updated_at = ? WHERE id = ?',
    [new Date().toISOString(), id]);
  _syncProfileResumeMirror(profileId);
  save();
  return getResumeById(id, profileId);
}

function deleteResume(id, profileId) {
  if (!id || !profileId) throw new Error('deleteResume requires id + profileId');
  const row = getResumeById(id, profileId);
  if (!row) return false;
  const remaining = (getQuery('SELECT COUNT(*) AS c FROM profile_resumes WHERE profile_id = ?', [profileId]) || {}).c || 0;
  if (remaining <= 1) throw new Error('Cannot delete the only remaining resume');
  db.run('DELETE FROM profile_resumes WHERE id = ? AND profile_id = ?', [id, profileId]);
  if (row.is_default) {
    // Promote the most-recently-updated remaining resume to default.
    const next = getQuery(
      `SELECT id FROM profile_resumes WHERE profile_id = ? ORDER BY updated_at DESC LIMIT 1`,
      [profileId]
    );
    if (next) {
      db.run('UPDATE profile_resumes SET is_default = 1 WHERE id = ?', [next.id]);
      _syncProfileResumeMirror(profileId);
    }
  }
  save();
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Raw exec helpers used by brain_db.js. These run arbitrary SQL against the
// shared sql.js database and persist via save(). Kept here so all writes
// funnel through one save() path and the DB stays internally consistent.
// ─────────────────────────────────────────────────────────────────────────────
function brainExec(sql, params = []) {
  db.run(sql, params || []);
  save();
}

// Insert + return the new rowid in one atomic step. Doing the SELECT
// last_insert_rowid() *before* save() matters: sql.js's rowid context can
// reset after export/save in some sequences, leading to null returns.
function brainExecReturningId(sql, params = []) {
  db.run(sql, params || []);
  let id = null;
  const stmt = db.prepare('SELECT last_insert_rowid() as id');
  if (stmt.step()) id = stmt.getAsObject().id;
  stmt.free();
  save();
  return id;
}

function brainAll(sql, params = []) { return allQuery(sql, params || []); }
function brainOne(sql, params = []) { return getQuery(sql, params || []); }

module.exports = {
  getDb, save,
  // profiles
  listProfiles, getProfile, getProfileBySlug, getActiveProfile, setActiveProfile,
  createProfile, updateProfile, deleteProfile, slugify, uniqueSlug,
  // settings
  getSetting, setSetting, getAllSettings, resolveSetting,
  // jobs
  upsertJob, getJobs, getStats, markNotificationSent, wasNotificationSent, logScrape, getTimeline,
  // applications
  createApplication, getApplications, getApplicationById, updateApplication, markAsApplied, getJobById,
  // resumes (per profile)
  listResumes, getResumeById, getDefaultResume, addResume, updateResume, setDefaultResume, deleteResume,
  // brain raw access (used by brain_db.js)
  brainExec, brainExecReturningId, brainAll, brainOne,
};
